/**
 * The only reads of borgmcp 5.x representative files (decision
 * clean-slate-no-backwards-compat). They run once, when 6.x creates the state
 * database's FIRST generation (`legacySeed`): every valid 5.x binding becomes a
 * 'legacy' row, and its delivery start is decided from the 5.x delivered
 * checkpoint, the seat tombstone and sibling generations. Nothing here writes
 * 5.x files, and no other code path reads them — not status, not a lookup, not
 * after a reset.
 *
 * Every file read uses the private-file checks of the 5.x loaders: a secure
 * root, lstat, no-follow, owner, mode, a regular file and a size cap.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { readStoreFile } from './seat-store.js';
import { validatePrivateDirectory } from './representative-listener-store.js';
import { bindingFingerprint, isRepresentativeUuid, parseBinding } from './representative-store.js';
import { insertBindingRow } from './representative-store.js';
const LEGACY_FILE_CAP_BYTES = 1024 * 1024;
export function legacyStorePath() {
    return join(borgConfigRoot(), 'representative.json');
}
function legacyDeliveryRoot() {
    return join(borgConfigRoot(), 'representative-delivery');
}
/** The 5.x per-seat key: the same fields as the client unread-cursor key. */
export function seatKey(binding) {
    return createHash('sha256').update(JSON.stringify([
        binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId,
    ])).digest('hex');
}
async function readCapped(path, secureRoot) {
    try {
        const metadata = await lstat(path);
        if (metadata.isFile() && metadata.size > LEGACY_FILE_CAP_BYTES)
            throw new Error(`${path} exceeds ${LEGACY_FILE_CAP_BYTES} bytes`);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    return readStoreFile(path, { secureRoot, verifyLeafIdentity: true, createRoot: false });
}
/** Every valid 5.x binding. Unreadable input yields none (those worktrees are not prepared). */
export async function readLegacyBindings() {
    let raw;
    try {
        raw = await readCapped(legacyStorePath(), borgConfigRoot());
    }
    catch {
        return [];
    }
    if (raw === null)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || parsed.bindings === null || typeof parsed.bindings !== 'object')
            return [];
        return Object.entries(parsed.bindings)
            .map(([key, value]) => parseBinding(value, key))
            .filter((binding) => binding !== null);
    }
    catch {
        return [];
    }
}
function parsePoint(value) {
    if (value === null)
        return null;
    const candidate = value;
    if (!isRepresentativeUuid(candidate?.id) || typeof candidate?.created_at !== 'string' ||
        !Number.isFinite(Date.parse(candidate.created_at))) {
        throw new Error('invalid point');
    }
    return { id: candidate.id, created_at: candidate.created_at };
}
async function readCheckpointFile(directory, seat) {
    try {
        if (!await validatePrivateDirectory(directory, false))
            return { kind: 'absent' };
    }
    catch {
        return { kind: 'invalid' };
    }
    let raw;
    try {
        raw = await readCapped(join(directory, 'checkpoint.json'), directory);
    }
    catch {
        return { kind: 'invalid' };
    }
    if (raw === null)
        return { kind: 'absent' };
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || typeof parsed.seat !== 'string')
            return { kind: 'invalid' };
        if (seat !== null && parsed.seat !== seat)
            return { kind: 'invalid' };
        const checkpoint = parsePoint(parsed.checkpoint ?? null);
        const readThrough = parsePoint(parsed.readThrough ?? null);
        if (checkpoint && (readThrough === null || checkpoint.created_at > readThrough.created_at ||
            (checkpoint.created_at === readThrough.created_at && checkpoint.id > readThrough.id))) {
            return { kind: 'invalid' };
        }
        return { kind: 'valid', seat: parsed.seat, checkpoint };
    }
    catch {
        return { kind: 'invalid' };
    }
}
/**
 * What 5.x delivery left for this binding's generation and seat.
 * - `checkpoint`: the current generation's checkpoint file (absent, valid, invalid).
 * - `history`: 'empty' only when the delivery root is absent or listable, no
 *   seat tombstone exists and no sibling generation names this seat;
 *   'present' when one exists; 'unknown' when anything cannot be read. Unknown
 *   is never treated as absent.
 */
export async function readLegacyDelivery(binding) {
    const root = legacyDeliveryRoot();
    const seat = seatKey(binding);
    const own = bindingFingerprint(binding);
    const checkpoint = await readCheckpointFile(join(root, own), seat);
    let rootPresent;
    try {
        rootPresent = await validatePrivateDirectory(root, false);
    }
    catch {
        return { checkpoint, history: 'unknown' };
    }
    if (!rootPresent) {
        try {
            await lstat(root);
            return { checkpoint, history: 'unknown' }; // present but not a safe directory
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                return { checkpoint, history: 'unknown' };
            return { checkpoint, history: 'empty' };
        }
    }
    let names;
    try {
        names = await readdir(root);
    }
    catch {
        return { checkpoint, history: 'unknown' };
    }
    let unknown = false;
    const tombstone = `seat-${seat}`;
    if (names.includes(tombstone))
        return { checkpoint, history: 'present' };
    for (const name of names) {
        if (!/^[0-9a-f]{64}$/.test(name) || name === own)
            continue;
        const sibling = await readCheckpointFile(join(root, name), null);
        if (sibling.kind === 'valid' && sibling.seat === seat)
            return { checkpoint, history: 'present' };
        if (sibling.kind === 'invalid')
            unknown = true;
    }
    if (checkpoint.kind !== 'absent')
        return { checkpoint, history: 'present' };
    return { checkpoint, history: unknown ? 'unknown' : 'empty' };
}
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/**
 * The first generation's rows from 5.x state, gathered outside any transaction.
 * Each binding's delivery start:
 *   1. a valid non-null 5.x checkpoint for its generation: that checkpoint;
 *   2. a valid null checkpoint: the binding start;
 *   3. no 5.x history for the seat at all (enumerable and empty): the server
 *      head, resolved on first use ('head-pending', the network is never read
 *      here), or the binding start if the database has seat history by then;
 *   4. anything else, including unreadable history: the binding start.
 * A second worktree whose binding has the same generation is skipped.
 */
export async function legacySeed() {
    const imports = await Promise.all((await readLegacyBindings()).map(async (binding) => ({
        binding, delivery: await readLegacyDelivery(binding),
    })));
    return (db) => {
        const seen = new Set();
        const insert = db.prepare(`INSERT INTO delivery (generation, seat, start_id, start_at, start_kind, checkpoint_id, checkpoint_at,
      read_through_id, read_through_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const { binding, delivery } of imports) {
            const generation = bindingFingerprint(binding);
            if (seen.has(generation))
                continue;
            seen.add(generation);
            const seat = seatKey(binding);
            insertBindingRow(db, binding, seat, 'legacy');
            const checkpoint = delivery.checkpoint.kind === 'valid' ? delivery.checkpoint.checkpoint : null;
            const kind = checkpoint ? 'checkpoint'
                : delivery.checkpoint.kind !== 'valid' && delivery.history === 'empty' ? 'head-pending' : 'binding';
            const start = checkpoint ?? { id: NIL_UUID, created_at: binding.boundAt };
            insert.run(generation, seat, start.id, start.created_at, kind, checkpoint?.id ?? null, checkpoint?.created_at ?? null, checkpoint?.id ?? null, checkpoint?.created_at ?? null);
        }
    };
}
//# sourceMappingURL=representative-legacy.js.map