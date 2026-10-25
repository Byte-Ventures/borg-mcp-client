import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerCommonOpenCodeMcp } from '../src/opencode-common-config.js';
import { buildBorgPluginSource } from '../src/opencode-plugin.js';
import { migrateLegacyOpenCodePlugin, installLaunchOpenCodePlugin, buildBorgV2PluginSource } from '../src/opencode-launch-plugin.js';
import { applyOpenCodeV2LaunchPermissions, effectiveOpenCodeV2Permission } from '../src/opencode-v2-permissions.js';
import { resolveOpenCodeExecutablePath } from '../src/opencode-installation.js';

describe('OpenCode dual config and plugins', () => {
  it('writes a V1-readable registration without changing unrelated JSONC bytes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-oc-config-')));
    try {
      const dir = join(root, '.config', 'opencode'); mkdirSync(dir, { recursive: true });
      const filename = join(dir, 'opencode.jsonc');
      writeFileSync(filename, '{\n  // operator comment\n  "model": "local/model",\n  "plugins": ["user-plugin"],\n  "mcp": {"servers":{"custom":{"type":"local","command":["custom"]}}},\n}\n');
      registerCommonOpenCodeMcp(root, {});
      const source = readFileSync(filename, 'utf8');
      expect(source).toContain('// operator comment'); expect(source).toContain('"plugins": ["user-plugin"]');
      expect(source).toContain('"servers":{"custom":{"type":"local","command":["custom"]}}');
      expect(source).toContain('"OPENCODE_SERVER_PASSWORD":"{env:OPENCODE_SERVER_PASSWORD}"');
      registerCommonOpenCodeMcp(root, {}); expect(readFileSync(filename, 'utf8')).toBe(source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('migrates exact legacy bytes, preserves edits, and keeps generation entrypoints isolated', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-oc-plugin-')));
    try {
      const dir = join(root, '.config', 'opencode', 'plugins'); mkdirSync(dir, { recursive: true });
      const filename = join(dir, 'borg-orient.js');
      writeFileSync(filename, buildBorgPluginSource('6.1.0') + '// user edit\n');
      expect(() => migrateLegacyOpenCodePlugin(root)).toThrow('preserved');
      expect(readFileSync(filename, 'utf8')).toContain('user edit');
      writeFileSync(filename, buildBorgPluginSource('6.1.0')); migrateLegacyOpenCodePlugin(root);
      const privateRoot = join(root, '.config', 'borgmcp');
      const v1 = installLaunchOpenCodePlugin(1, 'v1-launch', privateRoot);
      const v2 = installLaunchOpenCodePlugin(2, 'v2-launch', privateRoot);
      expect(readFileSync(join(v1.directory, 'index.js'), 'utf8')).toContain('export default async function');
      expect(readFileSync(join(v2.directory, 'index.js'), 'utf8')).toContain("id: 'borgmcp.orientation.v2'");
      expect(v1.directory).not.toContain('/opencode/plugins/'); expect(v2.directory).not.toContain('/opencode/plugins/');
      expect(buildBorgV2PluginSource()).toContain("hook('execute.after'");
      expect(buildBorgV2PluginSource()).toContain('hook.dispose()');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('resolves the known Windows native shim target without evaluating a shell', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-oc-shim-')));
    try {
      const bin = join(root, 'node_modules', '@opencode', 'cli', 'bin'); mkdirSync(bin, { recursive: true });
      const native = join(bin, 'opencode.exe'); writeFileSync(native, 'MZfixture');
      const shim = join(root, 'opencode.cmd'); writeFileSync(shim, '"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe" %*');
      expect(resolveOpenCodeExecutablePath(shim, 'win32')).toBe(native);
      writeFileSync(shim, 'run something else'); expect(() => resolveOpenCodeExecutablePath(shim, 'win32')).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('keeps V2 permission ordering and never grants the outer execute tool', async () => {
  const rules = [{ action: '*', resource: '*', effect: 'ask' as const }, { action: 'borg_borg_read_*', resource: '*', effect: 'allow' as const }, { action: 'execute', resource: '*', effect: 'deny' as const }];
  expect(effectiveOpenCodeV2Permission(rules, 'borg_borg_read_log')).toBe('allow');
  expect(effectiveOpenCodeV2Permission(rules, 'borg_borg_log')).toBe('ask');
  const update = vi.fn(async () => {});
  const client: any = { session: { get: async () => ({ agent: 'build', permissions: [{ action: 'shell', resource: '*', effect: 'deny' }] }), update },
    config: { get: async () => [{ type: 'document', info: { default_agent: 'build' } }] },
    agent: { get: async () => ({ data: { permissions: rules } }) } };
  const warnings = await applyOpenCodeV2LaunchPermissions(client, 'ses_a', '/worktree', false);
  expect(warnings.join('\n')).toContain('denies execute'); expect(warnings.join('\n')).toContain('dispatcher');
  expect(update.mock.calls[0][0].permissions[0]).toEqual({ action: 'shell', resource: '*', effect: 'deny' });
  expect(update.mock.calls[0][0].permissions.some(rule => rule.action === 'execute')).toBe(false);
  update.mockClear();
  expect((await applyOpenCodeV2LaunchPermissions(client, 'ses_a', '/worktree', true)).join('\n')).toContain('append:');
  expect(update).not.toHaveBeenCalled();
});

it('grants only declared V2 launch directories and preserves specific operator denials', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-oc-access-')));
  try {
    const scratch = join(root, 'scratch'); const blocked = join(root, 'blocked');
    const resource = pathname => pathname.replace(/\\/g, '/') + '/*';
    const update = vi.fn(async () => {});
    const rules = [{ action: '*', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
      { action: 'external_directory', resource: resource(blocked), effect: 'deny' }];
    const client: any = { session: { get: async () => ({ agent: 'build', permissions: [] }), update },
      config: { get: async () => [] }, agent: { get: async () => ({ data: { permissions: rules } }) } };
    await applyOpenCodeV2LaunchPermissions(client, 'ses_a', root, true, [scratch, blocked]);
    expect(update.mock.calls[0][0].permissions).toEqual([{ action: 'external_directory', resource: resource(scratch), effect: 'allow' }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
