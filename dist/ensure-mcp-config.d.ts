import type { BorgCli } from './cubes.js';
export interface EnsureMcpConfigDeps {
    isClaudeConfigured: () => boolean;
    addClaude: () => void;
    isCodexConfigured: () => boolean;
    addCodex: () => void;
    isOpenCodeConfigured: () => boolean;
    addOpenCode: () => void;
}
/**
 * Ensure borg is registered as an MCP server for one selected agent CLI.
 *
 * Returns true when this call added the registration and false when it was
 * already present. Errors from an adder intentionally propagate so callers
 * can fail the launch with the CLI-specific remediation message.
 */
export declare function ensureCliMcpConfigured(cli: BorgCli, deps?: EnsureMcpConfigDeps): boolean;
//# sourceMappingURL=ensure-mcp-config.d.ts.map