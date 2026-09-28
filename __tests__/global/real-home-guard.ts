/**
 * The real-HOME guard for the whole test run (vitest globalSetup).
 *
 * 1. Prevention (the primary defence): the real home is recorded in
 *    BORGMCP_TEST_FORBIDDEN_HOME and the run's own roots (TMPDIR and a
 *    private HOME) in BORGMCP_TEST_ALLOWED_ROOTS; the run gets that private
 *    HOME and no inherited BORG_* variables. Every filesystem mutation in src
 *    goes through src/guarded-fs.ts, which throws TestIsolationError before any
 *    I/O when the canonical target is in the real home (descendants included,
 *    symlinks followed) outside the run's roots; borgHomeRoot applies the same
 *    rule to the Borg home root. Workers and children inherit the variables,
 *    so no src code path writes the real home during a test, whatever path it
 *    is given, live-writer paths included.
 * 2. Detection (a second line): every entry under the operator's real
 *    <home>/.config/borgmcp (path, type, size, mtime, inode) is snapshotted
 *    before the run and compared after it; any created, deleted or modified
 *    entry fails the run, whatever it contains, as does an unreadable tree or
 *    a new test marker anywhere. LIVE_WRITERS are skipped by the comparison
 *    only because running Borg processes rewrite them continuously; tests are
 *    kept out of them by (1), not by this comparison.
 * The real home comes from the account database (os.userInfo), not $HOME.
 * BORG_TEST_GUARD_PROTECTED_CONFIG replaces the protected directory; it exists
 * only so the guard's own control can prove a violation fails a real run
 * without touching the operator's configuration.
 */
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import { TEST_ALLOWED_ROOTS_ENV, TEST_FORBIDDEN_HOME_ENV } from '../../src/guarded-fs.js';

const within = (path: string, root: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
};

/** Markers only test fixtures ever write. */
export const TEST_MARKERS = [
  '11111111-1111-4111-8111-111111111111', // fixture cube id
  '22222222-2222-4222-8222-222222222222', // fixture representative drone id
  'sha256:mock-server',
  'mock-cube',
  'borg-test-run-home-',
];

/**
 * Entries live Borg processes (drones, MCP servers, listeners of the running
 * cube) rewrite on their own schedule, relative to the protected directory.
 * Test code resolves none of them: every test runs under a private HOME.
 */
export const LIVE_WRITERS: RegExp[] = [
  /^stream-locks(\/.*)?$/, // stream lease heartbeats
  /^locks(\/.*)?$/,
  /^representative-host-locks(\/.*)?$/, // the running 5.x representative's lease
  /^inboxes(\/.*)?$/, // inbox tails of the running drones
  // Rewritten atomically: the file and its transient `<file>.<pid>.<hex>.tmp`.
  /^(local-server-cursors|lifecycle-log-state|launch|codex-wake-targets)\.json(\.\d+\.[0-9a-f]+\.tmp)?$/,
  /^opencode-drone-[0-9a-z-]+\.log$/,
];

export interface EntrySnapshot { type: 'file' | 'dir' | 'link' | 'other'; size: number; mtimeMs: number; ino: number }
export type TreeSnapshot = Map<string, EntrySnapshot>;

/** Every entry under `directory` (lstat walk, never follows links). An absent directory is empty; a read failure throws. */
export function snapshotTree(directory: string): TreeSnapshot {
  const entries: TreeSnapshot = new Map();
  const walk = (path: string) => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path === directory) return;
      throw error;
    }
    const type = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'dir' : metadata.isSymbolicLink() ? 'link' : 'other';
    entries.set(relative(directory, path) || '.', { type, size: metadata.size, mtimeMs: metadata.mtimeMs, ino: metadata.ino });
    if (type === 'dir') for (const name of readdirSync(path)) walk(join(path, name));
  };
  walk(directory);
  return entries;
}

const isLive = (path: string, live: RegExp[]) => live.some((pattern) => pattern.test(path.split(sep).join('/')));

/** Entries created, deleted or changed between two snapshots, except live-writer paths. */
export function treeChanges(before: TreeSnapshot, after: TreeSnapshot, live: RegExp[] = LIVE_WRITERS): string[] {
  const changes: string[] = [];
  for (const [path, entry] of after) {
    if (isLive(path, live)) continue;
    const prior = before.get(path);
    if (!prior) changes.push(`created ${path}`);
    else if (prior.type !== entry.type || prior.size !== entry.size || prior.mtimeMs !== entry.mtimeMs || prior.ino !== entry.ino) {
      changes.push(`modified ${path}`);
    }
  }
  for (const path of before.keys()) if (!after.has(path) && !isLive(path, live)) changes.push(`deleted ${path}`);
  // The protected directory's own entry changes when a live writer creates a
  // top-level file; its children are compared individually above.
  return changes.filter((change) => change !== 'modified .');
}

/** Occurrences of each marker in names and file contents under `directory` (never follows links). */
export function scanForMarkers(directory: string, markers = TEST_MARKERS): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(markers.map((marker) => [marker, 0]));
  const needles = markers.map((marker) => [marker, Buffer.from(marker)] as const);
  for (const [path, entry] of snapshotTree(directory)) {
    for (const [marker] of needles) if (path.includes(marker)) counts[marker] += 1;
    if (entry.type !== 'file') continue;
    const data = readFileSync(join(directory, path));
    for (const [marker, needle] of needles) {
      for (let at = data.indexOf(needle); at >= 0; at = data.indexOf(needle, at + 1)) counts[marker] += 1;
    }
  }
  return counts;
}

export function realBorgConfig(): string {
  return join(userInfo().homedir, '.config', 'borgmcp');
}

export default function setup(): () => void {
  const protectedConfig = process.env.BORG_TEST_GUARD_PROTECTED_CONFIG ?? realBorgConfig();
  const before = snapshotTree(protectedConfig);
  const markers = scanForMarkers(protectedConfig);
  for (const key of Object.keys(process.env)) if (key.startsWith('BORG_')) delete process.env[key];
  const realHome = realpathSync(userInfo().homedir);
  const temporary = realpathSync(tmpdir());
  // The run's own roots may lie inside the real home only in the cube's scratch area.
  if (within(temporary, realHome) && !within(temporary, join(realHome, '.borg', 'scratch'))) {
    throw new Error(`TMPDIR ${temporary} is inside the real home ${realHome}: set it outside the home or under ` +
      `${join(realHome, '.borg', 'scratch')} before running the tests.`);
  }
  process.env[TEST_FORBIDDEN_HOME_ENV] = realHome;
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-test-run-home-')));
  process.env[TEST_ALLOWED_ROOTS_ENV] = [temporary, home].join(delimiter);
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  return () => {
    rmSync(home, { recursive: true, force: true });
    const changes = treeChanges(before, snapshotTree(protectedConfig));
    const after = scanForMarkers(protectedConfig);
    const grew = Object.keys(after).filter((marker) => after[marker] > markers[marker]);
    if (changes.length > 0 || grew.length > 0) {
      throw new Error(`A test wrote the real Borg config ${protectedConfig}: ` +
        [...changes, ...grew.map((marker) => `new test marker ${marker} (${markers[marker]} -> ${after[marker]})`)].join(', ') +
        '. Every test must use an explicit temporary root.');
    }
  };
}
