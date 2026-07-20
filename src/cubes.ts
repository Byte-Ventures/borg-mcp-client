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
 * local-server trust can no longer be hydrated.
 *
 * apiUrl is captured at assimilate time so subprocess invocations (e.g. the
 * SessionStart hook firing borg-regen) don't need BORG_API_URL in their env
 * to know which worker to talk to.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pruneDeadWakeTargets } from './codex-wake-resolve.js';
import {
  getActiveSeatCredential,
  getActiveSeatForWorktree,
  getSeatForWorktree,
  hasSeatForWorktree,
  observeSeat,
  readAllActiveSeats,
  refreshSeatMetadata,
  resetSeatForWorktree,
  seatRef,
  type SeatObservation,
  type SeatOperation,
  type SeatRecord,
} from './seats.js';

// The unified 0600 seat store (seats.ts / seats.json) is now the SOLE home of the
// per-worktree ACTIVE-CUBE seat map: each seat = credential + worktree binding +
// display as ONE atomic record. cubes.json no longer holds a seat map — the
// functions below are thin adapters over seats.ts. Only launch.json,
// codex-wake-targets.json, and the inbox tree remain owned by this module.

/** Re-exported from seats.ts for call-site parity (the retired cross-store name). */
export type { SeatExpectation as ExpectedBinding } from './seats.js';

const CUBES_DIR = join(homedir(), '.config', 'borgmcp');
const LAUNCH_FILE = join(CUBES_DIR, 'launch.json');
const CODEX_WAKE_TARGETS_FILE = join(CUBES_DIR, 'codex-wake-targets.json');
const INBOX_DIR = join(CUBES_DIR, 'inboxes');

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
  const record = await getActiveSeatForWorktree(findProjectRoot());
  if (!record || !record.cubeId || !record.droneId) return null;
  return hydrateActiveCube(record);
}

/**
 * True iff this worktree has an ACTIVE bound seat in seats.json. In the collapsed
 * single-store model the credential and the worktree binding are one atomic unit,
 * so there is no "binding present but credential lost" partial state to diagnose:
 * an active bound seat always hydrates.
 */
export async function hasPersistedActiveCube(): Promise<boolean> {
  return hasSeatForWorktree(findProjectRoot());
}

/**
 * Compose an ActiveCube from an ACTIVE SeatRecord, hydrating the session bearer via
 * the SOLE raw-bearer reader (getActiveSeatCredential). Returns null if the bearer
 * can no longer be resolved (record concurrently reset/replaced).
 */
async function hydrateActiveCube(record: SeatRecord): Promise<ActiveCube | null> {
  const ref = seatRef(record);
  const sessionToken = await getActiveSeatCredential(ref, {
    origin: record.origin,
    trustIdentity: record.trustIdentity,
    cubeId: record.cubeId,
  });
  if (!sessionToken) return null;
  return {
    cubeId: record.cubeId,
    droneId: record.droneId!,
    name: record.name ?? '',
    droneLabel: record.droneLabel ?? '',
    sessionToken,
    apiUrl: record.origin,
    serverTrustIdentity: record.trustIdentity,
    localSessionCredentialRef: ref,
    ...(record.expiresAt !== undefined ? { localSessionExpiresAt: record.expiresAt } : {}),
    ...(record.roleName !== undefined ? { roleName: record.roleName } : {}),
    ...(record.roleClass !== undefined ? { roleClass: record.roleClass } : {}),
    ...(record.isHumanSeat !== undefined ? { isHumanSeat: record.isHumanSeat } : {}),
  };
}

/**
 * Legacy binding-only writer. In the collapsed single-store model an ACTIVE seat is
 * created ONLY by the atomic mint→activate+bind path in seats.ts (driven by the
 * attach FINALIZE); there is no standalone binding write. Retained solely as a
 * fail-closed guard for incomplete session metadata.
 */
