/**
 * Agent CLI identity is independent from both the selected model and the
 * Codex remote-wake transport. The child MCP process reports this value on its
 * health beat so a relaunch of an existing seat can repair the server-side
 * agent_kind without re-assimilating.
 */
/** Pinned into MCP-child environments by Borg launch paths. */
export const BORG_AGENT_KIND_ENV = 'BORG_AGENT_KIND';
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
    next[BORG_AGENT_KIND_ENV] = agentKind;
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
 * inherited process env. Explicitly pinning "0" on a no-socket launch is
 * therefore necessary to override legacy static configs that used to persist
 * BORG_CODEX_REMOTE_WAKE="1" as an identity marker.
 */
export function codexRemoteWakeConfigArgs(enabled = true) {
    return [
        '-c',
        `mcp_servers.borg.env.${BORG_CODEX_REMOTE_WAKE_ENV}="${enabled ? '1' : '0'}"`,
    ];
}
//# sourceMappingURL=agent-runtime.js.map