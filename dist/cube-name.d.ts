/**
 * Trim + reject control chars + cap length. Returns null on rejection
 * so callers fall through to no-remote derivation.
 */
export declare function sanitizeRemoteUrl(raw: string): string | null;
/**
 * Extract the repo name from a git remote URL. Handles SSH/HTTPS/git/file
 * forms and embedded credentials. Returns null when nothing parseable
 * is present.
 *
 * Strategy: strip protocol + credentials, then take the last path segment
 * after the final `/` or `:`, stripping a trailing `.git`.
 */
export declare function parseGitRemote(url: string): string | null;
/**
 * Normalize an arbitrary string into a valid cube name:
 * lowercase, underscores+spaces → hyphens, strip [^a-z0-9-], truncate 64.
 */
export declare function normalizeCubeName(raw: string): string;
/**
 * Compose the full derivation: sanitize + parse + normalize, with
 * project-root basename as fallback. Returns null when no valid name
 * can be derived.
 */
export declare function deriveCubeName(projectRoot: string, gitRemoteUrl: string | null): string | null;
//# sourceMappingURL=cube-name.d.ts.map