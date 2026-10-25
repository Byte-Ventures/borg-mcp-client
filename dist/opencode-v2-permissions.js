import { BORG_COORDINATION_TOOLS, BORG_DISPATCHER_APPROVAL_DISCLOSURE } from './cli-tool-approval.js';
export const OPENCODE_V2_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map(name => `borg_borg_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_'));
const matches = (pattern, input) => new RegExp(`^${pattern.split('*').map(part => part.split('?').map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`, process.platform === 'win32' ? 'i' : '').test(input);
export function effectiveOpenCodeV2Permission(rules, action, resource = '*') {
    let result = 'ask';
    for (const rule of rules)
        if (matches(rule.action, action) && matches(rule.resource, resource))
            result = rule.effect;
    return result;
}
/** Query only the owned server; `opencode debug config` starts a shared V2 service. */
export async function applyOpenCodeV2LaunchPermissions(client, sessionID, directory, skipOverride) {
    const session = await client.session.get({ sessionID });
    const entries = await client.config.get({ location: { directory } });
    const documents = entries.flatMap(entry => entry.type === 'document' ? [entry.info] : []);
    const agentID = session.agent ?? documents.reduce((id, document) => document.default_agent ?? id, 'build');
    const agent = await client.agent.get({ agentID, location: { directory } });
    const rules = [...agent.data.permissions, ...(session.permissions ?? [])];
    const restrictive = OPENCODE_V2_COORDINATION_TOOLS.filter(tool => effectiveOpenCodeV2Permission(rules, tool) !== 'allow');
    const warnings = [];
    if (effectiveOpenCodeV2Permission(rules, 'execute') === 'deny')
        warnings.push('OpenCode denies execute. Borg will not override this; enable Code Mode yourself or explicitly configure mcp.servers.borg.codemode=false to expose Borg tools directly.');
    if (restrictive.length) {
        const additions = restrictive.map(action => ({ action, resource: '*', effect: 'allow' }));
        if (!skipOverride)
            await client.session.update({ sessionID, permissions: [...(session.permissions ?? []), ...additions] });
        warnings.push(skipOverride
            ? `OpenCode restricts ${restrictive.length} Borg coordination tools. To allow them, append: ${JSON.stringify({ permissions: additions })}`
            : `Applied launch-only approvals for ${restrictive.length} Borg coordination tools. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE}`);
    }
    return warnings;
}
//# sourceMappingURL=opencode-v2-permissions.js.map