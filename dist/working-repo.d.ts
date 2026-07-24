/**
 * Resolve the repository identity for the directory hosting this MCP child.
 *
 * The report carries only a canonical repository identity (`host/org/repo`)
 * and its derived name. Local filesystem paths and raw remote URLs are never
 * included in lifecycle metadata.
 */
export interface WorkingRepo {
    name: string | null;
    /** Canonical public HTTPS identity, never a raw Git remote URL. */
    origin: string | null;
    state?: 'known' | 'unknown' | 'unavailable' | 'rejected';
}
export interface WorkingRepoDeps {
    runGit?: (cwd: string, args: string[]) => {
        status: number | null;
        stdout?: string | null;
    };
}
/**
 * Convert a Git remote to the shared canonical public repository identity.
 * Hostile or credential-bearing inputs are rejected rather than sanitized.
 */
export declare function canonicalizeWorkingRepoIdentity(origin: string): WorkingRepo | null;
/**
 * Return a reportable identity for the caller's current directory.
 *
 * `git rev-parse --show-toplevel` supports both ordinary clones and linked
 * worktrees. Any git failure reports no repository identity instead of
 * disclosing the caller's local filesystem layout.
 */
export declare function resolveWorkingRepo(cwd?: string, deps?: WorkingRepoDeps): WorkingRepo;
//# sourceMappingURL=working-repo.d.ts.map