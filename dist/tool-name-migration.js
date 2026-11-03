import { LEGACY_TOOL_ALIASES } from './tool-names.js';
export class ToolNameMigrationError extends Error {
    constructor(host, detail) {
        super(`${host} Borg tool-name migration required: ${detail} Update tool-specific permissions and enabled/disabled tool lists to the underscore names, preserving each rule's scope, action and order, then relaunch. See docs/TOOL_NAME_MIGRATION.md. No launch-only approval override was applied.`);
        this.name = 'ToolNameMigrationError';
    }
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
/** A rename must never silently unmatch a host-side restriction. Inspect raw
 * sources too: an effective merge can hide a managed rule or an agent policy.
 * Do not translate arbitrary globs, reorder rules, or edit operator settings. */
export function assertToolNamePoliciesMigrated(host, config) {
    const check = (selector) => {
        // Claude input specifiers do not affect matching the tool-name position.
        const pattern = host === 'claude' ? selector.split('(')[0]
            : host === 'opencode' ? selector.split(':')[0] : selector;
        for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
            const oldNames = spellings(host, legacy);
            const newNames = spellings(host, canonical);
            if (oldNames.some((oldName, index) => matches(pattern, oldName) && !matches(pattern, newNames[index]))) {
                // Static identifiers only: policies can contain credentials or inputs.
                throw new ToolNameMigrationError(host, `a policy still selects ${oldNames[0]} instead of ${newNames[0]}.`);
            }
        }
        if ((host === 'codex' || pattern.includes('borg') || pattern.startsWith('*')) && /[\[\]{}]/.test(pattern)) {
            throw new ToolNameMigrationError(host, 'a Borg tool selector uses unsupported pattern syntax; replace it with explicit canonical tool names.');
        }
    };
    const visit = (value, policy) => {
        if (typeof value === 'string') {
            if (policy)
                check(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const entry of value)
                visit(entry, policy);
            return;
        }
        if (!value || typeof value !== 'object')
            return;
        for (const [key, entry] of Object.entries(value)) {
            if (policy)
                check(key);
            // Only policy fields are selectors; env, descriptions and tool inputs are not.
            visit(entry, policy || POLICY_FIELDS.has(key));
        }
    };
    visit(config, false);
}
//# sourceMappingURL=tool-name-migration.js.map