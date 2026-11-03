import { LEGACY_TOOL_ALIASES } from './tool-names.js';
export class ToolNameMigrationError extends Error {
    constructor(host, detail) {
        super(`${host} Borg tool-name migration required: ${detail} Cover both canonical and legacy names in tool-specific policies, preserving each rule's scope and action${host === 'opencode' ? ', and keep ordered rule pairs adjacent' : ''}, then relaunch. See docs/TOOL_NAME_MIGRATION.md. No launch-only approval override was applied.`);
        this.name = 'ToolNameMigrationError';
    }
}
const CLAUDE_TOOL_HOOK_EVENTS = new Set([
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied',
]);
/** Claude hook matchers are regular expressions, not permission globs. Inspect
 * each hook independently: two different hooks cannot prove equivalent effects. */
export function assertClaudeHookPoliciesMigrated(config) {
    const inspectHooks = (hooks) => {
        if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
            return;
        for (const [event, entries] of Object.entries(hooks)) {
            if (!CLAUDE_TOOL_HOOK_EVENTS.has(event) || !Array.isArray(entries))
                continue;
            for (const entry of entries) {
                if (!entry || typeof entry !== 'object')
                    continue;
                const matcher = entry.matcher;
                if (matcher !== undefined && matcher !== '' && matcher !== '*') {
                    if (typeof matcher !== 'string')
                        throw new ToolNameMigrationError('claude', 'a tool hook matcher could not be inspected.');
                    let expression;
                    try {
                        expression = new RegExp(matcher);
                    }
                    catch {
                        throw new ToolNameMigrationError('claude', 'a tool hook matcher is not a valid regular expression.');
                    }
                    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
                        if (expression.test(`mcp__borg__${legacy}`) !== expression.test(`mcp__borg__${canonical}`)) {
                            throw new ToolNameMigrationError('claude', 'a tool hook matcher treats canonical and legacy names differently; update that matcher without changing its handler.');
                        }
                    }
                }
                const handlers = entry.hooks;
                if (!Array.isArray(handlers))
                    continue;
                for (const handler of handlers) {
                    if (!handler || typeof handler !== 'object' || !('if' in handler))
                        continue;
                    const conditions = Array.isArray(handler.if) ? handler.if : [handler.if];
                    for (const condition of conditions) {
                        if (typeof condition !== 'string')
                            throw new ToolNameMigrationError('claude', 'a tool hook condition could not be inspected.');
                        assertToolNamePoliciesMigrated('claude', { permissions: [condition] });
                    }
                }
            }
        }
    };
    const visit = (value) => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'hooks')
                inspectHooks(entry);
            visit(entry);
        }
    };
    visit(config);
}
const POLICY_FIELDS = new Set([
    'tools', 'enabled_tools', 'disabled_tools', 'enabledTools', 'disabledTools',
    'allowed_tools', 'disallowed_tools', 'allowedTools', 'disallowedTools',
    'permissions', 'permission', 'policies', 'allow', 'ask', 'deny', 'action',
]);
function spellings(host, raw) {
    if (host === 'claude')
        return [`mcp__borg__${raw}`];
    if (host === 'opencode')
        return [`borg_${raw}`, raw];
    // Codex releases have used both raw MCP names and qualified display names.
    return [raw, `borg:${raw.slice(5)}`, raw.slice(5)];
}
function matches(pattern, value) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '').test(value);
}
/** Permission selectors need both spellings while hidden aliases are callable. */
export function toolPolicySpellings(host, name) {
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
        const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
        const index = newNames.indexOf(name);
        if (index !== -1)
            return [name, oldNames[index]];
    }
    return [name];
}
/** Inspect without rewriting. OpenCode's ordered rules need adjacent pairs;
 * Codex tables and Claude sets have no ordering semantics. */
export function assertToolNamePoliciesMigrated(host, config) {
    const patternOf = (selector) => host === 'claude' ? selector.split('(')[0]
        : host === 'opencode' ? selector.split(':')[0] : selector;
    const counterpart = (selector) => {
        const pattern = patternOf(selector);
        for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
            const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
            const index = oldNames.indexOf(pattern), reverse = newNames.indexOf(pattern);
            if (index !== -1)
                return newNames[index] + selector.slice(pattern.length);
            if (reverse !== -1)
                return oldNames[reverse] + selector.slice(pattern.length);
        }
        return undefined;
    };
    const canonicalSelector = (selector) => {
        const pattern = patternOf(selector);
        for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
            const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
            const index = oldNames.indexOf(pattern);
            if (index !== -1)
                return newNames[index] + selector.slice(pattern.length);
        }
        return selector;
    };
    // Rule comparisons normalize selector fields only, never an input/resource
    // value that merely mentions a tool, and never mutate the inspected source.
    const comparableRule = (value) => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key,
            (key === 'action' || (key === 'resource' && value.action === 'tool.use')) && typeof entry === 'string'
                ? canonicalSelector(entry) : entry])) : value);
    const check = (selector, peers) => {
        const pattern = patternOf(selector);
        for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
            const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
            if (oldNames.some((oldName, index) => matches(pattern, oldName) !== matches(pattern, newNames[index]))) {
                const paired = counterpart(selector);
                if (paired !== undefined && peers.includes(paired))
                    continue;
                throw new ToolNameMigrationError(host, `a policy does not cover both ${oldNames[0]} and ${newNames[0]} equivalently.`);
            }
        }
        if ((host === 'codex' || pattern.includes('borg') || pattern.startsWith('*')) && /[\[\]{}]/.test(pattern)) {
            throw new ToolNameMigrationError(host, 'a Borg tool selector uses unsupported pattern syntax; use adjacent exact canonical/legacy pairs.');
        }
    };
    const visit = (value, policy, peers = []) => {
        if (typeof value === 'string') {
            if (policy)
                check(value, peers);
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry, index) => visit(entry, policy, host === 'opencode'
                ? [value[index - 1], value[index + 1]] : value.filter((_, peerIndex) => peerIndex !== index)));
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        const entries = Object.entries(value);
        entries.forEach(([key, entry], index) => {
            // Ordinary permission resources are paths/commands, not tool selectors.
            if (key === 'resource' && value.action !== 'tool.use')
                return;
            const neighbors = host === 'opencode' ? [entries[index - 1], entries[index + 1]] : entries.filter((_, peerIndex) => peerIndex !== index);
            if (policy)
                check(key, neighbors
                    .filter(neighbor => neighbor && comparableRule(neighbor[1]) === comparableRule(entry)).map(neighbor => neighbor[0]));
            const pairedEntries = peers.filter(peer => comparableRule(peer) === comparableRule(value))
                .map(peer => peer && typeof peer === 'object' ? peer[key] : undefined);
            visit(entry, policy || POLICY_FIELDS.has(key), pairedEntries);
        });
    };
    visit(config, false);
}
//# sourceMappingURL=tool-name-migration.js.map