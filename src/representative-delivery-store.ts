/** Private per-binding DELIVERED checkpoint and read fence for the representative. */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
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

const deliveryRoot = () => join(borgConfigRoot(), 'representative-delivery');

/**
 * This binding's own checkpoint file exists but cannot be trusted. It is never
 * used and never silently reset: every tool except status refuses until the
 * operator inspects and removes it.
 */
export class DeliveryCheckpointError extends Error {
  readonly code = 'REPRESENTATIVE_CHECKPOINT_INVALID';
  constructor(file: string, reason: string) {
    super(`The representative delivery checkpoint ${file} is invalid (${reason}). Nothing was read or delivered. ` +
      'Inspect the file and remove it; the next read then replays every addressed reply from the start.');
    this.name = 'DeliveryCheckpointError';
  }
}

export function deliveryPaths(binding: RepresentativeBinding) {
  const directory = join(deliveryRoot(), bindingFingerprint(binding));
  return { directory, file: join(directory, 'checkpoint.json') };
}

/**
 * The seat every generation of a binding shares: the same fields as the
 * client unread-cursor key, without Coordinator or boundAt.
 */
function seatKey(binding: RepresentativeBinding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId,
  ])).digest('hex');
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

async function readFile(directory: string, file: string): Promise<{ seat: string; state: DeliveryState } | null> {
  if (!await validatePrivateDirectory(directory, false)) return null;
  const raw = await readStoreFile(file, { secureRoot: directory, verifyLeafIdentity: true, createRoot: false });
  if (raw === null) return null;
  let parsed: { version?: unknown; seat?: unknown; checkpoint?: unknown; readThrough?: unknown };
  try { parsed = JSON.parse(raw); } catch { throw new Error('Representative delivery checkpoint is invalid'); }
  if (parsed?.version !== 1 || typeof parsed.seat !== 'string') throw new Error('Representative delivery checkpoint is invalid');
  return { seat: parsed.seat, state: { checkpoint: point(parsed.checkpoint), readThrough: point(parsed.readThrough) } };
}

// One queue per state file: overlapping tool calls in one process never write
// from a stale load. Other processes are excluded by the tools lease.
const queues = new Map<string, Promise<unknown>>();

const later = (a: LocalServerCursor | null, b: LocalServerCursor | null) =>
  a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;

/**
 * The one-time upgrade record for a seat: the legacy unread cursor as it was
 * read, stored before it is used. `complete` flips once the first checkpoint is
 * written. Its directory name is not 64 hex characters, so the generation scan
 * never mistakes it for a checkpoint.
 */
export interface MigrationMarker {
  cursor: LocalServerCursor | null;
  complete: boolean;
}

export function createDeliveryStore(binding: RepresentativeBinding) {
  const paths = deliveryPaths(binding);
  const seat = seatKey(binding);
  const marker = { directory: join(deliveryRoot(), `seat-${seat}`), file: join(deliveryRoot(), `seat-${seat}`, 'migration.json') };
  const markerOptions = { secureRoot: marker.directory, verifyLeafIdentity: true, createRoot: false };
  const options = { secureRoot: paths.directory, verifyLeafIdentity: true, createRoot: false };
  const load = async (): Promise<DeliveryState | null> => {
    let saved;
    try {
      saved = await readFile(paths.directory, paths.file);
    } catch (error) {
      throw new DeliveryCheckpointError(paths.file, error instanceof Error ? error.message : 'unreadable');
    }
    if (!saved) return null;
    if (saved.seat !== seat) throw new DeliveryCheckpointError(paths.file, 'it belongs to another representative seat');
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
     * The seat's migration marker; null when the upgrade never started. An
     * unreadable, unsafe or foreign marker reads as complete, so the outcome is
     * replay from the start (duplicates), never a second import.
     */
    async readMarker(): Promise<MigrationMarker | null> {
      try {
        if (!await validatePrivateDirectory(marker.directory, false)) return null;
        const raw = await readStoreFile(marker.file, markerOptions);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { version?: unknown; seat?: unknown; cursor?: unknown; complete?: unknown };
        if (parsed?.version !== 1 || parsed.seat !== seat || typeof parsed.complete !== 'boolean') {
          return { cursor: null, complete: true };
        }
        return { cursor: point(parsed.cursor), complete: parsed.complete };
      } catch {
        return { cursor: null, complete: true };
      }
    },
    /** One atomic durable 0600 write of the marker; `guard` runs just before it. */
    async writeMarker(value: MigrationMarker, guard?: () => Promise<void>): Promise<void> {
      await guard?.();
      await validatePrivateDirectory(marker.directory, true);
      await atomicWrite0600(marker.file, JSON.stringify({ version: 1, seat, ...value }) + '\n', markerOptions);
    },
    /**
     * Whether any other generation of this seat already has a checkpoint, which
     * means the one-time upgrade from the unread cursor already happened. An
     * unreadable or unsafe sibling counts as one: the new generation then
     * replays its history (duplicates, never loss) instead of trusting it.
     */
    async otherGenerationExists(): Promise<boolean> {
      if (!await validatePrivateDirectory(deliveryRoot(), false)) return false;
      const own = bindingFingerprint(binding);
      for (const name of await readdir(deliveryRoot())) {
        if (name === own || !/^[0-9a-f]{64}$/.test(name)) continue;
        const directory = join(deliveryRoot(), name);
        try {
          if ((await readFile(directory, join(directory, 'checkpoint.json')))?.seat === seat) return true;
        } catch {
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
    advance(update: Partial<DeliveryState>, guard?: () => Promise<void>): Promise<{ before: DeliveryState | null; after: DeliveryState }> {
      const run = async () => {
        const before = await load();
        const after = {
          checkpoint: later(before?.checkpoint ?? null, update.checkpoint ?? null),
          readThrough: later(before?.readThrough ?? null, update.readThrough ?? null),
        };
        if (before && JSON.stringify(before) === JSON.stringify(after)) return { before, after: before };
        await guard?.();
        await validatePrivateDirectory(paths.directory, true);
        await atomicWrite0600(paths.file, JSON.stringify({ version: 1, seat, ...after }) + '\n', options);
        return { before, after };
      };
      const result = (queues.get(paths.file) ?? Promise.resolve()).then(run, run);
      queues.set(paths.file, result.catch(() => {}));
      return result;
    },
  };
}
