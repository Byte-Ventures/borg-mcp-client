/**
 * The only reads of borgmcp 5.x representative files (decision
 * clean-slate-no-backwards-compat): when 6.x first creates a worktree's state
 * it reads that worktree's binding and decides the delivery start from the 5.x
 * delivered checkpoint, the seat tombstone and sibling generations. Nothing
 * here writes, and nothing else ever reads these files.
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
/** The worktree's 5.x binding, or null. An unreadable or invalid file yields null (not prepared). */
export async function readLegacyBinding(worktree) {
    let raw;
    try {
        raw = await readCapped(legacyStorePath(), borgConfigRoot());
    }
    catch {
        return null;
    }
    if (raw === null)
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed?.version !== 1 || parsed.bindings === null || typeof parsed.bindings !== 'object')
            return null;
        return parseBinding(parsed.bindings[worktree], worktree);
    }
    catch {
        return null;
    }
}
/** Every 5.x binding (for listings). Unreadable input yields none. */
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
//# sourceMappingURL=representative-legacy.js.map