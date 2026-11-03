import { describe, expect, it } from 'vitest';
import { TOOL_MANIFEST } from '../src/tool-manifest.js';
import { canonicalToolName, LEGACY_TOOL_ALIASES, MAIN_TOOL_NAMES, REPRESENTATIVE_CANONICAL_TOOL_NAMES, toolNameSpellings } from '../src/tool-names.js';
import { assertToolNamePoliciesMigrated, ToolNameMigrationError } from '../src/tool-name-migration.js';
import { resolveLaunchBorgApprovals } from '../src/cli-tool-approval.js';
import { applyOpenCodeV2LaunchPermissions } from '../src/opencode-v2-permissions.js';

describe('canonical tool names', () => {
  it('advertises exactly the canonical main catalog with valid JavaScript identifiers', () => {
    expect(TOOL_MANIFEST.map(tool => tool.name)).toEqual([...MAIN_TOOL_NAMES]);
    const names = [...MAIN_TOOL_NAMES, ...REPRESENTATIVE_CANONICAL_TOOL_NAMES];
    expect(new Set(names).size).toBe(46);
    expect(names.every(name => /^borg_[a-z_]+$/.test(name))).toBe(true);
    expect(Object.keys(LEGACY_TOOL_ALIASES).some(name => names.includes(name as any))).toBe(false);
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES)) {
      expect(names).toContain(canonical);
      expect(canonicalToolName(legacy)).toBe(canonical);
      expect(canonicalToolName(canonical)).toBe(canonical);
      expect(toolNameSpellings(canonical)).toEqual([canonical, legacy]);
    }
  });
  it('does not normalize invented names or inherit object prototype properties', () => {
    for (const name of ['borg-read-log', 'borg_read--log', '__proto__', 'constructor', 'toString', 'borg_missing-tool']) {
      expect(canonicalToolName(name)).toBe(name);
    }
  });
});

