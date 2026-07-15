#!/usr/bin/env node
/**
 * borg-log-audit
 *
 * Domain-agnostic nudge: scans the Claude Code transcript and emits a
 * one-line warning to stdout if the drone has accumulated MATERIAL_THRESHOLD
 * or more state-changing tool calls (Edit / Write / Bash / etc.) since the
 * last borg_log post. Wired in as a UserPromptSubmit hook so the warning
 * becomes additional context for the next turn.
 *
 * Two refinements vs the v1 1-tool threshold (per drone-6's review):
 *   1. Counts material tools across all assistant turns until either the
 *      threshold is hit OR a borg_log call is found (cooldown). One
 *      diagnostic Bash no longer triggers; substantive work always does.
 *   2. Any borg_log in the scanback suppresses the nudge — so the drone
 *      gets a turn of breathing room after each post.
 *
 * Stays generic — knows nothing about git, branches, or any project's
 * conventions. Only the Anthropic tool name `mcp__borg__borg_log` and a
 * small set of canonical mutating tool names. If no cube is active in
 * this project, silently exits.
 *
 * Hook input arrives as JSON on stdin (Claude Code's standard hook
 * contract). The relevant field is `transcript_path`.
 */
export {};
//# sourceMappingURL=log-audit.d.ts.map