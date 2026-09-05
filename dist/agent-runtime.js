/**
 * Agent CLI identity is independent from both the selected model and the
 * Codex remote-wake transport. The child MCP process reports this value on its
 * health beat so a relaunch of an existing seat can repair the server-side
 * agent_kind without re-assimilating.
 */
import { BORG_STATE_ROOT_ENV } from './private-root.js';
import { randomBytes } from 'node:crypto';
/** Pinned into MCP-child environments by Borg launch paths. */
export const BORG_AGENT_KIND_ENV = 'BORG_AGENT_KIND';
export const BORG_CLAUDE_LAUNCH_CORRELATION_ENV = 'BORG_CLAUDE_LAUNCH_CORRELATION';
/** Transport capability only — never use it as the primary CLI identity. */
export const BORG_CODEX_REMOTE_WAKE_ENV = 'BORG_CODEX_REMOTE_WAKE';
/** Legacy OpenCode runtime marker, retained for installed-config compatibility. */
export const BORG_OPENCODE_ENV = 'BORG_OPENCODE';
function isAgentKind(value) {
    return value === 'claude' || value === 'codex' || value === 'opencode';
}
/**
 * Resolve the current MCP child's agent CLI. New Borg launches pin
 * BORG_AGENT_KIND; the older wake-transport markers remain a fallback for
 * already-installed clients.
 */
export function resolveSessionAgentKind(env = process.env) {
    return resolveReportableSessionAgentKind(env) ?? 'claude';
}
/** Resolve only positively identified CLI state for advisory server reporting. */
export function resolveReportableSessionAgentKind(env = process.env) {
    if (isAgentKind(env[BORG_AGENT_KIND_ENV]))
        return env[BORG_AGENT_KIND_ENV];
    if (env[BORG_OPENCODE_ENV] === '1')
        return 'opencode';
    if (env[BORG_CODEX_REMOTE_WAKE_ENV] === '1')
        return 'codex';
    return null;
}
/**
 * Produce a clean agent-launch environment. Clearing stale transport markers
 * is essential for a Codex → Claude relaunch: an inherited marker must not
 * make the new Claude MCP child report Codex.
 */
export function withAgentRuntimeEnv(env, agentKind) {
    const next = { ...env };
    delete next[BORG_AGENT_KIND_ENV];
    delete next[BORG_CODEX_REMOTE_WAKE_ENV];
    delete next[BORG_OPENCODE_ENV];
    delete next[BORG_CLAUDE_LAUNCH_CORRELATION_ENV];
    next[BORG_AGENT_KIND_ENV] = agentKind;
    if (agentKind === 'claude') {
        next[BORG_CLAUDE_LAUNCH_CORRELATION_ENV] = randomBytes(32).toString('base64url');
    }
    if (agentKind === 'opencode')
        next[BORG_OPENCODE_ENV] = '1';
    return next;
}
/** Pin the selected Codex CLI identity into Codex's MCP-child env overlay. */
export function codexAgentKindConfigArgs() {
    return ['-c', `mcp_servers.borg.env.${BORG_AGENT_KIND_ENV}="codex"`];
}
/**
 * Pin the remote-wake transport capability separately from the CLI identity.
 *
 * Codex MCP children read their configured env rather than the wrapper's
 * inherited process env. Every Borg Codex launch owns a remote socket.
 */
export function codexRemoteWakeConfigArgs() {
    return [
        '-c',
        `mcp_servers.borg.env.${BORG_CODEX_REMOTE_WAKE_ENV}="1"`,
    ];
}
/**
 * Codex MCP children do not inherit the wrapper environment. Pin the explicit
 * Borg state root into the per-launch child environment when one is active.
 */
export function codexStateRootConfigArgs(env = process.env) {
    const stateRoot = env[BORG_STATE_ROOT_ENV];
    if (stateRoot === undefined)
        return [];
    return [
        '-c',
        `mcp_servers.borg.env.${BORG_STATE_ROOT_ENV}=${JSON.stringify(stateRoot)}`,
    ];
}
//# sourceMappingURL=agent-runtime.js.map