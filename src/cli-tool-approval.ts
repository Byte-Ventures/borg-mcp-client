import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BorgCli } from './cubes.js';

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
] as const;

export const CODEX_BORG_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map(
  (name) => `borg:${name}`
);

// OpenCode sanitizes MCP tool names as <server>_<raw tool name>, preserving
// hyphens. The Borg raw tool prefix is itself `borg_`.
export const OPENCODE_BORG_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map(
  (name) => `borg_borg_${name}`
);

type ApprovalAction = 'auto' | 'prompt' | 'writes' | 'approve';
type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';

export interface ApprovalInspection {
  restrictiveTools: string[];
  repairSnippet: string;
}

export interface LaunchApprovalDecision {
  codexArgs: string[];
  openCodePermission?: string;
  warning?: string;
}

function parseCodexModes(text: string): {
  defaultMode?: ApprovalAction;
  toolModes: Map<string, ApprovalAction>;
} {
  let section: 'other' | 'borg' | { tool: string } = 'other';
  let defaultMode: ApprovalAction | undefined;
  const toolModes = new Map<string, ApprovalAction>();

  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      if (header[1] === 'mcp_servers.borg') {
        section = 'borg';
      } else {
        const tool = header[1].match(/^mcp_servers\.borg\.tools\."([^"]+)"$/);
        section = tool ? { tool: tool[1] } : 'other';
      }
      continue;
    }

    const value = line.match(
      /^\s*(default_tools_approval_mode|approval_mode)\s*=\s*["'](auto|prompt|writes|approve)["']\s*(?:#.*)?$/
    );
    if (!value) continue;
    const mode = value[2] as ApprovalAction;
    if (section === 'borg' && value[1] === 'default_tools_approval_mode') {
      defaultMode = mode;
    } else if (typeof section === 'object' && value[1] === 'approval_mode') {
      toolModes.set(section.tool, mode);
    }
  }

  return { ...(defaultMode ? { defaultMode } : {}), toolModes };
}

export function codexApprovalRepairSnippet(tools = CODEX_BORG_COORDINATION_TOOLS): string {
  return tools
    .map(
      (tool) =>
        `[mcp_servers.borg.tools."${tool}"]\n` +
        `approval_mode = "auto"`
    )
    .join('\n\n');
}

export function inspectCodexBorgApprovals(text: string): ApprovalInspection {
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

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function effectiveOpenCodePermission(
  permission: unknown,
  tool: string
): OpenCodePermissionAction | undefined {
  if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
    return permission;
  }
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) return undefined;

  let result: OpenCodePermissionAction | undefined;
  for (const [pattern, action] of Object.entries(permission as Record<string, unknown>)) {
    if (
      globMatches(pattern, tool) &&
      (action === 'allow' || action === 'ask' || action === 'deny')
    ) {
      result = action;
    }
  }
  return result;
}

export function openCodeApprovalRepairObject(
  tools = OPENCODE_BORG_COORDINATION_TOOLS
): Record<string, OpenCodePermissionAction> {
  return Object.fromEntries(tools.map((tool) => [tool, 'allow'])) as Record<
    string,
    OpenCodePermissionAction
  >;
}

/** Preserve every existing OpenCode permission rule, then append the exact
 * Borg coordination allows. This remains safe whether OPENCODE_PERMISSION is
 * deep-merged or replaces the configured permission value. */
export function mergeOpenCodePermission(
  permission: unknown,
  tools = OPENCODE_BORG_COORDINATION_TOOLS
): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
    existing = { '*': permission };
  } else if (permission && typeof permission === 'object' && !Array.isArray(permission)) {
    existing = { ...(permission as Record<string, unknown>) };
  }
  // Reinsert exact keys at the END. OpenCode resolves matching permission
  // patterns in order, so merely overwriting an earlier exact key would keep
  // its old insertion position and a later wildcard could still win.
  const toolSet = new Set<string>(tools);
  const preserved = Object.fromEntries(
    Object.entries(existing).filter(([key]) => !toolSet.has(key))
  );
  return { ...preserved, ...openCodeApprovalRepairObject(tools) };
}

