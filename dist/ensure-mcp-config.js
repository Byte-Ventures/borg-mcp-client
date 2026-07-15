import { addCodexMcpServer, addMcpServer, addOpenCodeMcpServer, isCodexMcpServerConfigured, isMcpServerConfigured, isOpenCodeMcpServerConfigured, } from './config-utils.js';
const defaultDeps = {
    isClaudeConfigured: isMcpServerConfigured,
    addClaude: addMcpServer,
    isCodexConfigured: isCodexMcpServerConfigured,
    addCodex: addCodexMcpServer,
    isOpenCodeConfigured: isOpenCodeMcpServerConfigured,
    addOpenCode: addOpenCodeMcpServer,
};
/**
 * Ensure borg is registered as an MCP server for one selected agent CLI.
 *
 * Returns true when this call added the registration and false when it was
 * already present. Errors from an adder intentionally propagate so callers
 * can fail the launch with the CLI-specific remediation message.
 */
export function ensureCliMcpConfigured(cli, deps = defaultDeps) {
    switch (cli) {
        case 'claude':
            if (deps.isClaudeConfigured())
                return false;
            deps.addClaude();
            return true;
        case 'codex':
            if (deps.isCodexConfigured())
                return false;
            deps.addCodex();
            return true;
        case 'opencode':
            if (deps.isOpenCodeConfigured())
                return false;
            deps.addOpenCode();
            return true;
    }
}
//# sourceMappingURL=ensure-mcp-config.js.map