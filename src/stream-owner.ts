import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { assertSecureRoot, atomicWrite0600, readStoreFile } from './seat-store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_LOCKS_DIR = path.join(borgConfigRoot(), 'stream-locks');
const OWNER_FILE = 'owner.json';
const TAKEOVER_FILE = 'takeover.json';
const SCHEMA_VERSION = 1;

export const STREAM_OWNER_STALE_MS = 70_000;
/** Grace window for mkdir→owner.json initialization before an empty lock is reclaimable. */
export const STREAM_OWNER_INIT_STALE_MS = 5_000;
export const STREAM_OWNER_TAKEOVER_STALE_MS = 5_000;

const processNonce = randomUUID();
const processStartedAt = new Date().toISOString();

export interface StreamOwnerRecord {
  schemaVersion: number;
  pid: number;
  processNonce: string;
  cwd: string;
  startedAt: string;
  heartbeatAt: string;
  worktree?: string;
  droneLabel?: string;
  cubeName?: string;
}

export interface StreamOwnershipSnapshot {
  state: 'owner' | 'owned-by-other-process' | 'initializing' | 'orphaned-initialization' | 'unowned';
  pid?: number;
  processNonce?: string;
  cwd?: string;
  startedAt?: string;
  heartbeatAt?: string;
  worktree?: string;
  droneLabel?: string;
  cubeName?: string;
  ageMs?: number;
  lockPath?: string;
  /** Opened-directory identity used to bind inspection to later takeover. */
  lockDev?: number;
  lockIno?: number;
}

export interface StreamLease {
  lockPath: string;
  record: StreamOwnerRecord;
  refresh(): Promise<boolean>;
  release(): Promise<void>;
}

export interface StreamOwnerDeps {
  now?: () => Date;
  pid?: number;
  cwd?: string;
  locksDir?: string;
  /** Production opt-in for private lease storage beneath this canonical root.
   * Ancestors from boundary to root use the store owner-controlled policy;
   * root and descendants require 0700. Uses private reads and exclusive,
   * identity-checked leaf publication. Absent: ordinary stream I/O unchanged.
   * Static hostile objects are in scope; same-UID syscall races are not.
   */
  privateRoot?: { root: string; boundary: string };
  processNonce?: string;
  processStartedAt?: string;
  worktree?: string;
  droneLabel?: string;
  cubeName?: string;
  isPidAlive?: (pid: number) => boolean;
  beforeTakeoverVerify?: (takeoverPath: string) => Promise<void>;
  beforeLeaseRefreshMutation?: (lockPath: string) => Promise<void>;
  beforeLeaseReleaseMutation?: (lockPath: string) => Promise<void>;
  /** Initialization/refresh writer seam for failure-path regression tests. */
  writeRecord?: (lockPath: string, record: StreamOwnerRecord) => Promise<void>;
}

export function streamLockPath(
  cubeId: string,
  droneId: string,
  locksDir = STREAM_LOCKS_DIR
): string {
  assertUuid('cubeId', cubeId);
  assertUuid('droneId', droneId);
  return path.join(locksDir, cubeId, `${droneId}.lock`);
}

export async function acquireStreamLease(
  cubeId: string,
  droneId: string,
  staleMs = STREAM_OWNER_STALE_MS,
  deps: StreamOwnerDeps = {}
): Promise<StreamLease | null> {
  const lockPath = streamLockPath(cubeId, droneId, deps.locksDir);
  if (deps.privateRoot) await privateLeaseDirectory(path.dirname(lockPath), deps, true);
  else await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  if (!(await recoverTakeoverClaim(lockPath, staleMs, deps))) return null;

  const lease = await tryCreateLease(lockPath, deps);
  if (lease) return lease;

  const snapshot = await readOwnershipSnapshot(cubeId, droneId, deps);
  if (snapshot.state === 'unowned') {
    return tryCreateLease(lockPath, deps);
  }
  if (snapshot.state === 'initializing') {
    return null;
  }
  if (snapshot.state === 'orphaned-initialization') {
    if (!(await moveStaleLockAside(lockPath, snapshot, staleMs, deps))) return null;
    return tryCreateLease(lockPath, deps);
  }
  if (snapshot.state !== 'owned-by-other-process') {
    return null;
  }

  const stale = (snapshot.ageMs ?? 0) > staleMs;
  const pidDead =
    typeof snapshot.pid === 'number' &&
    !isPidAlive(snapshot.pid, deps);
  if (!stale && !pidDead) {
    return null;
  }

  if (!(await moveStaleLockAside(lockPath, snapshot, staleMs, deps))) {
    return null;
  }
  return tryCreateLease(lockPath, deps);
}