export function inspectOpenCodeBorgApprovals(config: unknown): ApprovalInspection {
  const permission =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, unknown>).permission
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

export function codexBorgApprovalArgs(tools = CODEX_BORG_COORDINATION_TOOLS): string[] {
  return tools.flatMap((tool) => [
    '-c',
    `mcp_servers.borg.tools."${tool}".approval_mode="auto"`,
  ]);
}

export interface ApprovalIo {
  readCodexConfig: () => string;
  readOpenCodeConfig: () => unknown;
  isTTY: () => boolean;
  confirm: (message: string) => Promise<string>;
}

export function defaultApprovalIo(
  confirm: (message: string) => Promise<string>,
  isTTY: () => boolean,
  env: NodeJS.ProcessEnv = process.env
): ApprovalIo {
  return {
    readCodexConfig: () => {
      const file = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    },
    readOpenCodeConfig: () => {
      const file = env.OPENCODE_CONFIG || path.join(
        env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode'),
        'opencode.json'
      );
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

function accepted(answer: string): boolean {
  return /^(?:y|yes)$/i.test(answer.trim());
}

export async function resolveLaunchBorgApprovals(
  cli: BorgCli,
  io: ApprovalIo
): Promise<LaunchApprovalDecision> {
  if (cli === 'claude') return { codexArgs: [] };

  let inspection: ApprovalInspection;
  let openCodeConfig: unknown;
  try {
    if (cli === 'codex') {
      inspection = inspectCodexBorgApprovals(io.readCodexConfig());
    } else {
      openCodeConfig = io.readOpenCodeConfig();
      inspection = inspectOpenCodeBorgApprovals(openCodeConfig);
    }
  } catch (error: any) {
    return {
      codexArgs: [],
      warning: `Could not inspect ${cli} Borg tool approvals: ${error?.message ?? error}. No approval override was applied.`,
    };
  }
  if (inspection.restrictiveTools.length === 0) return { codexArgs: [] };

  const intro = `${cli === 'codex' ? 'Codex' : 'OpenCode'} requires approval for ${inspection.restrictiveTools.length} Borg coordination tool${inspection.restrictiveTools.length === 1 ? '' : 's'}.`;
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
    openCodePermission: JSON.stringify(mergeOpenCodePermission(
      openCodeConfig && typeof openCodeConfig === 'object'
        ? (openCodeConfig as Record<string, unknown>).permission
        : undefined,
      inspection.restrictiveTools
    )),
  };
}

export function buildOpenCodeLaunchArgs(
  cwd: string,
  port: number,
  prompt: string,
  passthroughArgs: string[] = []
): string[] {
  // Deliberately no `--auto`: that switch auto-approves unrelated shell/file
  // actions. Exact Borg coordination consent is carried in the child env.
  return [cwd, '--port', String(port), '--prompt', prompt, ...passthroughArgs];
}

export function setupApprovalWarnings(deps: Pick<ApprovalIo, 'readCodexConfig' | 'readOpenCodeConfig'>): string[] {
  const warnings: string[] = [];
  try {
    const codex = inspectCodexBorgApprovals(deps.readCodexConfig());
    if (codex.restrictiveTools.length > 0) {
      warnings.push(`Codex Borg coordination approvals are restrictive. Borg launches will offer a launch-only fix. Global repair:\n${codex.repairSnippet}`);
    }
  } catch (error: any) {
    warnings.push(`Could not inspect Codex Borg tool approvals: ${error?.message ?? error}`);
  }
  try {
    const opencode = inspectOpenCodeBorgApprovals(deps.readOpenCodeConfig());
    if (opencode.restrictiveTools.length > 0) {
      warnings.push(`OpenCode Borg coordination approvals are restrictive. Borg launches will offer a launch-only fix. Global repair:\n${opencode.repairSnippet}`);
    }
  } catch (error: any) {
    warnings.push(`Could not inspect OpenCode Borg tool approvals: ${error?.message ?? error}`);
  }
  return warnings;
}
