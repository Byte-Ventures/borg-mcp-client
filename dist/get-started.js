// gh#817: get-started guidance for a FRESH (not-yet-onboarded) user who runs
// bare `borg`. The B1 postinstall banner is invisible (npm v7+ suppresses
// postinstall stdout), so the breadcrumb must reach the user on a surface they
// actually see — the bare-`borg` launch path.
//
// Two pure helpers keep the policy testable and the I/O (token-store reads,
// stdout, process.exit) in claude.ts:
//   - shouldShowGetStarted: the fresh-vs-configured RULE (presence booleans in)
//   - composeGetStarted:    the user-visible TEXT (carries zero auth material)
/**
 * Fresh-vs-configured rule. "Configured" = the user has completed `borg setup`,
 * signalled by the PRESENCE of a stored credential. Inputs are existence
 * booleans only — the caller null-checks the token accessors and never decodes,
 * logs, or prints the token value (SR gh#817 constraint).
 *
 * Refresh-token presence is the durable signal: it survives id_token expiry, so
 * a configured user whose id_token has lapsed is NOT mistaken for fresh (which
 * would wrongly suppress their normal launch). The id_token presence is the
 * fallback for the rare case where Google returned no refresh_token and the
 * id_token is still valid.
 */
export function shouldShowGetStarted(hasRefreshToken, hasIdToken) {
    return !hasRefreshToken && !hasIdToken;
}
/**
 * The user-visible get-started text. Carries ZERO auth material (no tokens, no
 * PII) — it is pure onboarding guidance. When no agent CLI is detected, lead
 * with the install-an-agent-CLI step (mirrors the B1 banner intent).
 */
export function composeGetStarted(hasAgentCli) {
    const lines = [
        '',
        'Welcome to Borg MCP — multi-agent coordination for your AI coding agent.',
        '',
        "You're not set up yet. To get started:",
        '',
    ];
    let step = 1;
    if (!hasAgentCli) {
        lines.push(`  ${step}. Install an agent CLI first:`, '       Claude Code: https://claude.ai/download', '       Codex:       https://developers.openai.com/codex');
        step++;
    }
    lines.push(`  ${step}. borg setup${' '.repeat(Math.max(1, 18 - 'borg setup'.length))}— sign in with Google`);
    step++;
    lines.push(`  ${step}. cd into your project, then: borg assimilate — join/create a cube`, '', 'Then `borg` launches your agent in that cube. Run `borg --help` for more.', '');
    return lines.join('\n');
}
//# sourceMappingURL=get-started.js.map