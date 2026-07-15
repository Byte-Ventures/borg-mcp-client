export interface LocalServerCursor {
    id: string;
    created_at: string;
}
export interface LocalServerCursorBinding {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    droneId: string;
}
export declare function getLocalServerCursor(binding: LocalServerCursorBinding): Promise<LocalServerCursor | null>;
export declare function advanceLocalServerCursor(binding: LocalServerCursorBinding, cursor: LocalServerCursor): Promise<void>;
export declare function encodeLocalServerCursor(cursor: LocalServerCursor): string;
//# sourceMappingURL=local-server-cursor.d.ts.map