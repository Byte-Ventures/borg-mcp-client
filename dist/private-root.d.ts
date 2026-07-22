export declare const borgConfigRoot: () => string;
export declare function isBorgConfigPath(candidate: string): boolean;
export interface PrivateBorgConfigRoot {
    path: string;
    verify(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Opens and validates the Borg-owned root for a single-user host. Static unsafe
 * filesystem objects and detected identity drift fail closed. Node has no
 * cross-platform openat/renameat API, so an actively malicious same-uid process
 * that swaps an ancestor after the final check is outside this boundary; it
 * already has authority to read and replace this user's 0600 state directly.
 */
export declare function ensurePrivateBorgConfigRoot(): Promise<PrivateBorgConfigRoot>;
//# sourceMappingURL=private-root.d.ts.map