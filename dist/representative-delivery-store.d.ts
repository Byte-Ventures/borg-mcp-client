/**
 * The representative's DELIVERED checkpoint and read window, per binding
 * generation, in the representative state database.
 *
 * - `start`: where this generation's history begins (the imported 5.x
 *   checkpoint, the server head, or the binding start). Scans never consider
 *   entries at or before it.
 * - `checkpoint`: the host's durable delivery point; only `deliver` moves it.
 * - `readThrough`: the highest entry any `read` returned; `deliver` may not pass it.
 * - `returned`: entries a read returned since the checkpoint last moved;
 *   `deliver` checks membership of the full (id, created_at) tuple here.
 *
 * Every function taking a `Transaction` runs inside one representative state
 * transaction; callers check the binding generation in that same transaction.
 */
import type { Transaction } from './representative-db.js';
import type { LocalServerCursor } from './local-server-cursor.js';
import { type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
export type StartKind = 'checkpoint' | 'head' | 'binding';
export interface DeliveryState {
    start: LocalServerCursor;
    startKind: StartKind;
    checkpoint: LocalServerCursor | null;
    readThrough: LocalServerCursor | null;
    returned: LocalServerCursor[];
}
/** (created_at, id) order, the server log order. */
export declare function comparePoints(a: LocalServerCursor, b: LocalServerCursor | null): number;
export declare function loadDelivery(db: Transaction, generation: string): DeliveryState | null;
/**
 * Where a scan starts: the server cursor (null = the log start) and the floor
 * every entry must exceed. A binding start is a synthetic lower bound that is
 * never sent to the server as a cursor.
 */
export declare function scanStart(state: DeliveryState): {
    cursor: LocalServerCursor | null;
    floor: LocalServerCursor;
};
/** Widen the read fence and the returned set (monotonic; pruned to entries after the checkpoint). */
export declare function widenReadWindow(db: Transaction, generation: string, window: LocalServerCursor[]): void;
/** Move the delivered checkpoint forward (never back); prunes the returned set and wake records. */
export declare function advanceCheckpoint(db: Transaction, generation: string, to: LocalServerCursor): {
    before: DeliveryState;
    after: DeliveryState;
};
export interface EnsureStateContext {
    binding: RepresentativeBinding;
    store: RepresentativeStore;
    /** The newest log position on the bound server, or null for an empty log. Called outside any transaction. */
    serverHead(): Promise<LocalServerCursor | null>;
}
/**
 * Make sure the binding's generation has its binding row and delivery row,
 * creating them on first use with the start rule:
 *   1. a valid 5.x checkpoint for this generation, non-null → that checkpoint;
 *   2. a valid 5.x checkpoint that is null → the binding start;
 *   3. history enumerable and empty (no tombstone, no checkpoint for any
 *      generation of the seat in 5.x files or in this database) → the server
 *      head (the binding start for an empty log);
 *   4. anything else → the binding start (replays; never skips).
 * Network and file reads run before the creating transaction, which re-checks
 * only local facts.
 */
export declare function ensureDeliveryState(ctx: EnsureStateContext): Promise<void>;
//# sourceMappingURL=representative-delivery-store.d.ts.map