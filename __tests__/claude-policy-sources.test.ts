import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectClaudePolicySources } from '../src/claude-policy-sources.js';
import { ToolNameMigrationError, assertClaudeHookPoliciesMigrated, assertToolNamePoliciesMigrated } from '../src/tool-name-migration.js';
import { claudeToolPolicyArgs } from '../src/claude-effective-settings.js';

const oldName = 'mcp__borg__borg_remove-document';
const newName = 'mcp__borg__borg_remove_document';
let root: string, cwd: string, config: string;
const write = (path: string, value: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const definition = (policy: string) => `---\nname: safety\ndescription: Fixture policy\n${policy}\n---\nFixture body.\n`;
const inspect = (args: string[] = [], settings: unknown = { effective: {} }) => inspectClaudePolicySources(args, cwd,
  { HOME: root, CLAUDE_CONFIG_DIR: config }, settings);
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-claude-policies-')));
  cwd = join(root, 'repo', 'src'); config = join(root, 'user-config');
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(root, 'repo', '.git'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Claude hook migration', () => {
  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'])(
    'refuses an asymmetric %s matcher even when another hook covers the other spelling', event => {
      const hooks = { [event]: [
        { matcher: oldName, hooks: [{ type: 'command', command: 'exit 2' }] },
        { matcher: newName, hooks: [{ type: 'command', command: 'exit 0' }] },
      ] };
      expect(() => assertClaudeHookPoliciesMigrated({ hooks })).toThrow(ToolNameMigrationError);
    });
  it('accepts equivalent regexes and preserves handler data without executing it', () => {
    const marker = join(root, 'must-not-run');
    const value = { sources: [{ settings: { hooks: { PreToolUse: [{ matcher: '^mcp__borg__borg_(remove[-_]document|tool)$',
      hooks: [{ type: 'command', command: `touch ${marker}` }] }] } } }] };
    const before = structuredClone(value);
    expect(() => assertClaudeHookPoliciesMigrated(value)).not.toThrow();
    expect(value).toEqual(before); expect(existsSync(marker)).toBe(false);
  });
  it('rejects malformed matchers and asymmetric tool conditions', () => {
    expect(() => assertClaudeHookPoliciesMigrated({ hooks: { PreToolUse: [{ matcher: '[' }] } })).toThrow(ToolNameMigrationError);
    expect(() => assertClaudeHookPoliciesMigrated({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ if: oldName, type: 'command', command: 'exit 2' }] }] } })).toThrow(ToolNameMigrationError);
    expect(() => assertClaudeHookPoliciesMigrated({ hooks: { SessionStart: [{ matcher: 'startup', hooks: [] }] } })).not.toThrow();
  });
});

describe('Claude CLI policy effects', () => {
  it.each([
    ['--allowedTools', newName, '--disallowedTools', oldName, 'mcp__borg__borg_tool'],
    ['--tools', newName, '--disallowedTools', oldName],
    ['--allowedTools', oldName, '--allowedTools', newName],
  ])('never pairs selectors across flags or effects: %s', (...args) => {
    expect(() => assertToolNamePoliciesMigrated('claude', { permissions: claudeToolPolicyArgs(args) })).toThrow(ToolNameMigrationError);
  });
  it('accepts equivalent spellings within each flag', () => {
    const policies = claudeToolPolicyArgs(['--allowedTools', `${oldName},${newName}`, '--disallowedTools', `${oldName},${newName}`]);
    expect(policies).toEqual([{ allow: [oldName, newName] }, { deny: [oldName, newName] }]);
    expect(() => assertToolNamePoliciesMigrated('claude', { permissions: policies })).not.toThrow();
  });
});

