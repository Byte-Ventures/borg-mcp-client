import { spawn, spawnSync } from 'node:child_process';
/**
 * Client #20: the narrow coordination surface a borg-launched agent needs
 * without an approval round-trip. Keep the direct-tool list deliberately
 * smaller than the complete Borg MCP surface. borg_tool's transitive scope is
 * disclosed separately before consent.
 */
export const BORG_COORDINATION_TOOLS = [
    'regen',
    'log',
    'read-log',
    'roster',
    'ack',
    'stream-status',
    'whoami',
    // Required by the canonical lean orientation before acting/after compaction.
    'cube',
    'role',
    'playbook',
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
export function inspectCodexBorgApprovals(config) {
    let defaultMode;
    let toolModes = new Map();
    if (typeof config === 'string') {
        ({ defaultMode, toolModes } = parseCodexModes(config));
    }
    else if (config && typeof config === 'object' && !Array.isArray(config)) {
        const servers = config.mcp_servers;
        const borg = servers && typeof servers === 'object' && !Array.isArray(servers)
            ? servers.borg
            : undefined;
        if (borg && typeof borg === 'object' && !Array.isArray(borg)) {
            const record = borg;
            if (typeof record.default_tools_approval_mode === 'string') {
                defaultMode = record.default_tools_approval_mode;
            }
            if (record.tools && typeof record.tools === 'object' && !Array.isArray(record.tools)) {
                toolModes = new Map(Object.entries(record.tools).flatMap(([tool, value]) => value && typeof value === 'object' &&
                    typeof value.approval_mode === 'string'
                    ? [[tool, value.approval_mode]]
                    : []));
            }
        }
    }
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
    if (tools.length === 0)
        return [];
    // Codex's dotted CLI override parser treats quotes in a segment literally,
    // so `tools."borg:regen"` creates the wrong key. An inline TOML table is the
    // supported way to address colon-named tools and deep-merges with the
    // remaining effective tool config.
    const toolTable = tools
        .map((tool) => `${JSON.stringify(tool)}={approval_mode="auto"}`)
        .join(',');
    return ['-c', `mcp_servers.borg.tools={${toolTable}}`];
}
/** Keep only flags that participate in Codex config resolution. They are
 * replayed after Borg's hypothetical approval flags, matching real launch
 * precedence without passing prompts/images/remote-control flags to the
 * config-reader process. */
export function codexEffectiveConfigArgs(args) {
    const out = [];
    const paired = new Set(['-p', '--profile', '-c', '--config', '--enable', '--disable']);
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (paired.has(arg)) {
            if (args[i + 1] !== undefined)
                out.push(arg, args[++i]);
            continue;
        }
        if (/^--(?:profile|config|enable|disable)=/.test(arg) || arg === '--strict-config') {
            out.push(arg);
        }
    }
    return out;
}
export async function readCodexEffectiveConfig(args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn('codex', [...args, 'app-server', '--stdio'], {
            cwd,
            env,
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        let buffer = '';
        let settled = false;
        const finish = (error, value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            if (error)
                reject(error);
            else
                resolve(value);
        };
        const timer = setTimeout(() => finish(new Error('Codex effective-config query timed out')), 5_000);
        child.on('error', () => finish(new Error('Codex effective-config query failed')));
        child.on('exit', () => {
            if (!settled)
                finish(new Error('Codex effective-config query exited before responding'));
        });
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 4 * 1024 * 1024) {
                finish(new Error('Codex effective-config response exceeded 4 MiB'));
                return;
            }
            for (;;) {
                const newline = buffer.indexOf('\n');
                if (newline < 0)
                    break;
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (!line)
                    continue;
                let message;
                try {
                    message = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if (message.id === 1) {
                    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
                    child.stdin.write(`${JSON.stringify({
                        id: 2,
                        method: 'config/read',
                        params: { cwd, includeLayers: true },
                    })}\n`);
                }
                else if (message.id === 2) {
                    if (message.error)
                        finish(new Error('Codex effective-config query was rejected'));
                    else
                        finish(undefined, message.result?.config ?? null);
                }
            }
        });
        child.stdin.write(`${JSON.stringify({
            id: 1,
            method: 'initialize',
            params: {
                clientInfo: { name: 'borgmcp', title: null, version: '0' },
                capabilities: { experimentalApi: true },
            },
        })}\n`);
    });
}
export function readOpenCodeEffectiveConfig(cwd, env) {
    const result = spawnSync('opencode', ['debug', 'config'], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
        throw new Error('OpenCode effective-config query failed');
    }
    return JSON.parse(result.stdout);
}
export function defaultApprovalIo(confirm, isTTY, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const selectedCodexArgs = codexEffectiveConfigArgs(options.codexArgs ?? []);
    const loadCodex = options.loadCodex ?? readCodexEffectiveConfig;
    const loadOpenCode = options.loadOpenCode ?? readOpenCodeEffectiveConfig;
    return {
        readCodexConfig: (approvalArgs = []) => loadCodex([...approvalArgs, ...selectedCodexArgs], cwd, env),
        readOpenCodeConfig: (permissionOverride) => loadOpenCode(cwd, {
            ...env,
            ...(permissionOverride === undefined
                ? {}
                : { OPENCODE_PERMISSION: permissionOverride }),
        }),
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
            inspection = inspectCodexBorgApprovals(await io.readCodexConfig());
        }
        else {
            openCodeConfig = await io.readOpenCodeConfig();
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
    const answer = await io.confirm(`${intro} Apply this launch-only Borg approval set? [y/N] `);
    if (!accepted(answer)) {
        return {
            codexArgs: [],
            warning: `${intro} Continuing without the launch-only fix. To repair it globally, add:\n${inspection.repairSnippet}`,
        };
    }
    if (cli === 'codex') {
        const codexArgs = codexBorgApprovalArgs(inspection.restrictiveTools);
        let effectiveWithOverride;
        try {
            effectiveWithOverride = inspectCodexBorgApprovals(await io.readCodexConfig(codexArgs));
        }
        catch {
            return {
                codexArgs: [],
                warning: 'Could not verify the Codex launch-only approval override against effective config. No override was applied.',
            };
        }
        if (effectiveWithOverride.restrictiveTools.length > 0) {
            return {
                codexArgs: [],
                warning: `Codex managed policy prevents the launch-only Borg approval override. Ask your Codex administrator to allow these tools:\n${effectiveWithOverride.repairSnippet}`,
            };
        }
        return { codexArgs };
    }
    const openCodePermission = JSON.stringify(mergeOpenCodePermission(openCodeConfig && typeof openCodeConfig === 'object'
        ? openCodeConfig.permission
        : undefined, inspection.restrictiveTools));
    let effectiveWithOverride;
    try {
        effectiveWithOverride = inspectOpenCodeBorgApprovals(await io.readOpenCodeConfig(openCodePermission));
    }
    catch {
        return {
            codexArgs: [],
            warning: 'Could not verify the OpenCode launch-only approval override against effective config. No override was applied.',
        };
    }
    if (effectiveWithOverride.restrictiveTools.length > 0) {
        return {
            codexArgs: [],
            warning: `OpenCode managed policy prevents the launch-only Borg approval override. Ask your OpenCode administrator to allow these tools:\n${effectiveWithOverride.repairSnippet}`,
        };
    }
    return {
        codexArgs: [],
        openCodePermission,
    };
}
export function buildOpenCodeLaunchArgs(cwd, port, prompt, passthroughArgs = []) {
    // Deliberately no `--auto`: that switch auto-approves unrelated shell/file
    // actions. Exact Borg coordination consent is carried in the child env.
    return [cwd, '--port', String(port), '--prompt', prompt, ...passthroughArgs];
}
export async function setupApprovalWarnings(deps, selected = { codex: true, opencode: true }) {
    const warnings = [];
    try {
        const codex = selected.codex
            ? inspectCodexBorgApprovals(await deps.readCodexConfig())
            : null;
        if (codex && codex.restrictiveTools.length > 0) {
            warnings.push(`Codex Borg approvals are restrictive. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE} Borg launches will offer a launch-only fix. Global repair:\n${codex.repairSnippet}`);
        }
    }
    catch (error) {
        warnings.push(`Could not inspect Codex Borg tool approvals: ${error?.message ?? error}`);
    }
    try {
        const opencode = selected.opencode
            ? inspectOpenCodeBorgApprovals(await deps.readOpenCodeConfig())
            : null;
        if (opencode && opencode.restrictiveTools.length > 0) {
            warnings.push(`OpenCode Borg approvals are restrictive. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE} Borg launches will offer a launch-only fix. Global repair:\n${opencode.repairSnippet}`);
        }
    }
    catch (error) {
        warnings.push(`Could not inspect OpenCode Borg tool approvals: ${error?.message ?? error}`);
    }
    return warnings;
}
//# sourceMappingURL=cli-tool-approval.js.map