describe('host-side policy migration', () => {
  it.each([
    ['claude', { permissions: { deny: ['mcp__borg__borg_read-log'] } }],
    ['claude', { permissions: { deny: ['mcp__borg__borg_read_log'] } }],
    ['claude', { sources: [{ settings: { permissions: { ask: ['mcp__borg__*-log'] } } }] }],
    ['codex', { disabled_tools: ['borg_read-log'] }],
    ['codex', { disabled_tools: ['borg_read_log'] }],
    ['codex', { enabled_tools: ['read-log'] }],
    ['codex', { tools: { 'borg:read-log': { approval_mode: 'approve' } } }],
    ['opencode', { permission: { 'borg_borg_read-*': 'deny' } }],
    ['opencode', { agent: { build: { tools: { 'borg_borg_read-log': false } } } }],
    ['opencode', { permissions: [{ action: 'borg_borg_read-log', resource: '*', effect: 'ask' }] }],
    ['opencode', { policies: [{ action: 'tool.use', resource: 'borg_borg_read-log:*', effect: 'deny' }] }],
    ['opencode', { permissions: [{ action: 'borg_borg_representative-*', resource: '*', effect: 'deny' }] }],
  ] as const)('refuses %s policies that would lose their old target', (host, config) => {
    expect(() => assertToolNamePoliciesMigrated(host, config)).toThrow(ToolNameMigrationError);
  });
  it.each(['claude', 'codex', 'opencode'] as const)('preserves generic and migrated %s selectors without editing config', host => {
    const config = { permissions: { deny: ['*', '*borg*', '*read*', 'mcp__borg__*', 'borg_borg_*', 'borg:*', 'borg_regen'] }, env: { PRIVATE: 'borg_read-log' } };
    const before = structuredClone(config);
    expect(() => assertToolNamePoliciesMigrated(host, config)).not.toThrow();
    expect(config).toEqual(before);
  });
  it.each([
    ['claude', { permissions: { deny: ['mcp__borg__borg_read-log', 'mcp__borg__borg_read_log'] } }],
    ['codex', { disabled_tools: ['borg_read-log', 'borg_read_log'] }],
    ['codex', { tools: { 'borg:read-log': { approval_mode: 'approve' }, 'borg:read_log': { approval_mode: 'approve' } } }],
    ['opencode', { permission: { 'borg_borg_read-log': 'deny', 'borg_borg_read_log': 'deny' } }],
    ['opencode', { permissions: [{ action: 'borg_borg_read-log', resource: 'private', effect: 'deny' }, { action: 'borg_borg_read_log', resource: 'private', effect: 'deny' }] }],
    ['opencode', { policies: [{ action: 'tool.use', resource: 'borg_borg_read-log:*', effect: 'deny' }, { action: 'tool.use', resource: 'borg_borg_read_log:*', effect: 'deny' }] }],
  ] as const)('accepts adjacent equivalent %s policies for both spellings', (host, config) => {
    expect(() => assertToolNamePoliciesMigrated(host, config)).not.toThrow();
  });
  it('refuses mismatched effects, resources, order and guessed glob rewrites', () => {
    for (const permissions of [
      [{ action: 'borg_borg_read-log', resource: '*', effect: 'deny' }, { action: 'borg_borg_read_log', resource: '*', effect: 'allow' }],
      [{ action: 'borg_borg_read-log', resource: 'private', effect: 'deny' }, { action: 'borg_borg_read_log', resource: '*', effect: 'deny' }],
      [{ action: 'borg_borg_read-log', resource: '*', effect: 'deny' }, { action: '*', resource: '*', effect: 'allow' }, { action: 'borg_borg_read_log', resource: '*', effect: 'deny' }],
      [{ action: 'borg_borg_read-*', resource: '*', effect: 'deny' }, { action: 'borg_borg_read_*', resource: '*', effect: 'deny' }],
    ]) expect(() => assertToolNamePoliciesMigrated('opencode', { permissions })).toThrow(ToolNameMigrationError);
    expect(() => assertToolNamePoliciesMigrated('opencode', { permissions: [
      { action: 'external_directory', resource: 'borg_read_log', effect: 'deny' },
    ] })).not.toThrow();
  });
  it('fails before overrides and cannot be bypassed with --no-borg-approval-override', async () => {
    for (const skipOverride of [false, true]) {
      let reads = 0;
      const io = { readCodexConfig: () => { reads++; return { mcp_servers: { borg: { disabled_tools: ['borg_read-log'] } } }; },
        readOpenCodeConfig: () => ({}), confirm: async () => 'yes', isTTY: () => true };
      await expect(resolveLaunchBorgApprovals('codex', io, { skipOverride })).rejects.toThrow(ToolNameMigrationError);
      expect(reads).toBe(1);
    }
  });
  it('refuses unavailable native policy rather than falling back to a permissive launch', async () => {
    for (const host of ['claude', 'codex', 'opencode'] as const) {
      const fail = () => { throw new Error('private-path-and-token'); };
      const promise = resolveLaunchBorgApprovals(host, { readClaudeConfig: fail, readCodexConfig: fail, readOpenCodeConfig: fail, confirm: async () => 'yes', isTTY: () => false });
      await expect(promise).rejects.toThrow(ToolNameMigrationError);
      await expect(promise).rejects.not.toThrow('private-path-and-token');
    }
  });
  it('checks native V2 documents, agent and session rules before any mutation', async () => {
    for (const source of ['document', 'agent', 'session']) {
      let mutations = 0;
      const rule = { action: 'borg_borg_read-log', resource: '*', effect: 'deny' };
      const client = {
        session: { get: async () => ({ permissions: source === 'session' ? [rule] : [] }), update: async () => { mutations++; } },
        config: { get: async () => [{ type: 'document', info: source === 'document' ? { permissions: [rule] } : {} }] },
        agent: { get: async () => ({ data: { permissions: source === 'agent' ? [rule] : [] } }) },
      };
      await expect(applyOpenCodeV2LaunchPermissions(client as any, 'fixture', '/fixture', false)).rejects.toThrow(ToolNameMigrationError);
      expect(mutations).toBe(0);
    }
  });
});
