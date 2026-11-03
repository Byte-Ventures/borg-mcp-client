import { LEGACY_TOOL_ALIASES } from './tool-names.js';

export type ToolPolicyHost = 'claude' | 'codex' | 'opencode';

export class ToolNameMigrationError extends Error {
  constructor(host: ToolPolicyHost, detail: string) {
    super(`${host} Borg tool-name migration required: ${detail} Cover both canonical and legacy names in tool-specific policies, preserving each rule's scope, action and order, then relaunch. See docs/TOOL_NAME_MIGRATION.md. No launch-only approval override was applied.`);
    this.name = 'ToolNameMigrationError';
  }
}

const POLICY_FIELDS = new Set([
  'tools', 'enabled_tools', 'disabled_tools', 'enabledTools', 'disabledTools',
  'allowed_tools', 'disallowed_tools', 'allowedTools', 'disallowedTools',
  'permissions', 'permission', 'policies', 'allow', 'ask', 'deny', 'action',
]);

function spellings(host: ToolPolicyHost, raw: string): string[] {
  if (host === 'claude') return [`mcp__borg__${raw}`];
  if (host === 'opencode') return [`borg_${raw}`, raw];
  // Codex releases have used both raw MCP names and qualified display names.
  return [raw, `borg:${raw.slice(5)}`, raw.slice(5)];
}

function matches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '').test(value);
}

/** Permission selectors need both spellings while hidden aliases are callable. */
export function toolPolicySpellings(host: ToolPolicyHost, name: string): string[] {
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
    const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
    const index = newNames.indexOf(name);
    if (index !== -1) return [name, oldNames[index]];
  }
  return [name];
}

/** Inspect without rewriting. Exact pairs must be adjacent with identical
 * scope/effect; arbitrary globs must already match both names. This keeps
 * ordered policy semantics and cannot broaden a glob by guessing its rewrite. */
export function assertToolNamePoliciesMigrated(host: ToolPolicyHost, config: unknown): void {
  const patternOf = (selector: string) => host === 'claude' ? selector.split('(')[0]
    : host === 'opencode' ? selector.split(':')[0] : selector;
  const counterpart = (selector: string): string | undefined => {
    const pattern = patternOf(selector);
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
      const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
      const index = oldNames.indexOf(pattern), reverse = newNames.indexOf(pattern);
      if (index !== -1) return newNames[index] + selector.slice(pattern.length);
      if (reverse !== -1) return oldNames[reverse] + selector.slice(pattern.length);
    }
    return undefined;
  };
  const canonicalSelector = (selector: string): string => {
    const pattern = patternOf(selector);
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
      const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
      const index = oldNames.indexOf(pattern);
      if (index !== -1) return newNames[index] + selector.slice(pattern.length);
    }
    return selector;
  };
  // Rule comparisons normalize selector fields only, never an input/resource
  // value that merely mentions a tool, and never mutate the inspected source.
  const comparableRule = (value: unknown): string => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key,
      (key === 'action' || (key === 'resource' && (value as Record<string, unknown>).action === 'tool.use')) && typeof entry === 'string'
        ? canonicalSelector(entry) : entry])) : value);
  const check = (selector: string, peers: unknown[]) => {
    const pattern = patternOf(selector);
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
      const oldNames = spellings(host, legacy), newNames = spellings(host, canonical);
      if (oldNames.some((oldName, index) => matches(pattern, oldName) !== matches(pattern, newNames[index]))) {
        const paired = counterpart(selector);
        if (paired !== undefined && peers.includes(paired)) continue;
        throw new ToolNameMigrationError(host, `a policy does not cover both ${oldNames[0]} and ${newNames[0]} equivalently.`);
      }
    }
    if ((host === 'codex' || pattern.includes('borg') || pattern.startsWith('*')) && /[\[\]{}]/.test(pattern)) {
      throw new ToolNameMigrationError(host, 'a Borg tool selector uses unsupported pattern syntax; use adjacent exact canonical/legacy pairs.');
    }
  };
  const visit = (value: unknown, policy: boolean, peers: unknown[] = []) => {
    if (typeof value === 'string') { if (policy) check(value, peers); return; }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, policy, [value[index - 1], value[index + 1]]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entries = Object.entries(value);
    entries.forEach(([key, entry], index) => {
      // Ordinary permission resources are paths/commands, not tool selectors.
      if (key === 'resource' && (value as Record<string, unknown>).action !== 'tool.use') return;
      if (policy) check(key, [entries[index - 1], entries[index + 1]]
        .filter(neighbor => neighbor && comparableRule(neighbor[1]) === comparableRule(entry)).map(neighbor => neighbor[0]));
      const pairedEntries = peers.filter(peer => comparableRule(peer) === comparableRule(value))
        .map(peer => peer && typeof peer === 'object' ? (peer as Record<string, unknown>)[key] : undefined);
      visit(entry, policy || POLICY_FIELDS.has(key), pairedEntries);
    });
  };
  visit(config, false);
}
