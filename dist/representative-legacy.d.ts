import { type RepresentativeBinding } from './representative-store.js';
import type { LocalServerCursor } from './local-server-cursor.js';
import type { Transaction } from './representative-db.js';
export declare function legacyStorePath(): string;
/** The 5.x per-seat key: the same fields as the client unread-cursor key. */
export declare function seatKey(binding: Pick<RepresentativeBinding, 'origin' | 'trustIdentity' | 'cubeId' | 'representativeDroneId'>): string;
/** Every valid 5.x binding. Unreadable input yields none (those worktrees are not prepared). */
export declare function readLegacyBindings(): Promise<RepresentativeBinding[]>;
type CheckpointRead = {
    kind: 'absent';
} | {
    kind: 'valid';
    seat: string;
    checkpoint: LocalServerCursor | null;
} | {
    kind: 'invalid';
};
/**
 * What 5.x delivery left for this binding's generation and seat.
 * - `checkpoint`: the current generation's checkpoint file (absent, valid, invalid).
 * - `history`: 'empty' only when the delivery root is absent or listable, no
 *   seat tombstone exists and no sibling generation names this seat;
 *   'present' when one exists; 'unknown' when anything cannot be read. Unknown
 *   is never treated as absent.
 */
export declare function readLegacyDelivery(binding: RepresentativeBinding): Promise<{
    checkpoint: CheckpointRead;
    history: 'empty' | 'present' | 'unknown';
}>;
/** The 5.x bindings an import keeps: the first of each binding generation. */
export declare function importedLegacyBindings(bindings: RepresentativeBinding[]): RepresentativeBinding[];
/**
 * Read-only preview of what the first-generation import would bind: the same
 * files, parsing and deduplication as legacySeed, and nothing is created.
 */
export declare function previewLegacyImport(): Promise<RepresentativeBinding[]>;
/**
 * The first generation's rows from 5.x state, gathered outside any transaction.
 * Each binding's delivery start:
 *   1. a valid non-null 5.x checkpoint for its generation: that checkpoint;
 *   2. a valid null checkpoint: the binding start;
 *   3. no 5.x history for the seat at all (enumerable and empty): the server
 *      head, resolved on first use ('head-pending', the network is never read
 *      here), or the binding start if the database has seat history by then;
 *   4. anything else, including unreadable history: the binding start.
 * A second worktree whose binding has the same generation is skipped.
 */
export declare function legacySeed(): Promise<(db: Transaction) => void>;
export {};
//# sourceMappingURL=representative-legacy.d.ts.map