import { type RepresentativeBinding } from './representative-store.js';
import type { LocalServerCursor } from './local-server-cursor.js';
export declare function legacyStorePath(): string;
/** The 5.x per-seat key: the same fields as the client unread-cursor key. */
export declare function seatKey(binding: Pick<RepresentativeBinding, 'origin' | 'trustIdentity' | 'cubeId' | 'representativeDroneId'>): string;
/** The worktree's 5.x binding, or null. An unreadable or invalid file yields null (not prepared). */
export declare function readLegacyBinding(worktree: string): Promise<RepresentativeBinding | null>;
/** Every 5.x binding (for listings). Unreadable input yields none. */
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
export {};
//# sourceMappingURL=representative-legacy.d.ts.map