/** Claude's system policy directory is independent of HOME/CLAUDE_CONFIG_DIR.
 * Managed subagents live in .claude/agents beneath it. Keep this resolution
 * separate so tests can supply an isolated filesystem without an env bypass.
 * https://code.claude.com/docs/en/managed-settings */
export function claudeManagedAgentDirectory(platform = process.platform) {
    if (platform === 'darwin')
        return '/Library/Application Support/ClaudeCode/.claude/agents';
    if (platform === 'win32')
        return 'C:\\Program Files\\ClaudeCode\\.claude\\agents';
    return '/etc/claude-code/.claude/agents';
}
//# sourceMappingURL=claude-managed-policy.js.map