export async function readOwnershipSnapshot(
  cubeId: string,
  droneId: string,
  deps: StreamOwnerDeps = {}
): Promise<StreamOwnershipSnapshot> {
  const lockPath = streamLockPath(cubeId, droneId, deps.locksDir);
  const inspected = await readBoundOwner(lockPath, deps);
  if (!inspected) return { state: 'unowned', lockPath };
  const { raw, stat: lockStat } = inspected;
  if (raw === null) {
    const now = (deps.now ?? (() => new Date()))();
    const ageMs = Math.max(0, now.getTime() - lockStat.mtimeMs);
    return {
      state: ageMs >= STREAM_OWNER_INIT_STALE_MS
        ? 'orphaned-initialization'
        : 'initializing',
      ageMs,
      lockPath,
      lockDev: lockStat.dev,
      lockIno: lockStat.ino,
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: 'owned-by-other-process',
      lockPath,
      ageMs: Number.POSITIVE_INFINITY,
      lockDev: lockStat.dev,
      lockIno: lockStat.ino,
    };
  }

  if (!isRecord(parsed)) {
    return {
      state: 'owned-by-other-process',
      lockPath,
      ageMs: Number.POSITIVE_INFINITY,
      lockDev: lockStat.dev,
      lockIno: lockStat.ino,
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const heartbeatMs = Date.parse(parsed.heartbeatAt);
  const ageMs = Number.isFinite(heartbeatMs) ? now.getTime() - heartbeatMs : Number.POSITIVE_INFINITY;
  const ownPid = deps.pid ?? process.pid;
  const ownNonce = deps.processNonce ?? processNonce;
  const state =
    parsed.pid === ownPid && parsed.processNonce === ownNonce
      ? 'owner'
      : 'owned-by-other-process';
  return {
    state,
    pid: parsed.pid,
    processNonce: parsed.processNonce,
    cwd: parsed.cwd,
    startedAt: parsed.startedAt,
    heartbeatAt: parsed.heartbeatAt,
    worktree: parsed.worktree,
    droneLabel: parsed.droneLabel,
    cubeName: parsed.cubeName,
    ageMs,
    lockPath,
    lockDev: lockStat.dev,
    lockIno: lockStat.ino,
  };
}

async function tryCreateLease(
  lockPath: string,
  deps: StreamOwnerDeps
): Promise<StreamLease | null> {
  if (deps.privateRoot) {
    await privateLeaseDirectory(lockPath, deps, false);
    await privateLeaseDirectory(takeoverPath(lockPath), deps, false);
  }
  if (await pathExists(takeoverPath(lockPath))) return null;
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (err: any) {
    if (err?.code === 'EEXIST') return null;
    throw err;
  }

  const record = makeRecord(deps);
  try {
    await writeLeaseRecord(lockPath, record, deps);
    if (await pathExists(takeoverPath(lockPath))) {
      await cleanupFailedInitialization(lockPath, record, deps).catch(() => {});
      return null;
    }
  } catch (err) {
    await cleanupFailedInitialization(lockPath, record, deps).catch(() => {});
    throw err;
  }
  const created = await readBoundOwner(lockPath, deps);
  const createdRecord = created?.raw ? parseOwnershipRecord(created.raw) : null;
  if (
    !created || !createdRecord ||
    !sameOwner(record, createdRecord)
  ) {
    await cleanupFailedInitialization(lockPath, record, deps).catch(() => {});
    throw new Error('Borg stream lease initialization lost ownership');
  }
  return makeLease(
    lockPath,
    record,
    { dev: created.stat.dev, ino: created.stat.ino },
    deps,
  );
}

/**
 * Remove a mkdir-without-owner partial state after initialization fails. Rename
 * first, then verify identity: if a racer installed a different valid owner in
 * the canonical path, restore/preserve it rather than recursively deleting it.
 */
async function cleanupFailedInitialization(
  lockPath: string,
  attempted: StreamOwnerRecord,
  deps: StreamOwnerDeps,
): Promise<void> {
  const cleanupPath = `${lockPath}.failed-${attempted.processNonce}-${Date.now()}`;
  try {
    await fs.rename(lockPath, cleanupPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  const current = await readOwnershipRecord(cleanupPath, deps);
  if (current && (current.pid !== attempted.pid || current.processNonce !== attempted.processNonce)) {
    try {
      await fs.rename(cleanupPath, lockPath);
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      // A canonical successor won the race. Keep its lock; the displaced
      // record cannot own the canonical lease and is safe to remove.
      await fs.rm(cleanupPath, { recursive: true, force: true });
    }
    return;
  }
  await fs.rm(cleanupPath, { recursive: true, force: true });
}

async function moveStaleLockAside(
  lockPath: string,
  snapshot: StreamOwnershipSnapshot,
  staleMs: number,
  deps: StreamOwnerDeps
): Promise<boolean> {
  const claimPath = takeoverPath(lockPath);
  if (deps.privateRoot) {
    await privateLeaseDirectory(lockPath, deps, false);
    await privateLeaseDirectory(claimPath, deps, false);
  }
  try {
    await fs.rename(lockPath, claimPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return false;
    if (err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') return false;
    throw err;
  }

  const claimStat = await fs.stat(claimPath).catch(() => null);
  if (!claimStat || !snapshotMatchesIdentity(snapshot, claimStat)) {
    try {
      await fs.rename(claimPath, lockPath);
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      // The renamed directory was a successor, not the inspected lease. It is
      // authoritative unless another canonical successor already appeared.
      await preserveDisplacedLock(claimPath, lockPath);
    }
    return false;
  }

  const claimant = {
    schemaVersion: 1,
    pid: deps.pid ?? process.pid,
    processNonce: deps.processNonce ?? processNonce,
    claimedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  if (deps.privateRoot) await writePrivateLeaseFile(claimPath, TAKEOVER_FILE, claimant, deps, true);
  else await fs.writeFile(
    path.join(claimPath, TAKEOVER_FILE),
    JSON.stringify(claimant, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  await deps.beforeTakeoverVerify?.(claimPath);
  const verified = await readOwnershipRecord(claimPath, deps);
  const verifiedStat = await fs.stat(claimPath).catch(() => null);
  if (!isStillReclaimable(snapshot, verified, verifiedStat, staleMs, deps)) {
    await fs.unlink(path.join(claimPath, TAKEOVER_FILE)).catch(() => {});
    try {
      await fs.rename(claimPath, lockPath);
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      await fs.rm(claimPath, { recursive: true, force: true });
    }
    return false;
  }

  await fs.rm(claimPath, { recursive: true, force: true });
  return true;
}

function takeoverPath(lockPath: string): string {
  return `${lockPath}.takeover`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function recoverTakeoverClaim(
  lockPath: string,
  staleMs: number,
  deps: StreamOwnerDeps,
): Promise<boolean> {
  const claimPath = takeoverPath(lockPath);
  if (deps.privateRoot) {
    await privateLeaseDirectory(lockPath, deps, false);
    await privateLeaseDirectory(claimPath, deps, false);
  }
  let claimStat;
  try {
    claimStat = await fs.stat(claimPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }

  const now = (deps.now ?? (() => new Date()))();
  const privateClaim = deps.privateRoot
    ? await readStoreFile(path.join(claimPath, TAKEOVER_FILE), { secureRoot: claimPath, createRoot: false })
    : undefined;
  let claimant: { pid: number; processNonce: string; claimedAt: string } | null = null;
  try {
    const parsed = JSON.parse((deps.privateRoot
      ? privateClaim
      : await fs.readFile(path.join(claimPath, TAKEOVER_FILE), 'utf8')) ?? 'null');
    if (
      parsed?.schemaVersion === 1 &&
      Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
      isSafeLeaseText(parsed.processNonce, 128) &&
      isIsoTimestamp(parsed.claimedAt)
    ) claimant = parsed;
  } catch {
    // A claimant can die after rename but before publishing its marker. The
    // directory mtime supplies a bounded initialization grace period.
  }

  const claimAge = claimant
    ? now.getTime() - Date.parse(claimant.claimedAt)
    : now.getTime() - claimStat.mtimeMs;
  if (
    claimant && Number.isFinite(claimAge) &&
    claimAge <= STREAM_OWNER_TAKEOVER_STALE_MS &&
    isPidAlive(claimant.pid, deps)
  ) return false;
  if (!claimant && claimAge <= STREAM_OWNER_TAKEOVER_STALE_MS) return false;

  const owner = await readOwnershipRecord(claimPath, deps);
  const ownerHeartbeat = owner ? Date.parse(owner.heartbeatAt) : Number.NaN;
  const ownerAge = Number.isFinite(ownerHeartbeat)
    ? now.getTime() - ownerHeartbeat
    : Number.POSITIVE_INFINITY;
  const ownerReclaimable = !owner || ownerAge > staleMs || !isPidAlive(owner.pid, deps);
  if (ownerReclaimable) {
    await fs.rm(claimPath, { recursive: true, force: true });
    return true;
  }

  await fs.unlink(path.join(claimPath, TAKEOVER_FILE)).catch(() => {});
  try {
    await fs.rename(claimPath, lockPath);
  } catch (error: any) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    // A canonical successor already owns the name. Preserve it and discard
    // only the displaced, noncanonical claim directory.
    await fs.rm(claimPath, { recursive: true, force: true });
  }
  return false;
}

function isStillReclaimable(
  snapshot: StreamOwnershipSnapshot,
  current: StreamOwnerRecord | null,
  currentLockStat: { dev: number; ino: number } | null,
  staleMs: number,
  deps: StreamOwnerDeps
): boolean {
  if (!currentLockStat || !snapshotMatchesIdentity(snapshot, currentLockStat)) return false;
  if (!current) {
    if (snapshot.state === 'orphaned-initialization') return true;
    return snapshot.ageMs === Number.POSITIVE_INFINITY;
  }
  if (
    snapshot.pid !== current.pid ||
    snapshot.processNonce !== current.processNonce ||
    snapshot.heartbeatAt !== current.heartbeatAt
  ) {
    return false;
  }
  const now = (deps.now ?? (() => new Date()))();
  const heartbeatMs = Date.parse(current.heartbeatAt);
  const ageMs = Number.isFinite(heartbeatMs)
    ? now.getTime() - heartbeatMs
    : Number.POSITIVE_INFINITY;
  const stale = ageMs > staleMs;
  const pidDead =
    !isPidAlive(current.pid, deps);
  return stale || pidDead;
}

function snapshotMatchesIdentity(
  snapshot: StreamOwnershipSnapshot,
  stat: { dev: number; ino: number },
): boolean {
  return snapshot.lockDev !== undefined && snapshot.lockIno !== undefined &&
    snapshot.lockDev === stat.dev && snapshot.lockIno === stat.ino;
}

async function preserveDisplacedLock(claimPath: string, lockPath: string): Promise<void> {
  try {
    await fs.rename(claimPath, lockPath);
  } catch (error: any) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    // Never delete an identity we did not prove stale. Leave it under its
    // unique recovery name for conservative operator/process recovery.
  }
}

function isPidAlive(pid: number, deps: StreamOwnerDeps): boolean {
  if (deps.isPidAlive) return deps.isPidAlive(pid);
  // Tests that inject synthetic owner PIDs but no process probe retain the
  // historical "assume live" behavior. Production uses the real process PID
  // and therefore verifies dead owners immediately.
  if (deps.pid !== undefined) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function makeLease(
  lockPath: string,
  record: StreamOwnerRecord,
  identity: { dev: number; ino: number },
  deps: StreamOwnerDeps
): StreamLease {
  let ownedRecord = record;
  return {
    lockPath,
    record,
    async refresh(): Promise<boolean> {
      await deps.beforeLeaseRefreshMutation?.(lockPath);
      const next = { ...ownedRecord, heartbeatAt: (deps.now ?? (() => new Date()))().toISOString() };
      const refreshed = await mutateClaimedLease(
        lockPath,
        identity,
        ownedRecord,
        deps,
        async (claimPath) => {
          await writeLeaseRecord(claimPath, next, deps);
          return 'restore';
        },
      );
      if (!refreshed) return false;
      ownedRecord = next;
      this.record = next;
      return true;
    },
    async release(): Promise<void> {
      await deps.beforeLeaseReleaseMutation?.(lockPath);
      await mutateClaimedLease(
        lockPath,
        identity,
        ownedRecord,
        deps,
        async () => 'remove',
      );
    },
  };
}

async function mutateClaimedLease(
  lockPath: string,
  identity: { dev: number; ino: number },
  expected: StreamOwnerRecord,
  deps: StreamOwnerDeps,
  mutation: (claimPath: string) => Promise<'restore' | 'remove'>,
): Promise<boolean> {
  const claimPath = takeoverPath(lockPath);
  if (deps.privateRoot) {
    await privateLeaseDirectory(lockPath, deps, false);
    await privateLeaseDirectory(claimPath, deps, false);
  }
  try {
    await fs.rename(lockPath, claimPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      return false;
    }
    throw error;
  }

  const movedStat = await fs.stat(claimPath).catch(() => null);
  if (!movedStat || !sameIdentity(identity, movedStat)) {
    await restoreClaimedLease(claimPath, lockPath);
    return false;
  }

  const claimant = {
    schemaVersion: 1,
    pid: deps.pid ?? process.pid,
    processNonce: deps.processNonce ?? processNonce,
    claimedAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
  if (deps.privateRoot) await writePrivateLeaseFile(claimPath, TAKEOVER_FILE, claimant, deps, true);
  else await fs.writeFile(
    path.join(claimPath, TAKEOVER_FILE),
    JSON.stringify(claimant, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );

  const inspected = await readBoundOwner(claimPath, deps);
  const current = inspected?.raw ? parseOwnershipRecord(inspected.raw) : null;
  if (
    !inspected || !sameIdentity(identity, inspected.stat) || !current ||
    !sameOwner(expected, current)
  ) {
    await fs.unlink(path.join(claimPath, TAKEOVER_FILE)).catch(() => {});
    await restoreClaimedLease(claimPath, lockPath);
    return false;
  }

  const disposition = await mutation(claimPath);
  if (disposition === 'remove') {
    await fs.rm(claimPath, { recursive: true, force: true });
    return true;
  }

  await fs.unlink(path.join(claimPath, TAKEOVER_FILE)).catch(() => {});
  return restoreClaimedLease(claimPath, lockPath);
}

async function restoreClaimedLease(claimPath: string, lockPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rename(claimPath, lockPath);
      return true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      // A creator that began just before the claim appeared must observe the
      // fixed claim and clean its own initialization. Give it a bounded chance
      // to do so without ever deleting that unverified canonical directory.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return false;
}

function sameOwner(left: StreamOwnerRecord, right: StreamOwnerRecord): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.pid === right.pid &&
    left.processNonce === right.processNonce &&
    left.cwd === right.cwd &&
    left.startedAt === right.startedAt &&
    left.heartbeatAt === right.heartbeatAt &&
    left.worktree === right.worktree &&
    left.droneLabel === right.droneLabel &&
    left.cubeName === right.cubeName;
}

async function readOwnershipRecord(lockPath: string, deps: StreamOwnerDeps = {}): Promise<StreamOwnerRecord | null> {
  if (deps.privateRoot) {
    const inspected = await readBoundOwner(lockPath, deps);
    return inspected?.raw ? parseOwnershipRecord(inspected.raw) : null;
  }
  try {
    const raw = await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8');
    return parseOwnershipRecord(raw);
  } catch {
    return null;
  }
}

function parseOwnershipRecord(raw: string): StreamOwnerRecord | null {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readBoundOwner(lockPath: string, deps: StreamOwnerDeps = {}): Promise<{
  raw: string | null;
  stat: { dev: number; ino: number; mtimeMs: number };
} | null> {
  if (deps.privateRoot && !await privateLeaseDirectory(lockPath, deps, false)) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'r');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    try {
      const openedStat = await handle.stat();
      let raw: string | null;
      try {
        raw = deps.privateRoot
          ? await readStoreFile(path.join(lockPath, OWNER_FILE), { secureRoot: lockPath, createRoot: false })
          : await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8');
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        raw = null;
      }
      const canonicalStat = await fs.stat(lockPath).catch((error: any) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      const finalOpenedStat = await handle.stat();
      if (canonicalStat && sameIdentity(openedStat, finalOpenedStat) &&
          sameIdentity(openedStat, canonicalStat)) {
        return { raw, stat: canonicalStat };
      }
    } finally {
      await handle.close();
    }
  }
  return null;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Apply the existing private-store directory policy without creating on reads. */
async function privateLeaseDirectory(directory: string, deps: StreamOwnerDeps, create: boolean): Promise<boolean> {
  const { root, boundary } = deps.privateRoot!;
  const ancestors = path.relative(boundary, root);
  if (ancestors.startsWith('..') || path.isAbsolute(ancestors)) {
    throw new Error('Borg private lease root escapes its trusted boundary');
  }
  const relative = path.relative(root, directory);
  if (path.resolve(directory) !== directory || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Borg private lease path escapes its private root');
  }
  let ancestor = boundary;
  for (const component of ancestors.split(path.sep).filter(Boolean)) {
    if (!await assertSecureRoot(ancestor, 'owner-controlled', create)) return false;
    ancestor = path.join(ancestor, component);
  }
  if (!await assertSecureRoot(root, 'private', create)) return false;
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!await assertSecureRoot(current, 'private', create)) return false;
  }
  return true;
}

async function writePrivateLeaseFile(directory: string, name: string, value: unknown, deps: StreamOwnerDeps, exclusive = false): Promise<void> {
  if (!await privateLeaseDirectory(directory, deps, false)) throw new Error('Borg private lease directory disappeared');
  await atomicWrite0600(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', {
    secureRoot: directory, verifyLeafIdentity: true, exclusive, createRoot: false,
  });
}

async function writeLeaseRecord(directory: string, record: StreamOwnerRecord, deps: StreamOwnerDeps): Promise<void> {
  if (deps.privateRoot) await writePrivateLeaseFile(directory, OWNER_FILE, record, deps);
  else await (deps.writeRecord ?? writeRecord)(directory, record);
}

async function writeRecord(lockPath: string, record: StreamOwnerRecord): Promise<void> {
  const ownerPath = path.join(lockPath, OWNER_FILE);
  const tmpPath = path.join(lockPath, `${OWNER_FILE}.${record.processNonce}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(record, null, 2) + '\n', {
    mode: 0o600,
  });
  await fs.rename(tmpPath, ownerPath);
}

function makeRecord(deps: StreamOwnerDeps): StreamOwnerRecord {
  const now = deps.now ?? (() => new Date());
  return {
    schemaVersion: SCHEMA_VERSION,
    pid: deps.pid ?? process.pid,
    processNonce: deps.processNonce ?? processNonce,
    cwd: deps.cwd ?? process.cwd(),
    startedAt: deps.processStartedAt ?? processStartedAt,
    heartbeatAt: now().toISOString(),
    ...(deps.worktree ? { worktree: deps.worktree } : {}),
    ...(deps.droneLabel ? { droneLabel: deps.droneLabel } : {}),
    ...(deps.cubeName ? { cubeName: deps.cubeName } : {}),
  };
}

function isRecord(value: any): value is StreamOwnerRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    isSafeLeaseText(value.processNonce, 128) &&
    isSafeLeaseText(value.cwd, 4096) &&
    isIsoTimestamp(value.startedAt) &&
    isIsoTimestamp(value.heartbeatAt) &&
    (value.worktree === undefined || isSafeLeaseText(value.worktree, 4096)) &&
    (value.droneLabel === undefined || isSafeLeaseText(value.droneLabel, 256)) &&
    (value.cubeName === undefined || isSafeLeaseText(value.cubeName, 256))
  );
}

function isSafeLeaseText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return isSafeLeaseText(value, 64) && Number.isFinite(Date.parse(value));
}

function assertUuid(label: string, value: string): void {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}
