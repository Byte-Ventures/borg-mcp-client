import type { LocalServerCursor } from './local-server-cursor.js';
import { type RepresentativeBinding } from './representative-store.js';
/**
 * `checkpoint`: the host's durable delivery point; only `deliver` moves it.
 * `readThrough`: the highest entry any `read` returned; `deliver` may not pass it.
 */
export interface DeliveryState {
    checkpoint: LocalServerCursor | null;
    readThrough: LocalServerCursor | null;
}
/**
 * This binding's own checkpoint file exists but cannot be trusted. It is never
 * used and never silently reset: every tool except status refuses until the
 * operator inspects and removes it.
 */
export declare class DeliveryCheckpointError extends Error {
    readonly code = "REPRESENTATIVE_CHECKPOINT_INVALID";
    constructor(file: string, reason: string);
}
export declare function deliveryPaths(binding: RepresentativeBinding): {
    directory: string;
    file: string;
};
/** (created_at, id) order, the server log order. */
export declare function comparePoints(a: LocalServerCursor, b: LocalServerCursor | null): number;
/**
 * The one-time upgrade tombstone for a seat. Its existence alone means the
 * legacy import was attempted; nothing in it is ever read back as a position.
 * Its directory name is not 64 hex characters, so the generation scan never
 * mistakes it for a checkpoint.
 */
export declare function createDeliveryStore(binding: RepresentativeBinding): {
    /** Null when this binding generation has no checkpoint yet. A corrupt file fails closed. */
    load: () => Promise<DeliveryState | null>;
    /**
     * Whether the seat's upgrade tombstone exists. Any object at that path,
     * readable or not, counts, so a planted or damaged marker can only cause a
     * replay (duplicates), never an import or a skip.
     */
    migrated(): Promise<boolean>;
    /**
     * Create the tombstone exclusively (O_EXCL, no-follow, 0600, fsynced).
     * False when it already exists: another initializer got there first.
     * `guard` runs just before the create.
     */
    markMigrated(guard?: () => Promise<void>): Promise<boolean>;
    /**
     * Run a first-call initialization alone for this seat within the process:
     * overlapping first reads see each other's result instead of both
     * importing. Other processes are excluded by the tools lease, and the
     * exclusive tombstone create backs that up.
     */
    initialize<T>(operation: () => Promise<T>): Promise<T>;
    /**
     * Whether any other generation of this seat already has a checkpoint, which
     * means the one-time upgrade from the unread cursor already happened. An
     * unreadable or unsafe sibling counts as one: the new generation then
     * replays its history (duplicates, never loss) instead of trusting it.
     */
    otherGenerationExists(): Promise<boolean>;
    /**
     * Move either field forward only, from the state on disk at write time, in
     * one atomic durable 0600 write. Always writes when no file exists yet, so a
     * completed migration is never repeated. `guard` runs just before the write.
     * Returns the states before and after, so callers report the real transition.
     */
    advance(update: Partial<DeliveryState>, guard?: () => Promise<void>): Promise<{
        before: DeliveryState | null;
        after: DeliveryState;
    }>;
};
//# sourceMappingURL=representative-delivery-store.d.ts.map