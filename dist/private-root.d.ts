export declare const borgConfigRoot: () => string;
export declare function isBorgConfigPath(candidate: string): boolean;
export interface PrivatePathIdentity {
    dev: number;
    ino: number;
    uid: number;
    mode: number;
}
export interface PrivateBorgConfigRoot {
    path: string;
    verify(): Promise<void>;
    ensureDirectory(directory: string): Promise<void>;
    readFile(filePath: string): Promise<string>;
    appendFile(filePath: string, data: string): Promise<void>;
    atomicWrite(filePath: string, data: string, mode?: number): Promise<void>;
    unlinkIfUnchanged(filePath: string, expected?: PrivatePathIdentity): Promise<boolean>;
    removeDirectory(directory: string): Promise<void>;
    close(): Promise<void>;
}
/**
 * Validate the user home boundary, `.config`, and Borg root without collapsing
 * symlinks. Static unsafe objects fail closed. The same-user final pathname race
 * remains outside the single-user threat boundary because Node lacks portable
 * openat/renameat operations; this wrapper does not claim descriptor-relative
 * or race-free containment.
 */
export declare function ensurePrivateBorgConfigRoot(): Promise<PrivateBorgConfigRoot>;
//# sourceMappingURL=private-root.d.ts.map