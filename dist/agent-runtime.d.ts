/**
 * Agent CLI identity is independent from both the selected model and the
 * Codex remote-wake transport. The child MCP process reports this value on its
 * health beat so a relaunch of an existing seat can repair the server-side
 * agent_kind without re-assimilating.
 */
export type AgentKind = 'claude' | 'codex' | 'opencode';
/** Pinned into MCP-child environments by Borg launch paths. */
export declare const BORG_AGENT_KIND_ENV = "BORG_AGENT_KIND";
/** Transport capability only — never use it as the primary CLI identity. */
export declare const BORG_CODEX_REMOTE_WAKE_ENV = "BORG_CODEX_REMOTE_WAKE";
/** Legacy OpenCode runtime marker, retained for installed-config compatibility. */
export declare const BORG_OPENCODE_ENV = "BORG_OPENCODE";
/**
 * Resolve the current MCP child's agent CLI. New Borg launches pin
 * BORG_AGENT_KIND; the older wake-transport markers remain a fallback for
 * already-installed clients.
 */
export declare function resolveSessionAgentKind(env?: NodeJS.ProcessEnv): AgentKind;
/**
 * Produce a clean agent-launch environment. Clearing stale transport markers
 * is essential for a Codex → Claude relaunch: an inherited marker must not
 * make the new Claude MCP child report Codex.
 */
export declare function withAgentRuntimeEnv(env: NodeJS.ProcessEnv, agentKind: AgentKind): NodeJS.ProcessEnv;
/** Pin the selected Codex CLI identity into Codex's MCP-child env overlay. */
export declare function codexAgentKindConfigArgs(): string[];
/**
 * Pin the remote-wake transport capability separately from the CLI identity.
 *
 * Codex MCP children read their configured env rather than the wrapper's
 * inherited process env. Explicitly pinning "0" on a no-socket launch is
 * therefore necessary to override legacy static configs that used to persist
 * BORG_CODEX_REMOTE_WAKE="1" as an identity marker.
 */
export declare function codexRemoteWakeConfigArgs(enabled?: boolean): string[];
//# sourceMappingURL=agent-runtime.d.ts.map