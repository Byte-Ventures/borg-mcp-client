/**
 * Resolve the repository identity for the directory hosting this MCP child.
 *
 * The report carries only a canonical repository identity (`host/org/repo`)
 * and its derived name. Local filesystem paths and raw remote URLs are never
 * included in lifecycle metadata.
 */
export interface WorkingRepo {
    name: string | null;
    /** Canonical host/path identity, never a raw Git remote URL. */
    origin: string | null;
}
export interface WorkingRepoDeps {
    runGit?: (cwd: string, args: string[]) => {
        status: number | null;
        stdout?: string | null;
    };
}
/**
 * Convert a Git remote to a non-secret `host/org/repo` identity.
 *
 * URL userinfo, query strings, fragments, scheme, and SCP-style user prefixes
 * are deliberately discarded. Inputs that cannot identify a host and path are
 * treated as unreportable rather than forwarded verbatim.
 */
export declare function canonicalizeWorkingRepoIdentity(origin: string): string | null;
/**
 * Return a reportable identity for the caller's current directory.
 *
 * `git rev-parse --show-toplevel` supports both ordinary clones and linked
 * worktrees. Any git failure reports no repository identity instead of
 * disclosing the caller's local filesystem layout.
 */
export declare function resolveWorkingRepo(cwd?: string, deps?: WorkingRepoDeps): WorkingRepo;
//# sourceMappingURL=working-repo.d.ts.map