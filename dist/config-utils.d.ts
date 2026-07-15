/**
 * MCP Settings Configuration Utilities
 *
 * Handles adding borg-mcp to Claude Code via the claude CLI
 */
/**
 * Register a Claude Code SessionStart hook that runs `borg-regen` at the
 * start of every session. Idempotent: re-running won't add duplicates.
 *
 * Returns true if a change was made, false otherwise (already present, or
 * settings.json could not be parsed).
 */
export declare function addSessionStartHook(): boolean;
/**
 * gh#673 P2 (WI-1): install the borg-regen SessionStart hook into a
 * PROJECT-LOCAL `<projectRoot>/.claude/settings.local.json` instead of
 * the global ~/.claude/settings.json. The .local variant is
 * user-authored and uncommitted, so it neither imposes borg-regen on
 * collaborators nor trips committed-project-hook trust prompts
 * (V1-probed: Claude Code merges + fires hooks from it). Written by
 * `borg assimilate` (incl. into freshly spawned sibling worktrees) and
 * ensured on every bare `borg` launch. Idempotent; preserves unrelated
 * settings content; refuses to clobber an unparseable file.
 */
export declare function addProjectSessionStartHook(projectRoot: string): boolean;
/** Peek variant of addProjectSessionStartHook — no mutation. */
export declare function isProjectSessionStartHookRegistered(projectRoot: string): boolean;
/**
 * Peek whether the borg-regen SessionStart hook is already registered, without
 * mutating settings. Returns false on any read error (safe-default).
 */
export declare function isSessionStartHookRegistered(): boolean;
/**
 * Peek: true iff the Claude UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addUserPromptSubmitHook's idempotency
 * check; used by isClaudeHookConfigPending (gh#844).
 */
export declare function isUserPromptSubmitHookRegistered(): boolean;
/**
 * Inverse of addSessionStartHook: remove any SessionStart hook entry whose
 * inner hooks array contains a `borg-regen` command. If multiple commands
 * share an entry, only the borg-regen command is removed; otherwise the
 * entire entry is dropped. Empty containers are cleaned up.
 *
 * Returns true if a change was made, false otherwise.
 */
export declare function removeSessionStartHook(): boolean;
/**
 * Register a Claude Code UserPromptSubmit hook that runs `borg-log-audit`
 * before each user prompt. The audit script nudges the drone if the
 * previous assistant span used state-changing tools without calling
 * `borg_log`. Idempotent: re-running won't add duplicates.
 *
 * Returns true if a change was made, false otherwise.
 */
export declare function addUserPromptSubmitHook(): boolean;
/**
 * Inverse of addUserPromptSubmitHook: remove any UserPromptSubmit hook
 * entry that runs `borg-log-audit`. Symmetric cleanup to
 * removeSessionStartHook.
 */
export declare function removeUserPromptSubmitHook(): boolean;
/**
 * Detect whether the borg MCP server is already registered in the Claude
 * Code CLI config (`~/.claude.json` `mcpServers.borg`).
 *
 * Per gh#79: when a user re-runs `borg setup` to refresh OAuth (the
 * canonical re-run reason), the setup wizard's "Add borg to Claude Code?"
 * prompt is redundant — the answer is deterministic ("already
 * configured"). This detect lets the wizard silently skip Step 1 entirely
 * when borg is present. Per the dispatch's Queen-implicit anti-scope,
 * "silent means silent" — callers must not log an "already configured"
 * notice when this returns true.
 *
 * Safe-default contract: any read error (file missing, malformed JSON,
 * permission denied, empty file, unexpected shape) returns `false` so
 * the caller still prompts. The dispatch's edge-case framing is "if
 * indeterminate → prompt fires" — never silent-skip when state is
 * ambiguous. The prompt is the safe path; silent-skip is the
 * optimization layered on top of a verified-present signal.
 *
 * @param configPath Override the config-file path; primarily for tests.
 */
export declare function isMcpServerConfigured(configPath?: string): boolean;
export declare function isCodexMcpServerConfigured(configPath?: string): boolean;
/**
 * Get absolute path to borg index.js
 * Returns the actual index.js file, not the npm symlink
 */
export declare function getBinaryPath(): string;
/**
 * Add borg MCP server to Claude Code using claude CLI
 * First removes any existing borg configuration, then adds fresh one
 * Runs: claude mcp remove --scope user borg && claude mcp add --scope user borg borg-mcp
 */
export declare function addMcpServer(): void;
export declare function addCodexMcpServer(): void;
export declare function addCodexSessionStartHook(): boolean;
export declare function addCodexUserPromptSubmitHook(): boolean;
export declare function isCodexHookRegistered(eventName: 'SessionStart' | 'UserPromptSubmit' | 'Stop', command: string, hooksPath?: string): boolean;
/**
 * Peek: true iff the Codex SessionStart orientation hook (`borg-regen`) is
 * registered. Non-mutating mirror of addCodexSessionStartHook; used to gate
 * that writer + the gh#844 disclosure on whether it would actually mutate.
 */
export declare function isCodexSessionStartHookRegistered(hooksPath?: string): boolean;
/**
 * Peek: true iff the Codex UserPromptSubmit audit hook (`borg-log-audit`) is
 * registered. Non-mutating mirror of addCodexUserPromptSubmitHook.
 */
export declare function isCodexUserPromptSubmitHookRegistered(hooksPath?: string): boolean;
/**
 * Detect whether the borg MCP server is already registered in the opencode
 * config (`~/.config/opencode/opencode.json` `mcp.borg`).
 *
 * Reads the config as JSON and checks for a `mcp.borg` entry with
 * `type: "local"`. Safe-default: any read error returns `false`.
 */
export declare function isOpenCodeMcpServerConfigured(configPath?: string): boolean;
/**
 * Add borg MCP server to OpenCode using `opencode mcp add` CLI.
 * Pins BORG_SESSION=1, BORG_AGENT_KIND=opencode, the legacy BORG_OPENCODE=1,
 * and BORG_API_URL in the server environment so the MCP child inherits the
 * activation gate + explicit agent-kind signal (same approach as Codex's
 * pinned env — OpenCode MCP children only see pinned env, not parent process
 * env). Existing configs with BORG_OPENCODE remain supported by the runtime
 * fallback.
 */
export declare function addOpenCodeMcpServer(): void;
//# sourceMappingURL=config-utils.d.ts.map