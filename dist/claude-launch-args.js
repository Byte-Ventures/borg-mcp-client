/**
 * gh#702 — borg-launched Claude Code drones auto-allow the borg MCP
 * coordination tools so a drone never prompts on borg_regen / borg_log /
 * borg_ack / etc. mid-loop.
 *
 * SCOPED, by deliberate design (Option A, per-launch — avoids the gh#844
 * settings-mutation/consent class):
 *   - ONLY `mcp__borg__*` is auto-allowed. Bash, file edits (Read/Write/Edit),
 *     web (WebFetch/WebSearch), and everything else STILL prompt. This is an
 *     allowlist ADD, NOT `--dangerously-skip-permissions` and NOT a blanket
 *     allow.
 *   - Applied ONLY by the borg launcher (a per-invocation CLI flag) — there is
 *     NO persistent user-settings write, so no consent gate is involved.
 *   - claude only. Codex parity is a separate follow-up (different permission
 *     model) — intentionally not handled here.
 */
/** The allowlist pattern matching every tool from the `borg` MCP server. */
export const BORG_MCP_ALLOWED_TOOLS = 'mcp__borg__*';
/**
 * Build the argv for a borg-launched `claude` process: the user's passthrough
 * args.
 *
 * ORDER IS LOAD-BEARING (CR blocker 0e5c697e): `--allowedTools` is a VARIADIC
 * option (`<tools...>`, a space-separated list), so it greedily consumes every
 * following non-flag argv element. If the kickoff prompt came AFTER it, claude
 * would absorb the prompt as a 2nd "allowed tool" and launch with NO kickoff.
 * So the kickoff positional goes FIRST and the variadic flag goes LAST, where
 * it can only consume its own single value:
 *   [...passthrough, kickoff, '--allowedTools', 'mcp__borg__*']
 */
export function buildClaudeLaunchArgs(passthroughArgs, kickoff) {
    return [...passthroughArgs, kickoff, '--allowedTools', BORG_MCP_ALLOWED_TOOLS];
}
//# sourceMappingURL=claude-launch-args.js.map