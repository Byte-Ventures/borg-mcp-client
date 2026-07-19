export interface LocalServerCursor {
    id: string;
    created_at: string;
}
export interface LocalServerCursorBinding {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    droneId: string;
    /**
     * client#41: cursor-purpose namespace. Absent (the default) is the UNREAD
     * WATERMARK — the point `read-log unread_only` reads from and advances only
     * on an explicit successful drain. `'stream'` is the SSE DELIVERY/RESUME
     * cursor the live tail advances as it delivers events. Keeping these under
     * separate keys stops SSE delivery from consuming the unread watermark (a
     * wake-triggering entry would otherwise disappear from `unread_only` before
     * the agent drained it — a silent missed wake).
     */
    purpose?: 'stream';
}
export declare function getLocalServerCursor(binding: LocalServerCursorBinding): Promise<LocalServerCursor | null>;
export declare function advanceLocalServerCursor(binding: LocalServerCursorBinding, cursor: LocalServerCursor): Promise<void>;
export declare function encodeLocalServerCursor(cursor: LocalServerCursor): string;
//# sourceMappingURL=local-server-cursor.d.ts.map