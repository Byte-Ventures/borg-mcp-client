import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_LOCKS_DIR = path.join(homedir(), '.config', 'borgmcp', 'stream-locks');
const OWNER_FILE = 'owner.json';
const SCHEMA_VERSION = 1;
export const STREAM_OWNER_STALE_MS = 70_000;
/** Grace window for mkdir→owner.json initialization before an empty lock is reclaimable. */
export const STREAM_OWNER_INIT_STALE_MS = 5_000;
const processNonce = randomUUID();
const processStartedAt = new Date().toISOString();
export function streamLockPath(cubeId, droneId, locksDir = STREAM_LOCKS_DIR) {
    assertUuid('cubeId', cubeId);
    assertUuid('droneId', droneId);
    return path.join(locksDir, cubeId, `${droneId}.lock`);
}
export async function acquireStreamLease(cubeId, droneId, staleMs = STREAM_OWNER_STALE_MS, deps = {}) {
    const lockPath = streamLockPath(cubeId, droneId, deps.locksDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    const lease = await tryCreateLease(lockPath, deps);
    if (lease)
        return lease;
    const snapshot = await readOwnershipSnapshot(cubeId, droneId, deps);
    if (snapshot.state === 'unowned') {
        return tryCreateLease(lockPath, deps);
    }
    if (snapshot.state === 'initializing') {
        return null;
    }
    if (snapshot.state === 'orphaned-initialization') {
        if (!(await moveStaleLockAside(lockPath, snapshot, staleMs, deps)))
            return null;
        return tryCreateLease(lockPath, deps);
    }
    if (snapshot.state !== 'owned-by-other-process') {
        return null;
    }
    const stale = (snapshot.ageMs ?? 0) > staleMs;
    const pidDead = typeof snapshot.pid === 'number' &&
        deps.isPidAlive !== undefined &&
        !deps.isPidAlive(snapshot.pid);
    if (!stale && !pidDead) {
        return null;
    }
    if (!(await moveStaleLockAside(lockPath, snapshot, staleMs, deps))) {
        return null;
    }
    return tryCreateLease(lockPath, deps);
}
export async function readOwnershipSnapshot(cubeId, droneId, deps = {}) {
    const lockPath = streamLockPath(cubeId, droneId, deps.locksDir);
    let raw;
    try {
        raw = await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8');
    }
    catch (err) {
        if (err?.code === 'ENOENT') {
            try {
                const lockStat = await fs.stat(lockPath);
                const now = (deps.now ?? (() => new Date()))();
                const ageMs = Math.max(0, now.getTime() - lockStat.mtimeMs);
                return {
                    state: ageMs >= STREAM_OWNER_INIT_STALE_MS
                        ? 'orphaned-initialization'
                        : 'initializing',
                    ageMs,
                    lockPath,
                    lockMtimeMs: lockStat.mtimeMs,
                };
            }
            catch (statErr) {
                if (statErr?.code === 'ENOENT')
                    return { state: 'unowned', lockPath };
                throw statErr;
            }
        }
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { state: 'owned-by-other-process', lockPath, ageMs: Number.POSITIVE_INFINITY };
    }
    if (!isRecord(parsed)) {
        return { state: 'owned-by-other-process', lockPath, ageMs: Number.POSITIVE_INFINITY };
    }
    const now = (deps.now ?? (() => new Date()))();
    const heartbeatMs = Date.parse(parsed.heartbeatAt);
    const ageMs = Number.isFinite(heartbeatMs) ? now.getTime() - heartbeatMs : Number.POSITIVE_INFINITY;
    const ownPid = deps.pid ?? process.pid;
    const ownNonce = deps.processNonce ?? processNonce;
    const state = parsed.pid === ownPid && parsed.processNonce === ownNonce
        ? 'owner'
        : 'owned-by-other-process';
    return {
        state,
        pid: parsed.pid,
        processNonce: parsed.processNonce,
        cwd: parsed.cwd,
        startedAt: parsed.startedAt,
        heartbeatAt: parsed.heartbeatAt,
        ageMs,
        lockPath,
    };
}
async function tryCreateLease(lockPath, deps) {
    try {
        await fs.mkdir(lockPath, { mode: 0o700 });
    }
    catch (err) {
        if (err?.code === 'EEXIST')
            return null;
        throw err;
    }
    const record = makeRecord(deps);
    try {
        await (deps.writeRecord ?? writeRecord)(lockPath, record);
    }
    catch (err) {
        await cleanupFailedInitialization(lockPath, record).catch(() => { });
        throw err;
    }
    return makeLease(lockPath, record, deps);
}
/**
 * Remove a mkdir-without-owner partial state after initialization fails. Rename
 * first, then verify identity: if a racer installed a different valid owner in
 * the canonical path, restore/preserve it rather than recursively deleting it.
 */
async function cleanupFailedInitialization(lockPath, attempted) {
    const cleanupPath = `${lockPath}.failed-${attempted.processNonce}-${Date.now()}`;
    try {
        await fs.rename(lockPath, cleanupPath);
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return;
        throw err;
    }
    const current = await readOwnershipRecord(cleanupPath);
    if (current && (current.pid !== attempted.pid || current.processNonce !== attempted.processNonce)) {
        try {
            await fs.rename(cleanupPath, lockPath);
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                throw err;
            // A canonical successor won the race. Keep its lock; the displaced
            // record cannot own the canonical lease and is safe to remove.
            await fs.rm(cleanupPath, { recursive: true, force: true });
        }
        return;
    }
    await fs.rm(cleanupPath, { recursive: true, force: true });
}
async function moveStaleLockAside(lockPath, snapshot, staleMs, deps) {
    const takeoverPath = `${lockPath}.takeover-${deps.processNonce ?? processNonce}-${Date.now()}`;
    try {
        await fs.rename(lockPath, takeoverPath);
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return false;
        throw err;
    }
    await deps.beforeTakeoverVerify?.(takeoverPath);
    const verified = await readOwnershipRecord(takeoverPath);
    const verifiedStat = await fs.stat(takeoverPath).catch(() => null);
    if (!isStillReclaimable(snapshot, verified, verifiedStat?.mtimeMs, staleMs, deps)) {
        try {
            await fs.rename(takeoverPath, lockPath);
        }
        catch (err) {
            if (err?.code !== 'EEXIST')
                throw err;
            await fs.rm(takeoverPath, { recursive: true, force: true });
        }
        return false;
    }
    await fs.rm(takeoverPath, { recursive: true, force: true });
    return true;
}
function isStillReclaimable(snapshot, current, currentLockMtimeMs, staleMs, deps) {
    if (!current) {
        if (snapshot.state === 'orphaned-initialization') {
            return snapshot.lockMtimeMs !== undefined && currentLockMtimeMs === snapshot.lockMtimeMs;
        }
        return snapshot.ageMs === Number.POSITIVE_INFINITY;
    }
    if (snapshot.pid !== current.pid ||
        snapshot.processNonce !== current.processNonce ||
        snapshot.heartbeatAt !== current.heartbeatAt) {
        return false;
    }
    const now = (deps.now ?? (() => new Date()))();
    const heartbeatMs = Date.parse(current.heartbeatAt);
    const ageMs = Number.isFinite(heartbeatMs)
        ? now.getTime() - heartbeatMs
        : Number.POSITIVE_INFINITY;
    const stale = ageMs > staleMs;
    const pidDead = deps.isPidAlive !== undefined && !deps.isPidAlive(current.pid);
    return stale || pidDead;
}
function makeLease(lockPath, record, deps) {
    return {
        lockPath,
        record,
        async refresh() {
            const current = await readOwnershipRecord(lockPath);
            if (!current || current.pid !== record.pid || current.processNonce !== record.processNonce) {
                return false;
            }
            const next = { ...record, heartbeatAt: (deps.now ?? (() => new Date()))().toISOString() };
            await (deps.writeRecord ?? writeRecord)(lockPath, next);
            this.record = next;
            return true;
        },
        async release() {
            const current = await readOwnershipRecord(lockPath);
            if (current?.pid === record.pid && current.processNonce === record.processNonce) {
                await fs.rm(lockPath, { recursive: true, force: true });
            }
        },
    };
}
async function readOwnershipRecord(lockPath) {
    try {
        const raw = await fs.readFile(path.join(lockPath, OWNER_FILE), 'utf8');
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
async function writeRecord(lockPath, record) {
    const ownerPath = path.join(lockPath, OWNER_FILE);
    const tmpPath = path.join(lockPath, `${OWNER_FILE}.${record.processNonce}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2) + '\n', {
        mode: 0o600,
    });
    await fs.rename(tmpPath, ownerPath);
}
function makeRecord(deps) {
    const now = deps.now ?? (() => new Date());
    return {
        schemaVersion: SCHEMA_VERSION,
        pid: deps.pid ?? process.pid,
        processNonce: deps.processNonce ?? processNonce,
        cwd: deps.cwd ?? process.cwd(),
        startedAt: deps.processStartedAt ?? processStartedAt,
        heartbeatAt: now().toISOString(),
    };
}
function isRecord(value) {
    return (value !== null &&
        typeof value === 'object' &&
        value.schemaVersion === SCHEMA_VERSION &&
        typeof value.pid === 'number' &&
        Number.isInteger(value.pid) &&
        typeof value.processNonce === 'string' &&
        typeof value.cwd === 'string' &&
        typeof value.startedAt === 'string' &&
        typeof value.heartbeatAt === 'string');
}
function assertUuid(label, value) {
    if (!UUID_RE.test(value))
        throw new Error(`Invalid ${label}: ${value}`);
}
//# sourceMappingURL=stream-owner.js.map