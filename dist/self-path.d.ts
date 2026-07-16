/**
 * Resolve absolute paths to sibling bin executables from the running entrypoint.
 *
 * When borg-mcp is installed globally or repo-locally, MCP config registrations
 * and orientation commands must use the exact binary from THIS installation, not
 * a bare name resolved via PATH (which may point to a different version).
 *
 * `fileURLToPath(import.meta.url)` gives the realpath of the compiled JS file
 * under `dist/`. All bin targets are siblings in the same `dist/` directory.
 */
/**
 * Absolute path to a sibling bin file in dist/.
 * Returns the path even if the file does not yet exist (caller decides whether
 * to fail) so callers that write config can store the path before build.
 */
export declare function resolveSelfBinPath(binName: string): string;
/** Absolute path to the borg-mcp stdio server entrypoint (dist/index.js). */
export declare function resolveMcpBinaryPath(): string;
/** Absolute path to borg-regen (dist/regen.js). */
export declare function resolveRegenPath(): string;
/** Absolute path to borg-inbox-monitor (dist/inbox-monitor.js). */
export declare function resolveInboxMonitorPath(): string;
/** Absolute path to borg-clear-rewake (dist/clear-rewake.js). */
export declare function resolveClearRewakePath(): string;
/** Absolute path to borg-log-audit (dist/log-audit.js). */
export declare function resolveLogAuditPath(): string;
//# sourceMappingURL=self-path.d.ts.map