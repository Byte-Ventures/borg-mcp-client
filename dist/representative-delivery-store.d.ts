/**
 * The representative's DELIVERED checkpoint and read window, per binding
 * generation, in the representative state database.
 *
 * - `start`: where this generation's history begins (the imported 5.x
 *   checkpoint, the server head, or the binding start; 'head-pending' until an
 *   imported generation's first use resolves it). Scans never consider entries
 *   at or before it.
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
    /**
     * The newest log position on the bound server, null for an empty log, or
     * 'unbounded' when it could not be reached in a bounded read. Called outside
     * any transaction.
     */
    serverHead(): Promise<LocalServerCursor | null | 'unbounded'>;
    /** Cancels the head step: no transaction runs after it fires. */
    signal?: AbortSignal;
}
/**
 * Make sure the binding's generation has a resolved delivery row. The binding
 * row must already exist (prepare, or the one-time 5.x import when the state was
 * created); this never reads 5.x files.
 * - A prepared generation without a row starts at its binding start.
 * - An imported 5.x generation left 'head-pending' (no 5.x history for its
 *   seat) starts at the server head, read outside any transaction; if another
 *   generation of the seat has delivery state by the time it is written, or
 *   the head cannot be reached in a bounded read (a very long or fast-growing
 *   log), it starts at the binding start instead (replays, never skips).
 */
export declare function ensureDeliveryState(ctx: EnsureStateContext): Promise<void>;
//# sourceMappingURL=representative-delivery-store.d.ts.map