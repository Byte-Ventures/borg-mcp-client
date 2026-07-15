// Pure builder for the post-install banner text. Kept separate from
// postinstall.ts (which is a side-effectful entry script that runs detection
// + console output + process.exit on import) so the message content is unit-
// testable without triggering those side effects.
//
// gh#653 B1: a non-expert who installs borgmcp WITHOUT an agent CLI (Claude
// Code / Codex) present would otherwise be sent straight to "Next step: borg
// setup", which dead-ends at "No supported agent CLI found". When no agent CLI
// is detected, surface the install-an-agent-CLI step FIRST so the banner never
// points the user into a wall.
export function composeInstallBanner(hasAgentCli) {
    const lines = [
        '',
        '╔════════════════════════════════════╗',
        '║       ◼ Borg MCP Installed ◼       ║',
        '╚════════════════════════════════════╝',
        '',
    ];
    if (!hasAgentCli) {
        lines.push('⚠ No agent CLI detected. Borg runs on top of Claude Code or Codex —', '  install one first:', '    Claude Code: https://claude.ai/download', '    Codex:       https://developers.openai.com/codex', '', 'Then run:', '  borg setup', '');
    }
    else {
        lines.push('Next step:', '  borg setup', '');
    }
    return lines.join('\n');
}
//# sourceMappingURL=postinstall-banner.js.map