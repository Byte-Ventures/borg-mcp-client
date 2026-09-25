/** Private per-binding DELIVERED checkpoint and read fence for the representative. */
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { atomicWrite0600, readStoreFile } from './seat-store.js';
import { bindingFingerprint, isRepresentativeUuid } from './representative-store.js';
import { validatePrivateDirectory } from './representative-listener-store.js';
export function deliveryPaths(binding) {
    const directory = join(borgConfigRoot(), 'representative-delivery', bindingFingerprint(binding));
    return { directory, file: join(directory, 'checkpoint.json') };
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
// One queue per state file: overlapping tool calls in one process never write
// from a stale load. Other processes are excluded by the tools lease.
const queues = new Map();
const later = (a, b) => a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;
export function createDeliveryStore(binding) {
    const paths = deliveryPaths(binding);
    const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
    const load = async () => {
        if (!await validatePrivateDirectory(paths.directory, false))
            return null;
        const raw = await readStoreFile(paths.file, options);
        if (raw === null)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('Representative delivery checkpoint is invalid');
        }
        if (parsed?.version !== 1)
            throw new Error('Representative delivery checkpoint is invalid');
        return { checkpoint: point(parsed.checkpoint), readThrough: point(parsed.readThrough) };
    };
    return {
        /** Null when this binding generation has no checkpoint yet. A corrupt file fails closed. */
        load,
        /**
         * Move either field forward only, from the state on disk at write time, in
         * one atomic durable 0600 write. Always writes when no file exists yet, so a
         * completed migration is never repeated. `guard` runs just before the write.
         */
        advance(update, guard) {
            const run = async () => {
                const current = await load();
                const next = {
                    checkpoint: later(current?.checkpoint ?? null, update.checkpoint ?? null),
                    readThrough: later(current?.readThrough ?? null, update.readThrough ?? null),
                };
                if (current && JSON.stringify(current) === JSON.stringify(next))
                    return current;
                await guard?.();
                await validatePrivateDirectory(paths.directory, true);
                await atomicWrite0600(paths.file, JSON.stringify({ version: 1, ...next }) + '\n', options);
                return next;
            };
            const result = (queues.get(paths.file) ?? Promise.resolve()).then(run, run);
            queues.set(paths.file, result.catch(() => { }));
            return result;
        },
    };
}
//# sourceMappingURL=representative-delivery-store.js.map