export async function setActiveCube(_active: ActiveCubeInput): Promise<void> {
  throw new Error('local Borg server session metadata is incomplete');
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

// The ONLY sanctioned seat-clear is resetLocalSeatBinding → seats.ts
// resetSeatForWorktree, which under the single store flock re-checks the FULL
// binding (ref + drone id) + the token-safe observation and DELETES the whole
// record (credential AND binding together — no cross-store 'partial').

export interface LocalSeatSnapshot {
  apiUrl: string;
  serverTrustIdentity: string;
  cubeId: string;
  /** The FULL binding includes the prior drone identity (CR #3): a drone-id
   *  change at recheck is a full-binding change and aborts the reset. CR#4: a
   *  bound-PENDING record (a sibling whose activation failed) may carry NO drone id
   *  yet — the snapshot then omits it and the reset matches on undefined-vs-undefined,
   *  still deleting the exact record. */
  droneId?: string;
  credentialRef: string;
  worktree: string;
  /** Token-safe TYPED seat observation: active|pending (with digest) or absent. */
  observation: SeatObservation;
}

export type ResetLocalSeatOutcome =
  // The whole record (credential + binding) was deleted in one commit. In the
  // single store there is no cross-store 'partial'/'repair-required' state.
  | { outcome: 'reset'; credentialRef: string }
  | { outcome: 'no-binding' }
  | { outcome: 'changed' };

/**
 * Snapshot this worktree's exact FULL local-seat binding (incl drone id) plus a
 * token-safe TYPED observation (active + digest | absent). Read-only. Returns null
 * when this worktree has no ACTIVE bound seat to reset: an honest no-op.
 */
export async function snapshotLocalSeat(): Promise<LocalSeatSnapshot | null> {
  const worktree = findProjectRoot();
  // CR#4: discover an ACTIVE seat OR a bound-PENDING record (a sibling whose
  // activation failed, bound to THIS worktree by the attach bind-pending step).
  // getActiveSeatForWorktree would MISS the bound-pending record (it requires
  // state==='active' + a drone id), so `reset-local-seat` would FALSELY report
  // "nothing to reset" (exit 0) while a resumable, server-digest-bound bearer
  // persists at rest — a FALSE-SUCCESS revocation failure. getSeatForWorktree sees
  // both, and the offline reset's exact re-check + delete cover the bound-pending
  // record too.
  const record = await getSeatForWorktree(worktree);
  if (!record || !record.cubeId) return null;
  const ref = seatRef(record);
  const observation = await observeSeat(ref, {
    origin: record.origin,
    trustIdentity: record.trustIdentity,
    cubeId: record.cubeId,
  });
  return {
    apiUrl: record.origin,
    serverTrustIdentity: record.trustIdentity,
    cubeId: record.cubeId,
    ...(record.droneId !== undefined ? { droneId: record.droneId } : {}),
    credentialRef: ref,
    worktree,
    observation,
  };
}

export interface PersistedLocalSeat {
  cubeId: string;
  /** Optional: a bound-PENDING record (a sibling whose activation failed) may carry
   *  no drone id yet — the ACTIVE resume path still has it. */
  droneId?: string;
  name: string;
  droneLabel: string;
  apiUrl: string;
  serverTrustIdentity: string;
  localSessionCredentialRef: string;
  localSessionExpiresAt?: string | null;
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
  /** The STORED seat operation (projectRoot + kind + operationKey). The resume path
   *  re-derives the EXACT seat ref from this: for a bound-PENDING sibling it is the
   *  ORIGINAL sibling operation, NOT the rerun worktree's derived seat operation —
   *  so the rerun re-mints-or-reuses the identical pending bearer and converges. */
  operation: SeatOperation;
  /** The record state: a bound-PENDING record resumes with an ABSENT/pending-reuse
   *  expectation (re-send the identical bearer); an ACTIVE one resumes with EXACT. */
  state: 'pending' | 'active';
}

/**
 * Read the RAW persisted local-server seat bound to the current worktree — ACTIVE
 * or a bound-PENDING record — WITHOUT hydrating its credential. Used by the resume
 * path to recover the seat identity, its stored `operation`, and its `state`.
 *
 * CR#2: a SIBLING attach whose activation failed leaves a PENDING record BOUND to
 * the preserved worktree (via the attach path's bind-pending step). This surfaces it so the
 * rerun-from-that-worktree re-derives the EXACT sibling ref and re-sends the
 * identical bearer (ghost-free convergence). A crash-in-gap PENDING record that was
 * NEVER bound to a worktree still returns null here (it carries no worktree locator)
 * and is resumed by prepareSeat's idempotent mint-or-reuse; a genuine absence is
 * likewise null and a fresh enroll mints correctly.
 */
export async function readPersistedLocalSeat(): Promise<PersistedLocalSeat | null> {
  const record = await getSeatForWorktree(findProjectRoot());
  if (!record || !record.cubeId) return null;
  return {
    cubeId: record.cubeId,
    ...(record.droneId !== undefined ? { droneId: record.droneId } : {}),
    name: record.name ?? '',
    droneLabel: record.droneLabel ?? '',
    apiUrl: record.origin,
    serverTrustIdentity: record.trustIdentity,
    localSessionCredentialRef: seatRef(record),
    operation: record.operation,
    state: record.state,
    ...(record.expiresAt !== undefined ? { localSessionExpiresAt: record.expiresAt } : {}),
    ...(record.roleName !== undefined ? { roleName: record.roleName } : {}),
    ...(record.roleClass !== undefined ? { roleClass: record.roleClass } : {}),
    ...(record.isHumanSeat !== undefined ? { isHumanSeat: record.isHumanSeat } : {}),
  };
}

/**
 * Reset this worktree's seat: delegate to the single-store resetSeatForWorktree,
 * which under ONE flock re-checks the exact FULL binding (ref + drone id, CR #3)
 * plus the token-safe observation and DELETES the whole record — credential AND
 * binding vanish together in one commit. Any drift / missing / same-ref digest
 * replacement is an honest no-op ('changed'); no cross-store 'partial' exists.
 */
export async function resetLocalSeatBinding(
  expected: LocalSeatSnapshot,
): Promise<ResetLocalSeatOutcome> {
  const outcome = await resetSeatForWorktree({
    worktree: expected.worktree,
    ref: expected.credentialRef,
    droneId: expected.droneId,
    observation: expected.observation,
  });
  if (outcome.outcome === 'reset') return { outcome: 'reset', credentialRef: outcome.ref };
  if (outcome.outcome === 'no-binding') return { outcome: 'no-binding' };
  return { outcome: 'changed' };
}

export type FinalizeServerSeatOutcome =
  // Activate+bind committed atomically (credential ACTIVE and worktree bound).
  | { committed: true }
  // Aborted at PREPARE-time revalidation — nothing minted/bound (safe to roll back
  // a just-spawned worktree; the own pending record was scrubbed). Produced only by
  // the prepare stage (result.prepareAborted); never by the merged activate+bind.
  | { committed: false; reason: 'expectation-mismatch' }
  // The merged activate+bind did not commit (missing/replaced/threw). The PENDING
  // record is the rerunnable locator; the caller must PRESERVE the worktree (CR #5).
  | { committed: false; reason: 'activation-failed' };

/**
 * Metadata-only refresh (cube name / drone label / role display) of the CURRENT
 * worktree's ACTIVE seat — delegates to seats.ts refreshSeatMetadata, which CANNOT
 * alter the credential, ref, identity, or worktree binding. A no-op when this
 * worktree has no active seat, so a stale regen identity can never resurrect or
 * mutate a seat ref.
 */
export async function refreshActiveCubeMetadata(active: ActiveCubeInput): Promise<void> {
  await refreshSeatMetadata(findProjectRoot(), {
    name: active.name,
    droneLabel: active.droneLabel,
    ...(active.roleName !== undefined ? { roleName: active.roleName } : {}),
    ...(active.roleClass !== undefined ? { roleClass: active.roleClass } : {}),
    ...(active.isHumanSeat !== undefined ? { isHumanSeat: active.isHumanSeat } : {}),
  });
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
 * gh#556 Part 2 — returns all persisted project identities from the seat store.
 * Used by `borg launch-all` to enumerate drones across all known worktrees.
 * Returns an empty array when no ACTIVE bound seats exist.
 */
export async function readAllProjectIdentities(): Promise<
  Array<{ projectPath: string; cube: ActiveCube }>
> {
  const seats = await readAllActiveSeats();
  const hydrated = await Promise.all(
    seats.map(async ({ worktree, record }) => ({
      projectPath: worktree,
      cube: await hydrateActiveCube(record),
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
