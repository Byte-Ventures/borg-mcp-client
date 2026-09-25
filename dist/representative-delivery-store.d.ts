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
     * Move either field forward only, from the state on disk at write time, in
     * one atomic durable 0600 write. Always writes when no file exists yet, so a
     * completed migration is never repeated. `guard` runs just before the write.
     */
    advance(update: Partial<DeliveryState>, guard?: () => Promise<void>): Promise<DeliveryState>;
};
//# sourceMappingURL=representative-delivery-store.d.ts.map