/**
 * Runtime version reader.
 *
 * Single source of truth for the borgmcp client version — read at runtime
 * from `package.json` relative to `import.meta.url`, NOT hardcoded.
 *
 * Consumers:
 *   - `index.ts` — passed into the MCP `Server({ name, version })`
 *     constructor so Claude Code's `/mcp` view shows the real version
 *     instead of the long-standing hardcoded "0.1.0".
 *   - `claude.ts` / `setup.ts` / `regen.ts` / `log-audit.ts` — each
 *     binary supports a `--version` flag that prints `borgmcp X.Y.Z`
 *     and exits 0 before any side-effecting work begins.
 *
 * Implementation notes:
 *   - Uses `readFileSync` on the resolved path relative to this module's
 *     `import.meta.url`. The compiled `dist/version.js` sits one level
 *     above `package.json` at the package root, so `../package.json` is
 *     the relative resolution. This works under both `node dist/...`
 *     and `npm run start`; the path resolution is independent of CWD.
 *   - Result is cached at module-eval time. The package.json is part of
 *     the published tarball and immutable for any given install.
 *   - Falls back to `'unknown'` if the read fails (corrupted install,
 *     someone deleted package.json, etc.) — never throws, so a fresh
 *     `--version` invocation can't kill a CLI launch.
 */
/**
 * Return the installed borgmcp version (the same string as
 * `client/package.json`'s `version` field). Cached at module load.
 */
export declare function getPackageVersion(): string;
/**
 * Standard `--version` handler — call near the top of any CLI entry
 * point. If `process.argv` contains `--version` or `-v`, prints
 * `borgmcp X.Y.Z` to stdout and exits 0. Otherwise returns silently
 * so the caller can continue with normal CLI work.
 *
 * Examples:
 *   - `borg --version`    → "borgmcp 0.6.0"
 *   - `borg-mcp -v`       → "borgmcp 0.6.0"
 *   - `borg assimilate`   → continues to assimilation flow
 *   - `borg-setup`        → continues to interactive setup wizard
 */
/**
 * gh#285: read the on-disk package.json version fresh (not cached).
 * Used by the regen handler to detect post-upgrade version mismatch.
 */
export declare function getOnDiskVersion(): string;
export declare function handleVersionFlag(): void;
//# sourceMappingURL=version.d.ts.map