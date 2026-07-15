/**
 * gh#673 P1 — the borg-launch ACTIVATION gate (WI-4 + WI-5-claude).
 *
 * The `borg` wrapper sets BORG_SESSION=1 in the agent's launch env
 * (claude.ts / assimilate-cmd.ts launchEnv — same pattern as
 * BORG_CODEX_REMOTE_WAKE). Claude Code spawns the borg-mcp MCP child and
 * runs hook commands with that env inherited, so four activation bins
 * gate on it:
 *   1. the MCP tool surface (index.ts CallTool top) — a vanilla session
 *      gets a non-silent re-launch notice per tool, never a half-success;
 *   2. the borg-regen SessionStart hook bin — exit-0 no-op;
 *   3. the borg-clear-rewake clear-only hook bin — exit-0 no-op;
 *   4. the borg-log-audit UserPromptSubmit hook bin — exit-0 no-op.
 * Result: `claude` launched directly is vanilla Claude Code; `borg`
 * launches get the full surface.
 *
 * Codex (V2/V2b probes): codex does NOT forward parent env to MCP
 * children — only the pinned [mcp_servers.borg.env] list — so simple
 * launchEnv inheritance can't deliver the marker there. But a
 * PER-INVOCATION `-c 'mcp_servers.borg.env.BORG_SESSION="1"'` config
 * override DOES reach the child (V2b-proven). The borg wrapper appends
 * `codexBorgSessionConfigArgs()` to every codex launch, so codex rides
 * the exact same isBorgSession() gate: vanilla codex children lack the
 * var and gate dormant; borg-launched children carry it. The codex
 * SessionStart hook bin gates via the codex PROCESS env, which the
 * wrapper's launchEnv marks directly.
 *
 * SR-BINDING (1482e7f9): BORG_SESSION is ACTIVATION-ONLY. It is
 * user-settable by design (manual BORG_SESSION=1 is a supported override
 * for power users/tests) and MUST NEVER be consulted for an access or
 * security decision — server-side OAuth + drone-session auth are the
 * security boundary and are unchanged by this gate.
 */
export declare const BORG_SESSION_ENV = "BORG_SESSION";
/** True when this process runs inside a borg-launched session. */
export declare function isBorgSession(env?: NodeJS.ProcessEnv): boolean;
/**
 * The non-silent per-tool notice a vanilla (non-borg-launched) session
 * receives when invoking a borg_* tool. Explains the state — nothing is
 * wrong with the cube — and points at the borg launch path.
 */
export declare function borgSessionToolNotice(toolName: string): string;
/**
 * The per-invocation codex config override that injects BORG_SESSION into
 * the codex-spawned borg-mcp child's pinned env (V2b-proven mechanism —
 * inherited env never reaches codex MCP children). Appended to the codex
 * launch args by both launch sites (claude.ts + assimilate-cmd.ts).
 * TOML string value, hence the inner quotes.
 */
export declare function codexBorgSessionConfigArgs(): string[];
/**
 * Gate decision with BORG_DEBUG observability — one funnel so every bin
 * logs refusals the same way.
 */
export declare function gateAllowsActivation(surface: string, env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=launch-gate.d.ts.map