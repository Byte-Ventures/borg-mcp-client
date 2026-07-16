import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/**
 * Client #20: the narrow coordination surface a borg-launched agent needs
 * without an approval round-trip. Keep this list deliberately smaller than
 * the complete Borg MCP surface: deferred product/admin tools still follow the
 * operator's normal agent policy.
 */
export const BORG_COORDINATION_TOOLS = [
    'regen',
    'log',
    'read-log',
    'roster',
    'ack',
    'stream-status',
    'whoami',
    'tool',
    'describe-tool',
];
export const CODEX_BORG_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map((name) => `borg:${name}`);
// OpenCode sanitizes MCP tool names as <server>_<raw tool name>, preserving
// hyphens. The Borg raw tool prefix is itself `borg_`.
export const OPENCODE_BORG_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map((name) => `borg_borg_${name}`);
export const BORG_DISPATCHER_APPROVAL_DISCLOSURE = 'This set includes borg_tool: approving the dispatcher also approves any Borg operation invoked through it.';
function parseCodexModes(text) {
    let section = 'other';
    let defaultMode;
    const toolModes = new Map();
    for (const line of text.split(/\r?\n/)) {
        const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
        if (header) {
            if (header[1] === 'mcp_servers.borg') {
                section = 'borg';
            }
            else {
                const tool = header[1].match(/^mcp_servers\.borg\.tools\."([^"]+)"$/);
                section = tool ? { tool: tool[1] } : 'other';
            }
            continue;
        }
        const value = line.match(/^\s*(default_tools_approval_mode|approval_mode)\s*=\s*["'](auto|prompt|writes|approve)["']\s*(?:#.*)?$/);
        if (!value)
            continue;
        const mode = value[2];
        if (section === 'borg' && value[1] === 'default_tools_approval_mode') {
            defaultMode = mode;
        }
        else if (typeof section === 'object' && value[1] === 'approval_mode') {
            toolModes.set(section.tool, mode);
        }
    }
    return { ...(defaultMode ? { defaultMode } : {}), toolModes };
}
export function codexApprovalRepairSnippet(tools = CODEX_BORG_COORDINATION_TOOLS) {
    return tools
        .map((tool) => `[mcp_servers.borg.tools."${tool}"]\n` +
        `approval_mode = "auto"`)
        .join('\n\n');
}
export function inspectCodexBorgApprovals(text) {
    const { defaultMode, toolModes } = parseCodexModes(text);
    const restrictiveTools = CODEX_BORG_COORDINATION_TOOLS.filter((tool) => {
        const mode = toolModes.get(tool) ?? defaultMode;
        return mode !== undefined && mode !== 'auto';
    });
    return {
        restrictiveTools,
        repairSnippet: codexApprovalRepairSnippet(restrictiveTools.length > 0 ? restrictiveTools : CODEX_BORG_COORDINATION_TOOLS),
    };
}
function globMatches(pattern, value) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`).test(value);
}
function effectiveOpenCodePermission(permission, tool) {
    if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
        return permission;
    }
    if (!permission || typeof permission !== 'object' || Array.isArray(permission))
        return undefined;
    let result;
    for (const [pattern, action] of Object.entries(permission)) {
        if (globMatches(pattern, tool) &&
            (action === 'allow' || action === 'ask' || action === 'deny')) {
            result = action;
        }
    }
    return result;
}
export function openCodeApprovalRepairObject(tools = OPENCODE_BORG_COORDINATION_TOOLS) {
    return Object.fromEntries(tools.map((tool) => [tool, 'allow']));
}
/** Preserve every existing OpenCode permission rule, then append the exact
 * Borg coordination allows. This remains safe whether OPENCODE_PERMISSION is
 * deep-merged or replaces the configured permission value. */
export function mergeOpenCodePermission(permission, tools = OPENCODE_BORG_COORDINATION_TOOLS) {
    let existing = {};
    if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
        existing = { '*': permission };
    }
    else if (permission && typeof permission === 'object' && !Array.isArray(permission)) {
        existing = { ...permission };
    }
    // Reinsert exact keys at the END. OpenCode resolves matching permission
    // patterns in order, so merely overwriting an earlier exact key would keep
    // its old insertion position and a later wildcard could still win.
    const toolSet = new Set(tools);
    const preserved = Object.fromEntries(Object.entries(existing).filter(([key]) => !toolSet.has(key)));
    return { ...preserved, ...openCodeApprovalRepairObject(tools) };
}
export function inspectOpenCodeBorgApprovals(config) {
    const permission = config && typeof config === 'object' && !Array.isArray(config)
        ? config.permission
        : undefined;
    const restrictiveTools = OPENCODE_BORG_COORDINATION_TOOLS.filter((tool) => {
        const action = effectiveOpenCodePermission(permission, tool);
        return action === 'ask' || action === 'deny';
    });
    return {
        restrictiveTools,
        repairSnippet: JSON.stringify({ permission: mergeOpenCodePermission(permission, restrictiveTools.length > 0 ? restrictiveTools : OPENCODE_BORG_COORDINATION_TOOLS) }, null, 2),
    };
}
export function codexBorgApprovalArgs(tools = CODEX_BORG_COORDINATION_TOOLS) {
    return tools.flatMap((tool) => [
        '-c',
        `mcp_servers.borg.tools."${tool}".approval_mode="auto"`,
    ]);
}
export function defaultApprovalIo(confirm, isTTY, env = process.env) {
    return {
        readCodexConfig: () => {
            const file = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
            return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        },
        readOpenCodeConfig: () => {
            const file = env.OPENCODE_CONFIG || path.join(env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode'), 'opencode.json');
            const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
            if (env.OPENCODE_PERMISSION) {
                config.permission = JSON.parse(env.OPENCODE_PERMISSION);
            }
            return config;
        },
        isTTY,
        confirm,
    };
}
function accepted(answer) {
    return /^(?:y|yes)$/i.test(answer.trim());
}
export async function resolveLaunchBorgApprovals(cli, io) {
    if (cli === 'claude')
        return { codexArgs: [] };
    let inspection;
    let openCodeConfig;
    try {
        if (cli === 'codex') {
            inspection = inspectCodexBorgApprovals(io.readCodexConfig());
        }
        else {
            openCodeConfig = io.readOpenCodeConfig();
            inspection = inspectOpenCodeBorgApprovals(openCodeConfig);
        }
    }
    catch (error) {
        return {
            codexArgs: [],
            warning: `Could not inspect ${cli} Borg tool approvals: ${error?.message ?? error}. No approval override was applied.`,
        };
    }
    if (inspection.restrictiveTools.length === 0)
        return { codexArgs: [] };
    const intro = `${cli === 'codex' ? 'Codex' : 'OpenCode'} requires approval for ${inspection.restrictiveTools.length} Borg tool${inspection.restrictiveTools.length === 1 ? '' : 's'}. ` +
        BORG_DISPATCHER_APPROVAL_DISCLOSURE;
    if (!io.isTTY()) {
        return {
            codexArgs: [],
            warning: `${intro} Re-run in a terminal to approve a launch-only fix, or add:\n${inspection.repairSnippet}`,
        };
    }
    const answer = await io.confirm(`${intro} Allow only these Borg coordination tools for this launch? [y/N] `);
    if (!accepted(answer)) {
        return {
            codexArgs: [],
            warning: `${intro} Continuing without the launch-only fix. To repair it globally, add:\n${inspection.repairSnippet}`,
        };
    }
    if (cli === 'codex') {
        return { codexArgs: codexBorgApprovalArgs(inspection.restrictiveTools) };
    }
    return {
        codexArgs: [],
        openCodePermission: JSON.stringify(mergeOpenCodePermission(openCodeConfig && typeof openCodeConfig === 'object'
            ? openCodeConfig.permission
            : undefined, inspection.restrictiveTools)),
    };
}
export function buildOpenCodeLaunchArgs(cwd, port, prompt, passthroughArgs = []) {
    // Deliberately no `--auto`: that switch auto-approves unrelated shell/file
    // actions. Exact Borg coordination consent is carried in the child env.
    return [cwd, '--port', String(port), '--prompt', prompt, ...passthroughArgs];
}
export function setupApprovalWarnings(deps) {
    const warnings = [];
    try {
        const codex = inspectCodexBorgApprovals(deps.readCodexConfig());
        if (codex.restrictiveTools.length > 0) {
            warnings.push(`Codex Borg approvals are restrictive. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE} Borg launches will offer a launch-only fix. Global repair:\n${codex.repairSnippet}`);
        }
    }
    catch (error) {
        warnings.push(`Could not inspect Codex Borg tool approvals: ${error?.message ?? error}`);
    }
    try {
        const opencode = inspectOpenCodeBorgApprovals(deps.readOpenCodeConfig());
        if (opencode.restrictiveTools.length > 0) {
            warnings.push(`OpenCode Borg approvals are restrictive. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE} Borg launches will offer a launch-only fix. Global repair:\n${opencode.repairSnippet}`);
        }
    }
    catch (error) {
        warnings.push(`Could not inspect OpenCode Borg tool approvals: ${error?.message ?? error}`);
    }
    return warnings;
}
//# sourceMappingURL=cli-tool-approval.js.map