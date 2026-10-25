import { BORG_COORDINATION_TOOLS, BORG_DISPATCHER_APPROVAL_DISCLOSURE } from './cli-tool-approval.js';
import { isCanonicalPath } from './private-root.js';
export const OPENCODE_V2_COORDINATION_TOOLS = BORG_COORDINATION_TOOLS.map(name => `borg_borg_${name}`.replace(/[^a-zA-Z0-9_-]/g, '_'));
const matches = (pattern, input) => new RegExp(`^${pattern.split('*').map(part => part.split('?').map(text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.')).join('.*')}$`, process.platform === 'win32' ? 'i' : '').test(input);
export function effectiveOpenCodeV2Permission(rules, action, resource = '*') {
    let result = 'ask';
    for (const rule of rules)
        if (matches(rule.action, action) && matches(rule.resource, resource))
            result = rule.effect;
    return result;
}
/** Intersect a native * / ? pattern with a literal directory prefix. Each
 * reachable glob position supplies one suffix; every result stays in prefix. */
function scopeDirectoryPattern(pattern, prefix) {
    if (/^\*+$/.test(pattern))
        return [prefix + '*'];
    const close = (positions) => {
        for (const index of positions)
            if (pattern[index] === '*')
                positions.add(index + 1);
        return positions;
    };
    let positions = close(new Set([0]));
    for (let index = 0; index < prefix.length; index++) {
        const next = new Set();
        for (const position of positions) {
            const token = pattern[position];
            if (token === '*')
                next.add(position);
            else if (token === '?' || (token !== undefined && matches(token, prefix[index])))
                next.add(position + 1);
        }
        positions = close(next);
    }
    return [...new Set([...positions].map(position => prefix + pattern.slice(position)))];
}
/** Query only the owned server; `opencode debug config` starts a shared V2 service. */
export async function applyOpenCodeV2LaunchPermissions(client, sessionID, directory, skipOverride, accessDirectories = []) {
    const session = await client.session.get({ sessionID });
    const entries = await client.config.get({ location: { directory } });
    const documents = entries.flatMap(entry => entry.type === 'document' ? [entry.info] : []);
    const agentID = session.agent ?? documents.reduce((id, document) => document.default_agent ?? id, 'build');
    const agent = await client.agent.get({ agentID, location: { directory } });
    const rules = [...agent.data.permissions, ...(session.permissions ?? [])];
    const restrictive = OPENCODE_V2_COORDINATION_TOOLS.filter(tool => effectiveOpenCodeV2Permission(rules, tool) !== 'allow');
    const warnings = [];
    const access = [];
    for (const pathname of new Set(accessDirectories)) {
        if (!isCanonicalPath(pathname))
            throw new Error('OpenCode launch access directory is not canonical.');
        if (/[*?]/.test(pathname)) {
            warnings.push('OpenCode launch directory contains permission wildcard characters. Configure external_directory permissions yourself before accessing it.');
            continue;
        }
        const resource = `${pathname.replace(/\\/g, '/').replace(/\/$/, '')}/*`;
        const explicit = rules.some(rule => matches(rule.action, 'external_directory') && rule.resource !== '*' &&
            matches(rule.resource, resource) && rule.effect !== 'allow');
        const decision = effectiveOpenCodeV2Permission(rules, 'external_directory', resource);
        if (decision === 'deny')
            warnings.push('OpenCode denies access to a launch directory. Borg will preserve this; configure external_directory permissions yourself if access is required.');
        if (!explicit && decision === 'ask') {
            access.push({ action: 'external_directory', resource, effect: 'allow' });
        }
    }
    if (effectiveOpenCodeV2Permission(rules, 'execute') === 'deny')
        warnings.push('OpenCode denies execute. Borg will not override this; enable Code Mode yourself or explicitly configure mcp.servers.borg.codemode=false to expose Borg tools directly.');
    if (restrictive.length) {
        const additions = restrictive.map(action => ({ action, resource: '*', effect: 'allow' }));
        warnings.push(skipOverride
            ? `OpenCode restricts ${restrictive.length} Borg coordination tools. To allow them, append: ${JSON.stringify({ permissions: additions })}`
            : `Applied launch-only approvals for ${restrictive.length} Borg coordination tools. ${BORG_DISPATCHER_APPROVAL_DISCLOSURE}`);
    }
    let permissions = session.permissions ?? [];
    if (access.length) {
        const directoryRules = rules.filter(rule => matches(rule.action, 'external_directory'))
            .map(rule => ({ ...rule, action: 'external_directory' }));
        const boundary = directoryRules.reduce((last, rule, index) => rule.resource === '*' ? index : last, -1) + 1;
        // Retain the complete rule order inside each grant. Restrict every replayed
        // rule to that directory, so neither stale allows nor copied global defaults
        // can affect unrelated paths, including after an operator changes policy.
        const additions = access.flatMap(grant => {
            const scoped = (entries) => entries.flatMap(rule => scopeDirectoryPattern(rule.resource, grant.resource.slice(0, -1)).map(resource => ({ ...rule, resource })));
            return [...scoped(directoryRules.slice(0, boundary)), grant, ...scoped(directoryRules.slice(boundary))];
        });
        const combined = [...permissions, ...additions];
        // An identical later directory pattern always shadows its earlier copy.
        const last = new Map();
        combined.forEach((rule, index) => { if (rule.action === 'external_directory')
            last.set(rule.resource, index); });
        permissions = combined.filter((rule, index) => rule.action !== 'external_directory' || last.get(rule.resource) === index);
    }
    if (access.length || (restrictive.length && !skipOverride))
        await client.session.update({ sessionID, permissions: [
                ...permissions,
                ...(!skipOverride ? restrictive.map(action => ({ action, resource: '*', effect: 'allow' })) : []),
            ] });
    return warnings;
}
//# sourceMappingURL=opencode-v2-permissions.js.map