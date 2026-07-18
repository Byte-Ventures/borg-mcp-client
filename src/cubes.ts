/**
 * Per-project active-cube persistence for Borg MCP client
 *
 * Stores the currently-assimilated cube identity + authority metadata PER
 * PROJECT in ~/.config/borgmcp/cubes.json. The "project"
 * is identified by walking up from cwd to find a .git directory; if none is
 * found, cwd itself is used as the project key.
 *
 * Local-server session tokens never enter this file: only an opaque keychain
 * reference is stored and hydrated at read time. An entry without verified
 * local-server trust can no longer be hydrated (no cloud plaintext tokens).
 *
 * apiUrl is captured at assimilate time so subprocess invocations (e.g. the
 * SessionStart hook firing borg-regen) don't need BORG_API_URL in their env
 * to know which worker to talk to.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pruneDeadWakeTargets } from './codex-wake-resolve.js';
import {
  clearServerSessionCredential,
  compareAndClearServerSessionCredential,
  getActiveServerSessionCredential,
} from './config.js';

const CUBES_DIR = join(homedir(), '.config', 'borgmcp');
const CUBES_FILE = join(CUBES_DIR, 'cubes.json');
const LAUNCH_FILE = join(CUBES_DIR, 'launch.json');
const CODEX_WAKE_TARGETS_FILE = join(CUBES_DIR, 'codex-wake-targets.json');
const INBOX_DIR = join(CUBES_DIR, 'inboxes');
const CUBES_WRITE_LOCK = `${CUBES_FILE}.lock`;
const CUBES_LOCK_STALE_MS = 30_000;

async function withCubesWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(CUBES_WRITE_LOCK), { recursive: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let handle;
    try {
      handle = await open(CUBES_WRITE_LOCK, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const metadata = await stat(CUBES_WRITE_LOCK);
        if (Date.now() - metadata.mtimeMs > CUBES_LOCK_STALE_MS) {
          await unlink(CUBES_WRITE_LOCK);
          continue;
        }
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw inspectionError;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      continue;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      try {
        await unlink(CUBES_WRITE_LOCK);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  throw new Error('Borg cube state is busy');
}

export type BorgCli = 'claude' | 'codex' | 'opencode';

export interface ActiveCube {
  cubeId: string;
  droneId: string;
  name: string;
  sessionToken: string;
  droneLabel: string;
  apiUrl: string;
  /** Verified local-server CA identity; absent until a local server is selected. */
  serverTrustIdentity?: string;
  /** Opaque local-session keychain reference; never a bearer. */
  localSessionCredentialRef?: string;
  localSessionExpiresAt?: string | null;
  // gh#899: the assimilated role, persisted so the connect-time ListTools
  // handler can role-scope the NATIVE tool surface (UX/context only — never an
  // auth boundary). Absent on pre-gh#899 cubes.json entries → the filter
  // defaults to the FULL set (no capability hidden). Stale after a mid-session
  // reassign until the next relaunch; the dispatcher covers capability meantime.
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
}

export type ActiveCubeInput = Omit<ActiveCube, 'sessionToken'> & {
  sessionToken?: string;
};

type PersistedActiveCube = ActiveCubeInput;

interface CubesFile {
  projects: Record<string, PersistedActiveCube>;
}

interface LaunchFile {
  projects: Record<string, { cli: BorgCli }>;
}

export interface CodexWakeTargetRecord {
  threadId: string;
  socketPath: string;
  updatedAt: string;
}

interface CodexWakeTargetsFile {
  targets: Record<string, CodexWakeTargetRecord>;
}

/**
 * Walk up from cwd looking for a .git directory. If found, return that
 * directory. If not found by filesystem root, return the original cwd.
 * The returned absolute path is the "project key" used to scope cube state.
 */
export function findProjectRoot(cwd: string = process.cwd()): string {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd); // hit root, fall back to cwd
    dir = parent;
  }
}

