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
/**
 * Environment used when a native agent CLI registers Borg. The CLI must write
 * its own config under the same effective root that config-utils reads; the
 * eventual MCP child receives BORG_STATE_ROOT separately via its registration.
 */
export declare function borgAgentConfigEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Ensure Borg's local state root exists with owner-only directory permissions. */
export declare function ensurePrivateBorgConfigRoot(root?: string): Promise<void>;
//# sourceMappingURL=private-root.d.ts.map