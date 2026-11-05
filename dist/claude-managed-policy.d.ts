/** Claude's system policy directory is independent of HOME/CLAUDE_CONFIG_DIR.
 * Managed subagents live in .claude/agents beneath it. Keep this resolution
 * separate so tests can supply an isolated filesystem without an env bypass.
 * https://code.claude.com/docs/en/managed-settings */
export declare function claudeManagedAgentDirectory(platform?: NodeJS.Platform): string;
//# sourceMappingURL=claude-managed-policy.d.ts.map