/**
 * The real-HOME guard for the whole test run (vitest globalSetup).
 *
 * 1. Before any worker starts, the run gets a private HOME and no inherited
 *    BORG_* variables; workers and every child they spawn with the inherited
 *    environment resolve Borg state there, never under the real home.
 * 2. The control: the operator's real <home>/.config/borgmcp is scanned for
 *    test-only markers (the fixture cube and drone ids, the mock server trust,
 *    this run's private HOME) before and after the run. Any new occurrence
 *    means a test wrote real Borg state, and the run fails.
 * The real home comes from the account database (os.userInfo), not $HOME.
 */
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

/** Markers only test fixtures ever write. */
export const TEST_MARKERS = [
  '11111111-1111-4111-8111-111111111111', // fixture cube id
  '22222222-2222-4222-8222-222222222222', // fixture representative drone id
  'sha256:mock-server',
  'mock-cube',
  'borg-test-run-home-',
];

const FILE_CAP_BYTES = 16 * 1024 * 1024;

/** Occurrences of each marker under `directory` (lstat walk, never follows links). */
export function scanForMarkers(directory: string, markers = TEST_MARKERS): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(markers.map((marker) => [marker, 0]));
  const needles = markers.map((marker) => [marker, Buffer.from(marker)] as const);
  const walk = (path: string) => {
    let metadata;
    try { metadata = lstatSync(path); } catch { return; }
    if (metadata.isDirectory()) {
      let names: string[] = [];
      try { names = readdirSync(path); } catch { return; }
      for (const name of names) {
        for (const [marker] of needles) if (name.includes(marker)) counts[marker] += 1;
        walk(join(path, name));
      }
      return;
    }
    if (!metadata.isFile() || metadata.size > FILE_CAP_BYTES) return;
    let data: Buffer;
    try { data = readFileSync(path); } catch { return; }
    for (const [marker, needle] of needles) {
      for (let at = data.indexOf(needle); at >= 0; at = data.indexOf(needle, at + 1)) counts[marker] += 1;
    }
  };
  walk(directory);
  return counts;
}

export function realBorgConfig(): string {
  return join(userInfo().homedir, '.config', 'borgmcp');
}

export default function setup(): () => void {
  const realConfig = realBorgConfig();
  const before = scanForMarkers(realConfig);
  for (const key of Object.keys(process.env)) if (key.startsWith('BORG_')) delete process.env[key];
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-test-run-home-')));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  return () => {
    rmSync(home, { recursive: true, force: true });
    const after = scanForMarkers(realConfig);
    const grew = Object.keys(after).filter((marker) => after[marker] > before[marker]);
    if (grew.length > 0) {
      throw new Error(`A test wrote the real Borg config ${realConfig}: new test markers ${grew.map((marker) =>
        `${marker} (${before[marker]} -> ${after[marker]})`).join(', ')}. Every test must use an explicit temporary root.`);
    }
  };
}