/**
 * Per-(cube, drone) inbox file path. Each drone gets its own file so that
 * multiple drones in the same cube don't trample each other's writes when
 * they each receive the same long-poll batch. The file lives under a
 * per-cube subdir keyed by cube ID, then by drone ID (a UUID, globally
 * unique).
 *
 * Validates cubeId/droneId as UUIDs before using them in a filesystem
 * path. The values come from cubes.json (populated from server response),
 * so the input is trusted in normal operation — but a regex guard is
 * cheap defense against a corrupted file or future bug that would
 * otherwise let `../` slip through into the inbox path.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function inboxPathForDrone(cubeId: string, droneId: string): string {
  if (!UUID_RE.test(cubeId)) throw new Error(`Invalid cubeId: ${cubeId}`);
  if (!UUID_RE.test(droneId)) throw new Error(`Invalid droneId: ${droneId}`);
  return join(INBOX_DIR, cubeId, `${droneId}.log`);
}

/**
 * Type guard: true iff the parsed JSON looks like the new schema. Anything
 * else (old single-cube schema, malformed, missing) is treated as "no state".
 */
function isCubesFile(data: any): data is CubesFile {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.projects === 'object' &&
    data.projects !== null &&
    !Array.isArray(data.projects)
  );
}

/**
 * Read the cubes.json file. Returns null if the file does not exist, is
 * unparseable, or is in the old single-cube schema (per the project's no-
 * backward-compat stance, the old shape is treated as absent — it will be
 * overwritten the next time setActiveCube() runs).
 */
async function readCubesFile(): Promise<CubesFile | null> {
  let raw: string;
  try {
    raw = await readFile(CUBES_FILE, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isCubesFile(parsed)) return null;
  return parsed;
}

/**
 * Write the cubes.json file, ensuring the parent directory exists.
 */
async function writeCubesFile(data: CubesFile): Promise<void> {
  await atomicWriteFile(CUBES_FILE, JSON.stringify(data, null, 2) + '\n');
}

// gh#894: crash-safe write. A plain truncate-write (open-for-write then write)
// leaves a truncated/empty prefs file if the process dies mid-write — losing
// every stored cube preference. Instead write to a same-directory temp file
// and rename() it over the target: rename is atomic on POSIX, so a reader
// always sees either the old complete file or the new complete file, never a
// partial one. On any failure the original is untouched (we never opened it for
// write) and the temp is best-effort cleaned. `io` is injectable for tests.
let atomicTmpCounter = 0;
export async function atomicWriteFile(
  filePath: string,
  data: string,
  opts: {
    mode?: number;
    io?: {
      writeFile: typeof writeFile;
      rename: typeof rename;
      unlink: typeof unlink;
    };
  } = {}
): Promise<void> {
  const io = opts.io ?? { writeFile, rename, unlink };
  const mode = opts.mode ?? 0o600;
  await mkdir(dirname(filePath), { recursive: true });
  // Same-dir temp so rename() stays on one filesystem (atomicity requirement).
  // pid + counter keeps concurrent same-process writes from colliding.
  const tmp = `${filePath}.${process.pid}.${atomicTmpCounter++}.tmp`;
  try {
    await io.writeFile(tmp, data, { mode });
    await io.rename(tmp, filePath);
  } catch (err) {
    try {
      await io.unlink(tmp);
    } catch {
      /* best-effort temp cleanup; never mask the original error */
    }
    throw err;
  }
}

function isLaunchFile(data: any): data is LaunchFile {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.projects === 'object' &&
    data.projects !== null &&
    !Array.isArray(data.projects)
  );
}

