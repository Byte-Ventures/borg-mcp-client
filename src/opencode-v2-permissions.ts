import type { OpenCodeClient } from '@opencode/client';
import { BORG_COORDINATION_TOOLS, BORG_DISPATCHER_APPROVAL_DISCLOSURE } from './cli-tool-approval.js';
import { isCanonicalPath } from './private-root.js';

export interface OpenCodeV2Permission { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }
export const OPENCODE_V2_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map(name => `borg_borg_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_'));
const matches = (pattern: string, input: string) => new RegExp(`^${pattern.split('*').map(part => part.split('?').map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`, process.platform === 'win32' ? 'i' : '').test(input);
export function effectiveOpenCodeV2Permission(rules: readonly OpenCodeV2Permission[], action: string, resource = '*'): OpenCodeV2Permission['effect'] {
  let result: OpenCodeV2Permission['effect'] = 'ask';
  for (const rule of rules) if (matches(rule.action, action) && matches(rule.resource, resource)) result = rule.effect;
  return result;
}

/** Query only the owned server; `opencode debug config` starts a shared V2 service. */
export async function applyOpenCodeV2LaunchPermissions(client: OpenCodeClient, sessionID: string, directory: string, skipOverride: boolean,
  accessDirectories: readonly string[] = []): Promise<string[]> {
  const session = await client.session.get({ sessionID });
  const entries = await client.config.get({ location: { directory } });
  const documents = entries.flatMap(entry => entry.type === 'document' ? [entry.info] : []);
  const agentID = session.agent ?? documents.reduce((id, document) => document.default_agent ?? id, 'build');
  const agent = await client.agent.get({ agentID, location: { directory } });
  const rules = [...agent.data.permissions, ...(session.permissions ?? [])];
  const restrictive = OPENCODE_V2_COORDINATION_TOOLS.filter(tool => effectiveOpenCodeV2Permission(rules, tool) !== 'allow');
  const warnings: string[] = [];
  const access: OpenCodeV2Permission[] = [];
  for (const pathname of new Set(accessDirectories)) {
    if (!isCanonicalPath(pathname)) throw new Error('OpenCode launch access directory is not canonical.');
    const resource = `${pathname.replace(/\\/g, '/').replace(/\/$/, '')}/*`;
    const explicit = rules.some(rule => matches(rule.action, 'external_directory') && rule.resource !== '*' &&
      matches(rule.resource, resource) && rule.effect !== 'allow');
    if (!explicit && effectiveOpenCodeV2Permission(rules, 'external_directory', resource) !== 'allow') {
      access.push({ action: 'external_directory', resource, effect: 'allow' });
    }
  }
  if (effectiveOpenCodeV2Permission(rules, 'execute') === 'deny') warnings.push('OpenCode denies execute. Borg will not override this; enable Code Mode yourself or explicitly configure mcp.servers.borg.codemode=false to expose Borg tools directly.');
  if (restrictive.length) {
    const additions = restrictive.map(action => ({ action, resource: '*', effect: 'allow' as const }));
    warnings.push(skipOverride
      ? `OpenCode restricts ${restrictive.length} Borg coordination tools. To allow them, append: ${JSON.stringify({ permissions: additions })}`
      : `Applied launch-only approvals for ${restrictive.length} Borg coordination tools. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE}`);
  }
  // A parent-directory grant must not erase narrower operator rules. Replay
  // scoped directory rules in their original order, including exceptions that
  // allow a child of a denied directory. Global defaults still allow the new
  // grant to do its intended work.
  const scopedDirectoryRules = access.length ? rules.filter(rule =>
    matches(rule.action, 'external_directory') && rule.resource !== '*')
    .map(rule => ({ ...rule, action: 'external_directory' })) : [];
  if (access.length || (restrictive.length && !skipOverride)) await client.session.update({ sessionID, permissions: [
    ...(session.permissions ?? []), ...access, ...scopedDirectoryRules,
    ...(!skipOverride ? restrictive.map(action => ({ action, resource: '*', effect: 'allow' as const })) : []),
  ] });
  return warnings;
}
