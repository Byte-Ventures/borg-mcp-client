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
export declare function createDeliveryStore(binding: RepresentativeBinding): {
    /** Null when this binding generation has no checkpoint yet. A corrupt file fails closed. */
    load: () => Promise<DeliveryState | null>;
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