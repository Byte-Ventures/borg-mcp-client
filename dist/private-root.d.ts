/**
 * Optional alternate home root for isolated client runs. The value is the
 * replacement home directory, not the `.config/borgmcp` directory itself, so
 * every client-owned path (credentials, seats, worktrees, and agent config)
 * stays under one root.
 */
export declare const BORG_STATE_ROOT_ENV = "BORG_STATE_ROOT";
/** Return whether a path and every existing ancestor are free of symlinks. */
export declare function isCanonicalPath(root: string): boolean;
/**
 * Set by the test runner (never in production) to the operator's real home.
 * While it is set, no Borg path may resolve into that home's Borg state: every
 * resolver derives from borgHomeRoot, which then refuses the real home before
 * any path is built or any I/O happens. Children inherit it with the
 * environment (it deliberately lacks the BORG_ prefix tests strip).
 */
export declare const TEST_FORBIDDEN_HOME_ENV = "BORGMCP_TEST_FORBIDDEN_HOME";
export declare class TestIsolationError extends Error {
    constructor(root: string);
}
/** Resolve the effective home root used by all Borg-owned local state. */
export declare function borgHomeRoot(env?: NodeJS.ProcessEnv): string;
export declare const borgConfigRoot: () => string;
/**
 * Environment used when a native agent CLI registers Borg. The CLI must write
 * its own config under the same effective root that config-utils reads; the
 * eventual MCP child receives BORG_STATE_ROOT separately via its registration.
 */
export declare function borgAgentConfigEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
/** Ensure Borg's local state root exists with owner-only directory permissions. */
export declare function ensurePrivateBorgConfigRoot(root?: string): Promise<void>;
/** Synchronous equivalent for startup-failure paths that must never await. */
export declare function ensurePrivateBorgConfigRootSync(root?: string): void;
//# sourceMappingURL=private-root.d.ts.map