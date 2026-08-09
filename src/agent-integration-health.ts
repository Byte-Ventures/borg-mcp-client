import fs from 'node:fs';
import path from 'node:path';
import which from 'which';
import {
  inspectManagedAgentHookConfigs,
  isOpenCodeMcpServerConfigured,
  type ManagedAgentHookConfigHealth,
  refreshManagedAgentHookConfigs,
  refreshManagedAgentMcpConfigs,
} from './config-utils.js';
import { borgHomeRoot, isCanonicalPath } from './private-root.js';
import { getPackageVersion } from './version.js';
import {
  buildBorgPluginSource,
  installBorgPlugin,
  openCodePluginPath,
} from './opencode-plugin.js';

export const AGENT_HOOK_BINS = [
  'borg-regen',
  'borg-clear-rewake',
  'borg-log-audit',
  'borg-foreign-path-reminder',
  'borg-inbox-monitor',
] as const;

export type AgentHookBinName = typeof AGENT_HOOK_BINS[number];

export interface AgentHookBinHealth {
  name: AgentHookBinName;
  status: 'ok' | 'missing' | 'wrong-owner' | 'version-skew' | 'unreadable';
  resolvedPath?: string;
  owner?: string;
  version?: string;
  detail?: string;
}

export interface AgentIntegrationHealth {
  expectedVersion: string;
  bins: AgentHookBinHealth[];
  issues: Array<AgentHookBinHealth | ManagedAgentHookConfigHealth | OpenCodePluginHealth>;
  hookConfigs: ManagedAgentHookConfigHealth[];
  openCodePlugin: OpenCodePluginHealth;
}

export interface OpenCodePluginHealth {
  path: string;
  configured: boolean;
  status: 'ok' | 'present' | 'absent' | 'missing' | 'outdated' | 'unreadable' | 'refused';
  version?: string;
  detail?: string;
}

export interface InspectAgentIntegrationHealthOptions {
  expectedVersion?: string;
  path?: string;
  homeDir?: string;
  resolveBin?: (name: AgentHookBinName, searchPath: string | undefined) => string | null;
}

function findOwningPackage(startPath: string): { name: string; version: string } | null {
  let directory = path.dirname(startPath);
  const root = path.parse(directory).root;
  while (true) {
    const packagePath = path.join(directory, 'package.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
      if (typeof parsed.name === 'string' && typeof parsed.version === 'string') {
        return { name: parsed.name, version: parsed.version };
      }
    } catch {
      // Keep walking. npm bin links resolve into a package's dist directory.
    }
    if (directory === root) return null;
    directory = path.dirname(directory);
  }
}

function defaultResolveBin(name: AgentHookBinName, searchPath: string | undefined): string | null {
  try {
    return which.sync(name, searchPath === undefined ? undefined : { path: searchPath });
  } catch {
    return null;
  }
}

