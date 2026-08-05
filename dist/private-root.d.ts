/**
 * Optional alternate home root for isolated client runs. The value is the
 * replacement home directory, not the `.config/borgmcp` directory itself, so
 * every client-owned path (credentials, seats, worktrees, and agent config)
 * stays under one root.
 */
export declare const BORG_STATE_ROOT_ENV = "BORG_STATE_ROOT";
/** Resolve the effective home root used by all Borg-owned local state. */
export declare function borgHomeRoot(): string;
export declare const borgConfigRoot: () => string;
/** Ensure Borg's local state root exists with owner-only directory permissions. */
export declare function ensurePrivateBorgConfigRoot(root?: string): Promise<void>;
//# sourceMappingURL=private-root.d.ts.map