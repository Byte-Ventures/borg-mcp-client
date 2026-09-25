/** Private per-binding DELIVERED checkpoint and read fence for the representative. */
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { atomicWrite0600, readStoreFile } from './seat-store.js';
import type { LocalServerCursor } from './local-server-cursor.js';
import { bindingFingerprint, isRepresentativeUuid, type RepresentativeBinding } from './representative-store.js';
import { validatePrivateDirectory } from './representative-listener-store.js';

/**
 * `checkpoint`: the host's durable delivery point; only `deliver` moves it.
 * `readThrough`: the highest entry any `read` returned; `deliver` may not pass it.
 */
export interface DeliveryState {
  checkpoint: LocalServerCursor | null;
  readThrough: LocalServerCursor | null;
}

export function deliveryPaths(binding: RepresentativeBinding) {
  const directory = join(borgConfigRoot(), 'representative-delivery', bindingFingerprint(binding));
  return { directory, file: join(directory, 'checkpoint.json') };
}

function point(value: unknown): LocalServerCursor | null {
  if (value === null) return null;
  const candidate = value as { id?: unknown; created_at?: unknown } | undefined;
  if (!isRepresentativeUuid(candidate?.id) || typeof candidate?.created_at !== 'string' ||
      !Number.isFinite(Date.parse(candidate.created_at))) {
    throw new Error('Representative delivery checkpoint is invalid');
  }
  return { id: candidate.id, created_at: candidate.created_at };
}

/** (created_at, id) order, the server log order. */
export function comparePoints(a: LocalServerCursor, b: LocalServerCursor | null): number {
  if (b === null) return 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

// One queue per state file: overlapping tool calls in one process never write
// from a stale load. Other processes are excluded by the tools lease.
const queues = new Map<string, Promise<unknown>>();

const later = (a: LocalServerCursor | null, b: LocalServerCursor | null) =>
  a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;

export function createDeliveryStore(binding: RepresentativeBinding) {
  const paths = deliveryPaths(binding);
  const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
  const load = async (): Promise<DeliveryState | null> => {
    if (!await validatePrivateDirectory(paths.directory, false)) return null;
    const raw = await readStoreFile(paths.file, options);
    if (raw === null) return null;
    let parsed: { version?: unknown; checkpoint?: unknown; readThrough?: unknown };
    try { parsed = JSON.parse(raw); } catch { throw new Error('Representative delivery checkpoint is invalid'); }
    if (parsed?.version !== 1) throw new Error('Representative delivery checkpoint is invalid');
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
    advance(update: Partial<DeliveryState>, guard?: () => Promise<void>): Promise<DeliveryState> {
      const run = async () => {
        const current = await load();
        const next = {
          checkpoint: later(current?.checkpoint ?? null, update.checkpoint ?? null),
          readThrough: later(current?.readThrough ?? null, update.readThrough ?? null),
        };
        if (current && JSON.stringify(current) === JSON.stringify(next)) return current;
        await guard?.();
        await validatePrivateDirectory(paths.directory, true);
        await atomicWrite0600(paths.file, JSON.stringify({ version: 1, ...next }) + '\n', options);
        return next;
      };
      const result = (queues.get(paths.file) ?? Promise.resolve()).then(run, run);
      queues.set(paths.file, result.catch(() => {}));
      return result;
    },
  };
}
