/** Private per-binding DELIVERED checkpoint and read fence for the representative. */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { atomicWrite0600, readStoreFile } from './seat-store.js';
import { bindingFingerprint, isRepresentativeUuid } from './representative-store.js';
import { validatePrivateDirectory } from './representative-listener-store.js';
const deliveryRoot = () => join(borgConfigRoot(), 'representative-delivery');
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
export function createDeliveryStore(binding) {
    const paths = deliveryPaths(binding);
    const seat = seatKey(binding);
    const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
    const load = async () => (await readFile(paths.directory, paths.file))?.state ?? null;
    return {
        /** Null when this binding generation has no checkpoint yet. A corrupt file fails closed. */
        load,
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