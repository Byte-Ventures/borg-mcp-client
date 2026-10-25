export declare function openCodePrivateRoot(): string;
/** The native host and Node can spell a Windows path differently. Compare
 * directory identities there, including case-sensitive NTFS directories. */
export declare function sameOpenCodeDirectory(left: string, right: string): boolean;
export declare function ensureOpenCodePrivateRoot(root?: string): void;
export declare function verifyOpenCodePrivateWindowsPath(filename: string): void;
//# sourceMappingURL=opencode-private-state.d.ts.map