function inspectOpenCodePlugin(homeDir: string, expectedVersion: string): OpenCodePluginHealth {
  const pluginPath = openCodePluginPath(homeDir);
  const configured = isOpenCodeMcpServerConfigured(
    path.join(homeDir, '.config', 'opencode', 'opencode.json'),
  );
  try {
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(pluginPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (!isCanonicalPath(pluginPath)) {
          return {
            path: pluginPath,
            configured,
            status: 'refused',
            detail: 'plugin path contains a symlink',
          };
        }
        return { path: pluginPath, configured, status: configured ? 'missing' : 'absent' };
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      return {
        path: pluginPath,
        configured,
        status: 'refused',
        detail: 'plugin path is a symlink',
      };
    }
    if (!isCanonicalPath(pluginPath)) {
      return {
        path: pluginPath,
        configured,
        status: 'refused',
        detail: 'plugin path contains a symlink',
      };
    }
    if (!metadata.isFile()) {
      return {
        path: pluginPath,
        configured,
        status: 'refused',
        detail: 'plugin path is not a regular file',
      };
    }
    const source = fs.readFileSync(pluginPath, 'utf8');
    const marker = source.match(/borgmcp-opencode-plugin:([^;\s]+);opencode=/)?.[1];
    if (!configured) {
      return { path: pluginPath, configured, status: 'present', version: marker ?? 'unknown' };
    }
    if (source === buildBorgPluginSource(expectedVersion)) {
      return { path: pluginPath, configured, status: 'ok', version: expectedVersion };
    }
    return { path: pluginPath, configured, status: 'outdated', version: marker ?? 'unknown' };
  } catch (error) {
    return {
      path: pluginPath,
      configured,
      status: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function inspectAgentIntegrationHealth(
  options: InspectAgentIntegrationHealthOptions = {},
): AgentIntegrationHealth {
  const expectedVersion = options.expectedVersion ?? getPackageVersion();
  const homeDir = options.homeDir ?? borgHomeRoot();
  const resolveBin = options.resolveBin ?? defaultResolveBin;
  const bins = AGENT_HOOK_BINS.map((name): AgentHookBinHealth => {
    const found = resolveBin(name, options.path);
    if (!found) return { name, status: 'missing' };
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(found);
    } catch (error) {
      return {
        name,
        status: 'unreadable',
        resolvedPath: found,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const owner = findOwningPackage(resolvedPath);
    if (!owner || owner.name !== 'borgmcp') {
      return {
        name,
        status: 'wrong-owner',
        resolvedPath,
        owner: owner?.name ?? 'unknown',
        version: owner?.version,
      };
    }
    if (owner.version !== expectedVersion) {
      return { name, status: 'version-skew', resolvedPath, owner: owner.name, version: owner.version };
    }
    return { name, status: 'ok', resolvedPath, owner: owner.name, version: owner.version };
  });
  const hookConfigs = inspectManagedAgentHookConfigs(homeDir);
  const openCodePlugin = inspectOpenCodePlugin(homeDir, expectedVersion);
  return {
    expectedVersion,
    bins,
    issues: [
      ...bins.filter((bin) => bin.status !== 'ok'),
      ...hookConfigs.filter((config) => config.status === 'stale' || config.status === 'invalid'),
      ...(openCodePlugin.status === 'unreadable' ||
        (openCodePlugin.status === 'refused' && openCodePlugin.configured) ||
        (openCodePlugin.configured && openCodePlugin.status !== 'ok')
        ? [openCodePlugin]
        : []),
    ],
    hookConfigs,
    openCodePlugin,
  };
}

function renderBin(bin: AgentHookBinHealth, expectedVersion: string): string {
  switch (bin.status) {
    case 'ok': return `${bin.name}: ok (${bin.version})`;
    case 'missing': return `${bin.name}: missing`;
    case 'wrong-owner': return `${bin.name}: wrong owner ${bin.owner}${bin.version ? `@${bin.version}` : ''}${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}`;
    case 'version-skew': return `${bin.name}: version ${bin.version}, expected ${expectedVersion}${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}`;
    case 'unreadable': return `${bin.name}: unreadable${bin.resolvedPath ? ` at ${bin.resolvedPath}` : ''}${bin.detail ? ` (${bin.detail})` : ''}`;
  }
}

function renderOpenCodePlugin(
  plugin: OpenCodePluginHealth,
  expectedVersion: string,
): string {
  const prefix = 'OpenCode borg-orient.js plugin:';
  switch (plugin.status) {
    case 'ok': return `${prefix} ok (${plugin.version})`;
    case 'present': return `${prefix} present`;
    case 'absent': return `${prefix} absent`;
    case 'missing': return `${prefix} missing at ${plugin.path}`;
    case 'outdated': return `${prefix} version ${plugin.version}, expected ${expectedVersion} at ${plugin.path}`;
    case 'unreadable': return `${prefix} unreadable at ${plugin.path}${plugin.detail ? ` (${plugin.detail})` : ''}`;
    case 'refused': return `${prefix} refused at ${plugin.path}${plugin.detail ? ` (${plugin.detail})` : ''}`;
  }
}

export function renderAgentIntegrationHealth(report: AgentIntegrationHealth): string {
  const lines = [
    `Borg agent integration (borgmcp ${report.expectedVersion})`,
    ...report.bins.map((bin) => `  ${renderBin(bin, report.expectedVersion)}`),
    'Hook configuration:',
    ...report.hookConfigs.map((item) => (
      `  ${item.status}: ${item.path}${item.detail ? ` (${item.detail})` : ''}`
    )),
    renderOpenCodePlugin(report.openCodePlugin, report.expectedVersion),
  ];
  for (const bin of report.bins) {
    switch (bin.status) {
      case 'missing':
        lines.push(
          `Repair missing ${bin.name}: npm install --global borgmcp@${report.expectedVersion} --ignore-scripts`,
        );
        break;
      case 'wrong-owner':
      case 'version-skew':
        lines.push(
          `Fix PATH so ${bin.name} resolves to borgmcp@${report.expectedVersion}, then run: borg doctor`,
        );
        break;
      case 'unreadable':
        lines.push(`Fix or replace unreadable ${bin.name}, then run: borg doctor`);
        break;
      case 'ok':
        break;
    }
  }
  for (const config of report.hookConfigs) {
    if (config.status === 'stale') {
      lines.push('Repair stale managed hooks: borg update --yes');
    } else if (config.status === 'invalid') {
      lines.push(config.detail?.startsWith('inventory failed:')
        ? `Restore readable, non-symlinked hook inventory path ${config.path}, then run: borg doctor`
        : `Repair invalid managed hook config ${config.path}, then run: borg update --yes`);
    }
  }
  if (report.openCodePlugin.status === 'missing') {
    lines.push('Repair missing OpenCode plugin: borg update --yes');
  } else if (report.openCodePlugin.status === 'outdated' && report.openCodePlugin.configured) {
    lines.push('Repair OpenCode plugin: borg update --yes');
  } else if (report.openCodePlugin.status === 'unreadable') {
    lines.push(report.openCodePlugin.configured
      ? `Fix or replace unreadable OpenCode plugin ${report.openCodePlugin.path}, then run: borg update --yes`
      : `Fix or remove unreadable OpenCode plugin ${report.openCodePlugin.path}`);
  } else if (report.openCodePlugin.status === 'refused' && report.openCodePlugin.configured) {
    lines.push(
      `Remove or replace the OpenCode plugin path ${report.openCodePlugin.path}, then run: borg update --yes`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function assertAgentIntegrationHealthy(report: AgentIntegrationHealth): void {
  if (report.issues.length === 0) return;
  throw new Error(renderAgentIntegrationHealth(report).trim());
}

export function runDoctor(options: InspectAgentIntegrationHealthOptions & {
  stdout?: (text: string) => void;
} = {}): number {
  const report = inspectAgentIntegrationHealth(options);
  (options.stdout ?? ((text) => process.stdout.write(text)))(renderAgentIntegrationHealth(report));
  return report.issues.length === 0 ? 0 : 1;
}

export function warnIfAgentIntegrationUnhealthy(
  options: InspectAgentIntegrationHealthOptions & { stderr?: (text: string) => void } = {},
): boolean {
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  try {
    const report = inspectAgentIntegrationHealth(options);
    if (report.issues.length === 0) return true;
    stderr(
      `Warning: Borg agent integration is incomplete or version-skewed.\n${renderAgentIntegrationHealth(report)}`,
    );
    return false;
  } catch (error) {
    stderr(
      `Warning: Borg agent integration health check failed; launch continues: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
}

/** Update-time whole-integration refresh. Attempt each independent surface so
 * one malformed config does not hide later repairs, then aggregate failures. */
export function refreshAndVerifyManagedAgentIntegrations(): void {
  const failures: string[] = [];
  try {
    refreshManagedAgentMcpConfigs();
  } catch (error) {
    failures.push(
      `${error instanceof Error ? error.message : String(error)}. ` +
      'Repair the named agent MCP config, then rerun borg update --yes',
    );
  }
  try {
    refreshManagedAgentHookConfigs();
  } catch (error) {
    failures.push(
      `${error instanceof Error ? error.message : String(error)}. ` +
      'Repair the named managed hook config, then rerun borg update --yes',
    );
  }
  if (isOpenCodeMcpServerConfigured()) installBorgPlugin();
  try {
    assertAgentIntegrationHealthy(inspectAgentIntegrationHealth());
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}