async function readLaunchFile(): Promise<LaunchFile | null> {
  let raw: string;
  try {
    raw = await readFile(LAUNCH_FILE, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return isLaunchFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeLaunchFile(data: LaunchFile): Promise<void> {
  // atomicWriteFile handles the mkdir + 0o600 mode, and the temp+rename keeps
  // a concurrent reader from seeing a half-written launch file (gh#894, gh#901).
  await atomicWriteFile(LAUNCH_FILE, JSON.stringify(data, null, 2) + '\n');
}

function codexWakeTargetKey(cubeId: string, droneId: string): string {
  if (!UUID_RE.test(cubeId)) throw new Error(`Invalid cubeId: ${cubeId}`);
  if (!UUID_RE.test(droneId)) throw new Error(`Invalid droneId: ${droneId}`);
  return `${cubeId}:${droneId}`;
}

function isCodexWakeTargetsFile(data: any): data is CodexWakeTargetsFile {
  return (
    data !== null &&
    typeof data === 'object' &&
    typeof data.targets === 'object' &&
    data.targets !== null &&
    !Array.isArray(data.targets)
  );
}

async function readCodexWakeTargetsFile(): Promise<CodexWakeTargetsFile | null> {
  let raw: string;
  try {
    raw = await readFile(CODEX_WAKE_TARGETS_FILE, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw);
    return isCodexWakeTargetsFile(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCodexWakeTargetsFile(data: CodexWakeTargetsFile): Promise<void> {
  // atomicWriteFile handles the mkdir + 0o600 mode, and the temp+rename keeps
  // a concurrent reader from seeing a half-written file (gh#894, gh#901).
  await atomicWriteFile(CODEX_WAKE_TARGETS_FILE, JSON.stringify(data, null, 2) + '\n');
}

/**
 * Get the currently-active cube for the current project, or null if not
 * assimilated in this project. Entries written by older client versions
 * that lack the `cubeId` field are treated as absent — re-assimilate to
 * refresh.
 */
export async function getActiveCube(): Promise<ActiveCube | null> {
  const data = await readCubesFile();
  if (!data) return null;
  const key = findProjectRoot();
  const entry = data.projects[key];
  if (!entry || typeof entry.cubeId !== 'string' || !entry.cubeId) return null;
  if (typeof entry.droneId !== 'string' || !entry.droneId) return null;
  return hydrateActiveCube(entry);
}

/**
 * Distinguish a genuinely new worktree from one whose persisted local seat can
 * no longer be hydrated (for example, because its keychain item is missing).
 * No authority-bearing fields are returned through this diagnostic seam.
 */
export async function hasPersistedActiveCube(): Promise<boolean> {
  const data = await readCubesFile();
  if (!data) return false;
  return Object.prototype.hasOwnProperty.call(data.projects, findProjectRoot());
}

async function hydrateActiveCube(entry: PersistedActiveCube): Promise<ActiveCube | null> {
  if (entry.serverTrustIdentity !== undefined) {
    if (typeof entry.localSessionCredentialRef !== 'string') {
      return null;
    }
    // The credential reference re-derives the exact per-seat account (role +
    // operation come from the stored session record), so no drone id or
    // generation is needed to resolve the stable idempotent bearer.
    const sessionToken = await getActiveServerSessionCredential(
      entry.localSessionCredentialRef,
      {
        origin: entry.apiUrl,
        trustIdentity: entry.serverTrustIdentity,
        cubeId: entry.cubeId,
      },
    );
    if (!sessionToken) return null;
    return { ...entry, sessionToken };
  }
  // No cloud plaintext session tokens: an entry lacking verified local-server
  // trust can no longer be hydrated.
  return null;
}

let activeCubeWriteQueue: Promise<void> = Promise.resolve();

/**
 * Set the active cube for the current project. Preserves entries for all
 * other projects.
 */
export async function setActiveCube(active: ActiveCubeInput): Promise<void> {
  const operation = activeCubeWriteQueue.then(() => withCubesWriteLock(async () => {
    const existing = (await readCubesFile()) ?? { projects: {} };
    const projectKey = findProjectRoot();
    const prior = existing.projects[projectKey];

    if (active.serverTrustIdentity !== undefined) {
      if (typeof active.localSessionCredentialRef !== 'string') {
        throw new Error('local Borg server session metadata is incomplete');
      }
      // No generation: the idempotent bearer is stable per seat, so there is no
      // rotation race to arbitrate — persist the current reference directly.
      const { sessionToken: _discardLocalBearer, ...persisted } = active;
      existing.projects[projectKey] = persisted;
      try {
        await writeCubesFile(existing);
      } catch (error) {
        try {
          await clearServerSessionCredential(active.localSessionCredentialRef);
        } catch {
          // Preserve the metadata-write error; a future attach rotation can
          // overwrite an orphaned, unreferenced keychain generation.
        }
        throw error;
      }
      if (
        prior?.localSessionCredentialRef &&
        prior.localSessionCredentialRef !== active.localSessionCredentialRef
      ) {
        await clearServerSessionCredential(prior.localSessionCredentialRef);
      }
      return;
    }

    // No cloud plaintext session persistence: an active cube must carry
    // verified local-server trust metadata.
    throw new Error('local Borg server session metadata is incomplete');
  }));
  activeCubeWriteQueue = operation.catch(() => {});
  await operation;
}

export function activeCubeWithFreshRegenIdentity(
  active: ActiveCube,
  result: { cube?: { name?: string | null }; drone?: { label?: string | null } }
): ActiveCube {
  const name = result.cube?.name ?? active.name;
  const droneLabel = result.drone?.label ?? active.droneLabel;
  if (name === active.name && droneLabel === active.droneLabel) return active;
  return { ...active, name, droneLabel };
}

/**
 * Clear the active cube for the current project. If the projects map
 * becomes empty as a result, remove the file entirely rather than leave
 * an empty {projects:{}} skeleton.
 */
export async function clearActiveCube(
  expected?: { credentialRef?: string | null; sessionDigest?: string },
): Promise<{ removed: boolean; credentialRef: string | null }> {
  const operation = activeCubeWriteQueue.then(() => withCubesWriteLock(async () => {
    const existing = await readCubesFile();
    // No binding to clear → report an honest no-op so callers never audit a
    // reset that did not happen (SR: no copy-without-operation).
    if (!existing) return { removed: false, credentialRef: null };
    const key = findProjectRoot();
    if (!(key in existing.projects)) return { removed: false, credentialRef: null };
    const entry = existing.projects[key];
    const removedCredentialRef = entry.localSessionCredentialRef ?? null;
    // If the caller pins the credential ref it observed rejected, a ref mismatch
    // is an honest no-op (the seat this worktree points at is not the one that
    // was rejected).
    if (
      expected?.credentialRef !== undefined &&
      removedCredentialRef !== expected.credentialRef
    ) {
      return { removed: false, credentialRef: null };
    }

    const removeBinding = async () => {
      delete existing.projects[key];
      if (Object.keys(existing.projects).length === 0) {
        try {
          await unlink(CUBES_FILE);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        await writeCubesFile(existing);
      }
    };

    if (expected?.sessionDigest !== undefined) {
      // TRANSACTIONAL same-ref guard (SR-six 689e2654 / PD / PS): the credential
      // ref is deterministic per seat, so a concurrent reset+re-enroll writes a
      // FRESH valid bearer under the SAME ref. compareAndClearServerSessionCredential
      // reads → digest-compares → deletes atomically UNDER the per-account
      // keychain lock (writers take the same lock), so no replacement can land
      // between the comparison and the delete. Keychain-FIRST ordering: only
      // after the exact rejected credential is deleted do we remove the cube
      // binding — a mismatch is a no-op (nothing mutated), and a keychain
      // get/delete error PROPAGATES with neither the credential nor the binding
      // touched (coherent pre-reset state; the caller audits "could not
      // complete", never a false success or a half-cleared binding).
      if (!removedCredentialRef) return { removed: false, credentialRef: null };
      const deleted = await compareAndClearServerSessionCredential(
        removedCredentialRef,
        {
          origin: entry.apiUrl,
          trustIdentity: entry.serverTrustIdentity ?? '',
          cubeId: entry.cubeId,
        },
        expected.sessionDigest,
      );
      if (!deleted) return { removed: false, credentialRef: null };
      await removeBinding();
      return { removed: true, credentialRef: removedCredentialRef };
    }

    // Unpinned path (non-reset callers): remove the binding, then clear the
    // credential. A throw here propagates (no false success).
    await removeBinding();
    if (removedCredentialRef) await clearServerSessionCredential(removedCredentialRef);
    return { removed: true, credentialRef: removedCredentialRef };
  }));
  activeCubeWriteQueue = operation.then(() => undefined, () => undefined);
  return await operation;
}

/**
 * Typed token-safe observation of this worktree's saved local seat credential.
 * The raw bearer is never surfaced past this module — PRESENT carries only its
 * sha256 digest so the caller (the offline `borg reset-local-seat` command) can
 * pin the exact credential it observed without ever handling the secret.
 */
export type LocalSeatObservation =
  | { kind: 'present'; sessionDigest: string }
  | { kind: 'absent' };

export interface LocalSeatSnapshot {
  apiUrl: string;
  serverTrustIdentity: string;
  cubeId: string;
  credentialRef: string;
  worktree: string;
  observation: LocalSeatObservation;
}

export type ResetLocalSeatOutcome =
  | { outcome: 'reset'; credentialRef: string }
  | { outcome: 'no-binding' }
  | { outcome: 'changed' };

/**
 * S0 of the ratified client-seat-reset-state-model: snapshot this worktree's
 * exact local-seat binding plus a token-safe observation of its keychain
 * credential (PRESENT+digest | ABSENT). Read-only — no lock is held past the
 * read, and the authoritative re-check happens under the cube lock in
 * resetLocalSeatBinding. Returns null when this worktree has no LOCAL-server
 * seat to reset (no binding, or a non-local/legacy binding): an honest no-op.
 */
export async function snapshotLocalSeat(): Promise<LocalSeatSnapshot | null> {
  const data = await readCubesFile();
  if (!data) return null;
  const worktree = findProjectRoot();
  const entry = data.projects[worktree];
  if (!entry) return null;
  if (
    entry.serverTrustIdentity === undefined ||
    typeof entry.localSessionCredentialRef !== 'string' ||
    typeof entry.cubeId !== 'string' ||
    !entry.cubeId
  ) {
    // Not a hydratable local-server seat (cloud/legacy or incomplete) — nothing
    // this command is authorized to reset.
    return null;
  }
  const binding = {
    origin: entry.apiUrl,
    trustIdentity: entry.serverTrustIdentity,
    cubeId: entry.cubeId,
  };
  const bearer = await getActiveServerSessionCredential(
    entry.localSessionCredentialRef,
    binding,
  );
  const observation: LocalSeatObservation = bearer
    ? { kind: 'present', sessionDigest: createHash('sha256').update(bearer).digest('hex') }
    : { kind: 'absent' };
  return {
    apiUrl: entry.apiUrl,
    serverTrustIdentity: entry.serverTrustIdentity,
    cubeId: entry.cubeId,
    credentialRef: entry.localSessionCredentialRef,
    worktree,
    observation,
  };
}

/**
 * S2/S3 of the ratified client-seat-reset-state-model. Re-acquires the cube
 * write lock (OUTER; the keychain lock is only ever taken INNER via
 * compareAndClearServerSessionCredential — never a keychain→cube inversion),
 * re-observes the typed union, and commits only when the current binding STILL
 * matches the exact snapshot. Any change / missing / same-ref replacement is an
 * honest no-op ('changed'). Ordering is CREDENTIAL-FIRST: the keychain bearer is
 * deleted before the cube binding is removed, so the only surviving intermediate
 * state is binding-present/credential-absent — safe, rerunnable, and truthful.
 */
export async function resetLocalSeatBinding(
  expected: LocalSeatSnapshot,
): Promise<ResetLocalSeatOutcome> {
  const operation = activeCubeWriteQueue.then(() => withCubesWriteLock(async () => {
    const existing = await readCubesFile();
    if (!existing) return { outcome: 'no-binding' as const };
    const key = findProjectRoot();
    const entry = existing.projects[key];
    if (!entry) return { outcome: 'no-binding' as const };
    // The exact snapshot must still be the live binding; any drift is a no-op.
    if (
      entry.apiUrl !== expected.apiUrl ||
      entry.serverTrustIdentity !== expected.serverTrustIdentity ||
      entry.cubeId !== expected.cubeId ||
      entry.localSessionCredentialRef !== expected.credentialRef
    ) {
      return { outcome: 'changed' as const };
    }
    const credentialRef = expected.credentialRef;
    const binding = {
      origin: entry.apiUrl,
      trustIdentity: expected.serverTrustIdentity,
      cubeId: entry.cubeId,
    };

    const removeBinding = async () => {
      delete existing.projects[key];
      if (Object.keys(existing.projects).length === 0) {
        try {
          await unlink(CUBES_FILE);
        } catch (error: any) {
          if (error?.code !== 'ENOENT') throw error;
        }
      } else {
        await writeCubesFile(existing);
      }
    };

    if (expected.observation.kind === 'present') {
      // CREDENTIAL-FIRST: atomically compare the pinned digest and delete under
      // the per-account keychain lock. A same-ref remint (fresh bearer, new
      // digest) or an already-cleared credential = no delete = honest no-op with
      // the binding left in place. A backend error PROPAGATES (coherent state).
      const deleted = await compareAndClearServerSessionCredential(
        credentialRef,
        binding,
        expected.observation.sessionDigest,
      );
      if (!deleted) return { outcome: 'changed' as const };
      await removeBinding();
      return { outcome: 'reset' as const, credentialRef };
    }

    // ABSENT snapshot: the safe forward state (credential already gone). Confirm
    // it is STILL absent under the lock — a fresh credential appearing under the
    // same deterministic ref is a same-ref replacement we must NOT clobber.
    const reobserved = await getActiveServerSessionCredential(credentialRef, binding);
    if (reobserved !== null) return { outcome: 'changed' as const };
    await removeBinding();
    return { outcome: 'reset' as const, credentialRef };
  }));
  activeCubeWriteQueue = operation.then(() => undefined, () => undefined);
  return await operation;
}

export async function getProjectCliPreference(): Promise<BorgCli | null> {
  const data = await readLaunchFile();
  if (!data) return null;
  const entry = data.projects[findProjectRoot()];
  return entry?.cli === 'claude' || entry?.cli === 'codex' || entry?.cli === 'opencode' ? entry.cli : null;
}

/**
 * gh#556 Part 2 — like getProjectCliPreference, but keyed on an arbitrary
 * worktree dir (launch-all reads the saved CLI preference for EACH discovered
 * worktree, not just cwd). Returns null if no preference is saved for that path.
 */
export async function getProjectCliPreferenceForPath(dir: string): Promise<BorgCli | null> {
  const data = await readLaunchFile();
  if (!data) return null;
  const entry = data.projects[findProjectRoot(dir)];
  return entry?.cli === 'claude' || entry?.cli === 'codex' || entry?.cli === 'opencode' ? entry.cli : null;
}

/**
 * gh#556 Part 2 — returns all persisted project identities from cubes.json.
 * Used by `borg launch-all` to enumerate drones across all known worktrees
 * (scheme-agnostic — covers both old sibling paths and new ~/.borg paths).
 * Returns an empty array if the file is absent or malformed.
 */
export async function readAllProjectIdentities(): Promise<
  Array<{ projectPath: string; cube: ActiveCube }>
> {
  const data = await readCubesFile();
  if (!data) return [];
  const persisted = Object.entries(data.projects)
    .filter(
      ([, entry]) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.cubeId === 'string' &&
        entry.cubeId.length > 0 &&
        typeof entry.droneId === 'string' &&
        entry.droneId.length > 0
    );
  const hydrated = await Promise.all(
    persisted.map(async ([projectPath, cube]) => ({
      projectPath,
      cube: await hydrateActiveCube(cube),
    })),
  );
  return hydrated.flatMap(({ projectPath, cube }) =>
    cube === null ? [] : [{ projectPath, cube }],
  );
}

export async function setProjectCliPreference(cli: BorgCli): Promise<void> {
  const existing = (await readLaunchFile()) ?? { projects: {} };
  existing.projects[findProjectRoot()] = { cli };
  await writeLaunchFile(existing);
}

export async function setCodexWakeTarget(
  cubeId: string,
  droneId: string,
  target: Omit<CodexWakeTargetRecord, 'updatedAt'>
): Promise<void> {
  const existing = (await readCodexWakeTargetsFile()) ?? { targets: {} };
  existing.targets[codexWakeTargetKey(cubeId, droneId)] = {
    ...target,
    updatedAt: new Date().toISOString(),
  };
  await writeCodexWakeTargetsFile(existing);
}

export async function getCodexWakeTarget(
  cubeId: string,
  droneId: string
): Promise<CodexWakeTargetRecord | null> {
  const existing = await readCodexWakeTargetsFile();
  if (!existing) return null;
  const target = existing.targets[codexWakeTargetKey(cubeId, droneId)];
  if (!target || typeof target.threadId !== 'string' || typeof target.socketPath !== 'string') {
    return null;
  }
  return target;
}

/**
 * gh#855: drop wake-target entries whose app-server socket is positively dead,
 * so the file self-heals (stale dead-socket entries from crashed prior launches
 * don't linger and mislead probeCodexBridgeArmed / health-beat). Pure prune
 * decision lives in codex-wake-resolve.ts (false-deaf-avoidance: keeps alive +
 * indeterminate); this is the thin read → prune → write-only-on-change glue.
 * The liveness check is injected (claude.ts wires checkCodexBridgeHealthy) so
 * cubes.ts stays free of the codex-remote dependency.
 */
export async function pruneDeadCodexWakeTargets(
  socketLiveness: (socketPath: string) => boolean | null
): Promise<void> {
  const existing = await readCodexWakeTargetsFile();
  if (!existing) return;
  const { targets, changed } = pruneDeadWakeTargets(existing.targets, socketLiveness);
  if (changed) await writeCodexWakeTargetsFile({ ...existing, targets });
}