describe('Claude definition source inspection', () => {
  it.each(['agents', 'commands'])( 'checks nested project %s definitions instead of relying on get_settings', kind => {
    write(join(root, 'repo', '.claude', kind, 'nested', 'safety.md'), definition(`disallowedTools: ${oldName}`));
    expect(() => inspect(['--agent', 'safety'])).toThrow(ToolNameMigrationError);
  });
  it('parses YAML arrays, folded values and user config overrides', () => {
    write(join(config, 'agents', 'safety.md'), definition(`disallowedTools:\n  - ${oldName}\n  - Read\n  - ${newName}\ntools: >-\n  ${oldName},\n  ${newName}`));
    expect(() => inspect()).not.toThrow();
  });
  it('checks inline and file-based CLI definitions, including frontmatter hooks', () => {
    const agents = { safety: { description: 'Fixture', prompt: 'Fixture', disallowedTools: [oldName] } };
    expect(() => inspect(['--agents', JSON.stringify(agents), '--agent', 'safety'])).toThrow(ToolNameMigrationError);
    write(join(root, 'agents.json'), JSON.stringify(agents));
    expect(() => inspect(['--agents=' + join(root, 'agents.json')])).toThrow(ToolNameMigrationError);
    write(join(config, 'agents', 'hooks.md'), definition(`hooks:\n  PreToolUse:\n    - matcher: ${oldName}\n      hooks:\n        - type: command\n          command: exit 2`));
    expect(() => inspect()).toThrow(ToolNameMigrationError);
  });
  it('checks additional directories and skill entrypoints while ignoring ancillary markdown', () => {
    const additional = join(root, 'additional');
    write(join(additional, '.claude', 'skills', 'safe', 'README.md'), '---\ninvalid ancillary metadata');
    expect(() => inspect(['--add-dir', additional])).not.toThrow();
    write(join(additional, '.claude', 'skills', 'safe', 'SKILL.md'), definition(`allowed-tools: ${oldName}`));
    expect(() => inspect(['--add-dir', additional])).toThrow(ToolNameMigrationError);
  });
  it('refuses malformed and duplicate-key frontmatter without leaking its content', () => {
    write(join(config, 'agents', 'safety.md'), definition(`disallowedTools: ${oldName}\ndisallowedTools: []\nprivate: secret-value`));
    expect(() => inspect()).toThrow(ToolNameMigrationError);
    expect(() => inspect()).not.toThrow('secret-value');
  });
  it('resolves YAML policy merges and refuses cyclic definitions', () => {
    const agent = join(config, 'agents', 'safety.md');
    write(agent, definition(`defaults: &defaults\n  disallowedTools: ${oldName}\n<<: *defaults`));
    expect(() => inspect()).toThrow(ToolNameMigrationError);
    write(agent, definition(`defaults: &defaults\n  disallowedTools: [${oldName}, ${newName}]\n<<: *defaults`));
    expect(() => inspect()).not.toThrow();
    write(agent, definition('cycle: &cycle\n  self: *cycle'));
    expect(() => inspect()).toThrow(ToolNameMigrationError);
  });
  it('handles symlink cycles without skipping a linked restricted definition', () => {
    const agents = join(config, 'agents'); mkdirSync(agents, { recursive: true });
    symlinkSync(agents, join(agents, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => inspect()).not.toThrow();
    write(join(agents, 'safety.md'), definition(`disallowedTools: ${oldName}`));
    expect(() => inspect()).toThrow(ToolNameMigrationError);
  });
  it('checks enabled installed and explicit plugin agents and custom hook files', () => {
    const plugin = join(root, 'plugin');
    write(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'safety@fixture': [{ scope: 'user', installPath: plugin }],
    } }));
    write(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'safety', agents: ['./custom/safety.md'], hooks: ['./custom/hooks.json'] }));
    write(join(plugin, 'custom', 'safety.md'), definition(`disallowedTools: [${oldName}, ${newName}]`));
    write(join(plugin, 'custom', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: oldName, hooks: [{ type: 'command', command: 'exit 2' }] }] } }));
    expect(() => inspect([], { effective: { enabledPlugins: { 'safety@fixture': true } } })).toThrow(ToolNameMigrationError);
    expect(() => inspect(['--plugin-dir', plugin])).toThrow(ToolNameMigrationError);
    write(join(plugin, 'custom', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^mcp__borg__borg_remove[-_]document$', hooks: [] }] } }));
    expect(() => inspect(['--plugin-dir', plugin])).not.toThrow();
  });
  it('fails closed for unavailable plugin metadata and remote-only plugins', () => {
    expect(() => inspect([], { effective: { enabledPlugins: { 'missing@fixture': true } } })).toThrow(ToolNameMigrationError);
    expect(() => inspect(['--plugin-url', 'https://example.invalid/plugin'])).toThrow(ToolNameMigrationError);
  });
});
