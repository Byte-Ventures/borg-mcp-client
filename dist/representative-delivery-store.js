/** Private per-binding DELIVERED checkpoint and read fence for the representative. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { atomicWrite0600, readStoreFile } from './seat-store.js';
import { bindingFingerprint, isRepresentativeUuid } from './representative-store.js';
import { validatePrivateDirectory } from './representative-listener-store.js';
const deliveryRoot = () => join(borgConfigRoot(), 'representative-delivery');
/**
 * This binding's own checkpoint file exists but cannot be trusted. It is never
 * used and never silently reset: every tool except status refuses until the
 * operator inspects and removes it.
 */
export class DeliveryCheckpointError extends Error {
    code = 'REPRESENTATIVE_CHECKPOINT_INVALID';
    constructor(file, reason) {
        super(`The representative delivery checkpoint ${file} is invalid (${reason}). Nothing was read or delivered. ` +
            'Inspect the file and remove it; the next read then replays every addressed reply from the start.');
        this.name = 'DeliveryCheckpointError';
    }
}
export function deliveryPaths(binding) {
    const directory = join(deliveryRoot(), bindingFingerprint(binding));
    return { directory, file: join(directory, 'checkpoint.json') };
}
/**
 * The seat every generation of a binding shares: the same fields as the
 * client unread-cursor key, without Coordinator or boundAt.
 */
function seatKey(binding) {
    return createHash('sha256').update(JSON.stringify([
        binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId,
    ])).digest('hex');
}
function point(value) {
    if (value === null)
        return null;
    const candidate = value;
    if (!isRepresentativeUuid(candidate?.id) || typeof candidate?.created_at !== 'string' ||
        !Number.isFinite(Date.parse(candidate.created_at))) {
        throw new Error('Representative delivery checkpoint is invalid');
    }
    return { id: candidate.id, created_at: candidate.created_at };
}
/** (created_at, id) order, the server log order. */
export function comparePoints(a, b) {
    if (b === null)
        return 1;
    if (a.created_at !== b.created_at)
        return a.created_at < b.created_at ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}
async function readFile(directory, file) {
    if (!await validatePrivateDirectory(directory, false))
        return null;
    const raw = await readStoreFile(file, { secureRoot: directory, verifyLeafIdentity: true, createRoot: false });
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error('Representative delivery checkpoint is invalid');
    }
    if (parsed?.version !== 1 || typeof parsed.seat !== 'string')
        throw new Error('Representative delivery checkpoint is invalid');
    return { seat: parsed.seat, state: { checkpoint: point(parsed.checkpoint), readThrough: point(parsed.readThrough) } };
}
// One queue per state file: overlapping tool calls in one process never write
// from a stale load. Other processes are excluded by the tools lease.
const queues = new Map();
const later = (a, b) => a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;
/**
 * The one-time upgrade tombstone for a seat. Its existence alone means the
 * legacy import was attempted; nothing in it is ever read back as a position.
 * Its directory name is not 64 hex characters, so the generation scan never
 * mistakes it for a checkpoint.
 */
export function createDeliveryStore(binding) {
    const paths = deliveryPaths(binding);
    const seat = seatKey(binding);
    const marker = { directory: join(deliveryRoot(), `seat-${seat}`), file: join(deliveryRoot(), `seat-${seat}`, 'migration.json') };
    const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
    const load = async () => {
        let saved;
        try {
            saved = await readFile(paths.directory, paths.file);
        }
        catch (error) {
            throw new DeliveryCheckpointError(paths.file, error instanceof Error ? error.message : 'unreadable');
        }
        if (!saved)
            return null;
        if (saved.seat !== seat)
            throw new DeliveryCheckpointError(paths.file, 'it belongs to another representative seat');
        const { checkpoint, readThrough } = saved.state;
        if (checkpoint && (readThrough === null || comparePoints(checkpoint, readThrough) > 0)) {
            throw new DeliveryCheckpointError(paths.file, 'its checkpoint is beyond its read fence');
        }
        return saved.state;
    };
    return {
        /** Null when this binding generation has no checkpoint yet. A corrupt file fails closed. */
        load,
        /**
         * Whether the seat's upgrade tombstone exists. Any object at that path,
         * readable or not, counts, so a planted or damaged marker can only cause a
         * replay (duplicates), never an import or a skip.
         */
        async migrated() {
            try {
                if (!await validatePrivateDirectory(marker.directory, false))
                    return false;
                await lstat(marker.file);
                return true;
            }
            catch (error) {
                return error.code !== 'ENOENT';
            }
        },
        /**
         * Create the tombstone exclusively (O_EXCL, no-follow, 0600, fsynced).
         * False when it already exists: another initializer got there first.
         * `guard` runs just before the create.
         */
        async markMigrated(guard) {
            await guard?.();
            await validatePrivateDirectory(marker.directory, true);
            let handle;
            try {
                handle = await open(marker.file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    return false;
                throw error;
            }
            try {
                await handle.writeFile(JSON.stringify({ version: 1, seat }) + '\n');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            return true;
        },
        /**
         * Run a first-call initialization alone for this seat within the process:
         * overlapping first reads see each other's result instead of both
         * importing. Other processes are excluded by the tools lease, and the
         * exclusive tombstone create backs that up.
         */
        initialize(operation) {
            const key = `seat:${seat}`;
            const result = (queues.get(key) ?? Promise.resolve()).then(operation, operation);
            queues.set(key, result.catch(() => { }));
            return result;
        },
        /**
         * Whether any other generation of this seat already has a checkpoint, which
         * means the one-time upgrade from the unread cursor already happened. An
         * unreadable or unsafe sibling counts as one: the new generation then
         * replays its history (duplicates, never loss) instead of trusting it.
         */
        async otherGenerationExists() {
            if (!await validatePrivateDirectory(deliveryRoot(), false))
                return false;
            const own = bindingFingerprint(binding);
            for (const name of await readdir(deliveryRoot())) {
                if (name === own || !/^[0-9a-f]{64}$/.test(name))
                    continue;
                const directory = join(deliveryRoot(), name);
                try {
                    if ((await readFile(directory, join(directory, 'checkpoint.json')))?.seat === seat)
                        return true;
                }
                catch {
                    return true;
                }
            }
            return false;
        },
        /**
         * Move either field forward only, from the state on disk at write time, in
         * one atomic durable 0600 write. Always writes when no file exists yet, so a
         * completed migration is never repeated. `guard` runs just before the write.
         * Returns the states before and after, so callers report the real transition.
         */
        advance(update, guard) {
            const run = async () => {
                const before = await load();
                const after = {
                    checkpoint: later(before?.checkpoint ?? null, update.checkpoint ?? null),
                    readThrough: later(before?.readThrough ?? null, update.readThrough ?? null),
                };
                if (before && JSON.stringify(before) === JSON.stringify(after))
                    return { before, after: before };
                await guard?.();
                await validatePrivateDirectory(paths.directory, true);
                await atomicWrite0600(paths.file, JSON.stringify({ version: 1, seat, ...after }) + '\n', options);
                return { before, after };
            };
            const result = (queues.get(paths.file) ?? Promise.resolve()).then(run, run);
            queues.set(paths.file, result.catch(() => { }));
            return result;
        },
    };
}
//# sourceMappingURL=representative-delivery-store.js.map