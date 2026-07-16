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
import path from 'path';
import { fileURLToPath } from 'url';
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));
/**
 * Absolute path to a sibling bin file in dist/.
 * Returns the path even if the file does not yet exist (caller decides whether
 * to fail) so callers that write config can store the path before build.
 */
export function resolveSelfBinPath(binName) {
    const binPath = path.join(DIST_DIR, binName);
    return binPath;
}
/** Absolute path to the borg-mcp stdio server entrypoint (dist/index.js). */
export function resolveMcpBinaryPath() {
    return resolveSelfBinPath('index.js');
}
/** Absolute path to borg-regen (dist/regen.js). */
export function resolveRegenPath() {
    return resolveSelfBinPath('regen.js');
}
/** Absolute path to borg-inbox-monitor (dist/inbox-monitor.js). */
export function resolveInboxMonitorPath() {
    return resolveSelfBinPath('inbox-monitor.js');
}
/** Absolute path to borg-clear-rewake (dist/clear-rewake.js). */
export function resolveClearRewakePath() {
    return resolveSelfBinPath('clear-rewake.js');
}
/** Absolute path to borg-log-audit (dist/log-audit.js). */
export function resolveLogAuditPath() {
    return resolveSelfBinPath('log-audit.js');
}
//# sourceMappingURL=self-path.js.map