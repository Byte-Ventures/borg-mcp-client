import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const CURSOR_FILE = join(homedir(), '.config', 'borgmcp', 'local-server-cursors.json');
const CURSOR_LOCK = `${CURSOR_FILE}.lock`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function cursorKey(binding) {
    if (new URL(binding.origin).origin !== binding.origin ||
        !UUID_RE.test(binding.cubeId) ||
        !UUID_RE.test(binding.droneId)) {
        throw new Error('invalid local Borg server cursor binding');
    }
    const hash = createHash('sha256')
        .update(binding.origin)
        .update('\0')
        .update(binding.trustIdentity)
        .update('\0')
        .update(binding.cubeId)
        .update('\0')
        .update(binding.droneId);
    // The purpose component is appended ONLY when present, so the unread-watermark
    // key (purpose absent) stays byte-identical to the pre-client#41 key — already
    // persisted watermarks are not orphaned by the upgrade. The 'stream' delivery
    // cursor gets a distinct key.
    if (binding.purpose) {
        hash.update('\0').update(binding.purpose);
    }
    return hash.digest('hex');
}
function validCursor(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return false;
    const cursor = value;
    return UUID_RE.test(String(cursor.id ?? '')) &&
        typeof cursor.created_at === 'string' &&
        Number.isFinite(Date.parse(cursor.created_at)) &&
        new Date(cursor.created_at).toISOString() === cursor.created_at;
}
async function readState() {
    try {
        const parsed = JSON.parse(await readFile(CURSOR_FILE, 'utf8'));
        if (parsed.version !== 1 ||
            typeof parsed.cursors !== 'object' ||
            parsed.cursors === null ||
            Array.isArray(parsed.cursors) ||
            Object.values(parsed.cursors).some((cursor) => !validCursor(cursor))) {
            throw new Error('invalid');
        }
        return parsed;
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { version: 1, cursors: {} };
        }
        throw new Error('local Borg server cursor state is corrupt');
    }
}
async function writeState(state) {
    await mkdir(dirname(CURSOR_FILE), { recursive: true });
    const temporary = `${CURSOR_FILE}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, CURSOR_FILE);
}
async function withLock(operation) {
    await mkdir(dirname(CURSOR_LOCK), { recursive: true });
    for (let attempt = 0; attempt < 200; attempt += 1) {
        let handle;
        try {
            handle = await open(CURSOR_LOCK, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            try {
                const metadata = await stat(CURSOR_LOCK);
                if (Date.now() - metadata.mtimeMs > 30_000) {
                    await unlink(CURSOR_LOCK);
                    continue;
                }
            }
            catch (inspectionError) {
                if (inspectionError.code === 'ENOENT')
                    continue;
                throw inspectionError;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
            continue;
        }
        try {
            return await operation();
        }
        finally {
            await handle.close();
            try {
                await unlink(CURSOR_LOCK);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
    }
    throw new Error('local Borg server cursor state is busy');
}
export async function getLocalServerCursor(binding) {
    const key = cursorKey(binding);
    const state = await readState();
    return state.cursors[key] ?? null;
}
export async function advanceLocalServerCursor(binding, cursor) {
    if (!validCursor(cursor))
        throw new Error('invalid local Borg server cursor');
    const key = cursorKey(binding);
    await withLock(async () => {
        const state = await readState();
        const prior = state.cursors[key];
        if (prior &&
            (prior.created_at > cursor.created_at ||
                (prior.created_at === cursor.created_at && prior.id >= cursor.id))) {
            return;
        }
        state.cursors[key] = cursor;
        await writeState(state);
    });
}
/**
 * client#42: reset (delete) a persisted cursor for `binding`. Used by the SSE
 * recovery path when the server returns 410 CURSOR_EXPIRED for the stream's
 * resume cursor — the pointed-at entry has been pruned server-side, so the
 * stale cursor can never be resumed and must be cleared, letting the next
 * stream connect re-establish from a fresh valid point (the current tail)
 * instead of looping forever on the dead cursor. No-op when no cursor is
 * stored for the binding.
 */
export async function clearLocalServerCursor(binding) {
    const key = cursorKey(binding);
    await withLock(async () => {
        const state = await readState();
        if (!(key in state.cursors))
            return;
        delete state.cursors[key];
        await writeState(state);
    });
}
export function encodeLocalServerCursor(cursor) {
    if (!validCursor(cursor))
        throw new Error('invalid local Borg server cursor');
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}
//# sourceMappingURL=local-server-cursor.js.map