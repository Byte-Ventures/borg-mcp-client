import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultApprovalIo, readCodexEffectiveConfig, resolveLaunchBorgApprovals, setupApprovalWarnings } from '../src/cli-tool-approval.js';
import { buildCodexLaunchArgs } from '../src/codex-launch.js';

function config(borg: Record<string, unknown>) {
  return { mcp_servers: { borg, other: { tools: { 'borg:read-log': { approval_mode: 'prompt' } } } } };
}

function fixture(original: unknown, completed: unknown) {
  const readCodexConfig = vi.fn((args: string[] = [], compatibilityArgs: string[] = []) =>
    args.length || compatibilityArgs.length ? completed : original);
  return { readCodexConfig, readCodexServerConfig: vi.fn(() => completed),
    readOpenCodeConfig: () => ({}), isTTY: () => false, confirm: vi.fn(async () => 'yes') };
}

describe('Codex exact-name policy compatibility at launch', () => {
  it('launches with the existing seven-tool configuration without editing it or changing approval modes', async () => {
    const tools = Object.fromEntries(['ack', 'log', 'read-log', 'regen', 'roster', 'stream-status', 'whoami']
      .map(name => [`borg:${name}`, { approval_mode: 'approve' }]));
    const original = config({ command: 'borg-mcp', tools });
    const before = structuredClone(original);
    const completed = config({ command: 'borg-mcp', tools: {
      ...tools, 'borg:read_log': { approval_mode: 'approve' }, 'borg:stream_status': { approval_mode: 'approve' },
    } });
    const deps = fixture(original, completed);
    const result = await resolveLaunchBorgApprovals('codex', deps, { skipOverride: true });
    const policyArgs = result.codexCompatibilityArgs!;
    expect(policyArgs).toContain('mcp_servers.borg.enabled=true');
    expect(policyArgs.join(' ')).toContain('"borg:read_log"={approval_mode="approve"}');
    expect(policyArgs.join(' ')).toContain('"borg:stream_status"={approval_mode="approve"}');
    expect(policyArgs.join(' ')).not.toContain('"auto"');
    expect(original).toEqual(before);
    expect(deps.readCodexConfig).toHaveBeenCalledTimes(2);
    expect(deps.confirm).not.toHaveBeenCalled();
    const plan = buildCodexLaunchArgs({
      remote: { ready: true, args: ['--remote', 'unix:///tmp/fixture.sock'],
        server: { socketPath: '/tmp/fixture.sock' } } as any,
      cwd: '/repo', kickoff: 'fixture kickoff', approvalArgs: result.codexArgs, compatibilityArgs: result.codexCompatibilityArgs,
    });
    expect(plan.ready).toBe(true);
    if (plan.ready) expect(plan.args).toEqual(expect.arrayContaining(result.codexCompatibilityArgs!));
  });

  it.each(['borg:read_log', 'borg_read_log', 'read_log'])(
    'copies a canonical-only %s policy including all settings', async canonical => {
      const legacy = canonical.replace('read_log', 'read-log');
      const settings = { approval_mode: 'auto', output_token_limit: 123 };
      const original = config({ tools: { [canonical]: settings }, env: { EXAMPLE: 'borg_read-log' } });
      const completed = config({ tools: { [canonical]: settings, [legacy]: settings }, env: { EXAMPLE: 'borg_read-log' } });
      const result = await resolveLaunchBorgApprovals('codex', fixture(original, completed));
      expect(result.codexCompatibilityArgs!.join(' ')).toContain(`${legacy.includes(':') ? `"${legacy}"` : legacy}={approval_mode="auto",output_token_limit=123}`);
      expect(result.codexCompatibilityArgs!.join(' ')).not.toContain('EXAMPLE');
    }
  );

  it.each(['enabled_tools', 'disabled_tools'])(
    'preserves %s restrictions and unrelated entries for both spellings', async field => {
      const original = config({ [field]: ['borg_read-log', 'read_entry', 'unrelated'] });
      const completed = config({ [field]: ['borg_read-log', 'read_entry', 'unrelated', 'borg_read_log', 'read-entry'] });
      const result = await resolveLaunchBorgApprovals('codex', fixture(original, completed));
      expect(result.codexCompatibilityArgs!).toEqual(['-c', 'mcp_servers.borg.enabled=true', '-c',
        `mcp_servers.borg.${field}=["borg_read-log","read_entry","unrelated","borg_read_log","read-entry"]`]);
      expect(original.mcp_servers.borg[field]).toEqual(['borg_read-log', 'read_entry', 'unrelated']);
    }
  );

  it('carries already paired policy to the owner without a naming migration', async () => {
    const settings = { approval_mode: 'auto' };
    const original = config({ tools: { 'borg:read_log': settings, 'borg:read-log': settings }, env: { EXAMPLE: 'borg_read-log' } });
    const deps = fixture(original, original);
    const result = await resolveLaunchBorgApprovals('codex', deps);
    expect(result.codexArgs).toEqual([]);
    expect(result.codexCompatibilityArgs!.join(' ')).toContain('"borg:read-log"={approval_mode="auto"}');
    expect(deps.readCodexServerConfig).toHaveBeenCalledWith(result.codexCompatibilityArgs);
    expect(deps.readCodexConfig).toHaveBeenCalledOnce();
  });

  it.each([
    { tools: { 'borg:read-log': { approval_mode: 'approve' }, 'borg:read_log': { approval_mode: 'auto' } } },
    { tools: { 'borg:read-log': { approval_mode: 'approve', output_token_limit: 10 }, 'borg:read_log': { approval_mode: 'approve', output_token_limit: 20 } } },
    { disabled_tools: ['borg_read-*'] },
  ])('refuses conflicting settings or ambiguous patterns before applying overrides: %j', async policy => {
    const deps = fixture(config(policy), null);
    await expect(resolveLaunchBorgApprovals('codex', deps)).rejects.toThrow('migration required');
    expect(deps.readCodexConfig).toHaveBeenCalledOnce();
  });

  it('refuses launch if the native resolver does not preserve the compatibility policy', async () => {
    const original = config({ disabled_tools: ['borg_read-log'] });
    const deps = fixture(original, original);
    await expect(resolveLaunchBorgApprovals('codex', deps)).rejects.toThrow('did not preserve');
    expect(deps.readCodexConfig).toHaveBeenCalledTimes(2);
  });

  it('refuses launch when the private server differs from the inspected policy', async () => {
    const selected = config({ enabled: false, default_tools_approval_mode: 'approve', enabled_tools: ['borg_regen'] });
    const deps = fixture(selected, selected);
    deps.readCodexServerConfig.mockReturnValue(config({ enabled: true, default_tools_approval_mode: 'auto' }));
    await expect(resolveLaunchBorgApprovals('codex', deps, { skipOverride: true }))
      .rejects.toThrow('could not preserve the effective Borg policy on the private app-server');
  });

  it('sanitizes failures from private-server configuration inspection', async () => {
    const selected = config({ enabled_tools: ['borg_regen'] });
    const deps = fixture(selected, selected);
    deps.readCodexServerConfig.mockImplementation(() => { throw new Error('private config detail'); });
    const launch = resolveLaunchBorgApprovals('codex', deps);
    await expect(launch).rejects.toThrow('private app-server');
    await expect(launch).rejects.not.toThrow('private config detail');
  });

  it('recognizes legacy exact-name settings during setup diagnostics', async () => {
    const original = config({ tools: { 'borg:read-log': { approval_mode: 'approve' } } });
    const warnings = await setupApprovalWarnings(fixture(original, original), { codex: true });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Codex Borg approvals are restrictive');
    expect(warnings[0]).not.toContain('migration required');
  });

  it('keeps compatibility settings when a separate auto-approval override cannot be applied', async () => {
    const settings = { approval_mode: 'approve', output_token_limit: 123 };
    const original = config({ tools: { 'borg:read-log': settings } });
    const completed = config({ tools: { 'borg:read-log': settings, 'borg:read_log': settings } });
    const deps = fixture(original, completed);
    const result = await resolveLaunchBorgApprovals('codex', deps);
    expect(result.codexCompatibilityArgs!.join(' ')).toContain('approval_mode="approve"');
    expect(result.warning).toContain('managed policy prevents');
    const attempted = deps.readCodexConfig.mock.calls[2][0]!;
    expect(attempted.at(-1)).toContain('"borg:read_log"={approval_mode="auto",output_token_limit=123}');
  });
});

// Run explicitly with CODEX_NATIVE_TEST_BIN=/absolute/path/to/codex. Queries only
// config/read in a disposable home: no TUI, model request, MCP startup or auth.
describe.skipIf(!process.env.CODEX_NATIVE_TEST_BIN)('native Codex tool-policy upgrade', () => {
  it.each([
    { legacy: false, skipOverride: false, enabled: true, emptyTools: false },
    { legacy: true, skipOverride: true, enabled: false, emptyTools: false },
    { legacy: true, skipOverride: true, enabled: undefined, emptyTools: false },
    { legacy: false, skipOverride: true, enabled: undefined, emptyTools: true },
  ])('preserves the selected policy on the private server: %j', async ({ legacy, skipOverride, enabled, emptyTools }) => {
    const root = await mkdtemp(join(tmpdir(), 'borg-codex-owner-policy-'));
    try {
      await mkdir(join(root, '.codex'));
      const userConfig = '[mcp_servers.borg]\ncommand="node"\n' +
        'default_tools_approval_mode="auto"\nenabled_tools=["borg_regen","borg_log","borg_tool"]\ndisabled_tools=["borg_log"]\n';
      const profileConfig = '[mcp_servers.borg]\n' +
        (enabled === undefined ? '' : `enabled=${enabled}\n`) +
        `default_tools_approval_mode="approve"\nenabled_tools=${emptyTools ? '[]' : '["borg_regen"]'}\ndisabled_tools=[]\n` +
        (legacy ? '[mcp_servers.borg.tools."borg:read-log"]\napproval_mode="approve"\n'
          : emptyTools ? '[mcp_servers.borg.tools]\n' : '');
      await writeFile(join(root, '.codex/config.toml'), userConfig);
      await writeFile(join(root, '.codex/restricted.config.toml'), profileConfig);
      const env = { ...process.env, HOME: root, CODEX_HOME: join(root, '.codex') };
      const loadCodex = (args: string[], cwd: string, queryEnv: NodeJS.ProcessEnv, profile?: string) =>
        readCodexEffectiveConfig(args, cwd, queryEnv, { profile,
          spawnProcess: ((_command, nativeArgs, options) => spawn(process.env.CODEX_NATIVE_TEST_BIN!, nativeArgs!, options!)) as typeof spawn,
        });
      const deps = defaultApprovalIo(async () => 'yes', () => false, {
        cwd: root, env, codexArgs: ['--profile', 'restricted'], loadCodex,
      });
      const decision = await resolveLaunchBorgApprovals('codex', deps, { skipOverride });
      // The production owner gets these arguments without the selected profile.
      const owner = await loadCodex([...decision.codexArgs, ...(decision.codexCompatibilityArgs ?? [])], root, env) as any;
      expect(owner.mcp_servers.borg.enabled).toBe(enabled ?? true);
      expect(owner.mcp_servers.borg.default_tools_approval_mode).toBe('approve');
      expect(owner.mcp_servers.borg.enabled_tools).toEqual(emptyTools ? [] : ['borg_regen']);
      expect(owner.mcp_servers.borg.disabled_tools).toEqual([]);
      if (legacy) expect(owner.mcp_servers.borg.tools['borg:read_log'].approval_mode).toBe('approve');
      expect(await readFile(join(root, '.codex/config.toml'), 'utf8')).toBe(userConfig);
      expect(await readFile(join(root, '.codex/restricted.config.toml'), 'utf8')).toBe(profileConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts exact launch overrides, respects profiles/project precedence and leaves files unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'borg-codex-policy-test-'));
    try {
      const home = join(root, 'home');
      const project = join(root, 'project');
      await mkdir(join(home, '.codex'), { recursive: true });
      await mkdir(join(project, '.codex'), { recursive: true });
      await mkdir(join(project, '.git'));
      const userConfig = `[mcp_servers.borg]\ncommand="node"\nenabled=false\n` +
        `enabled_tools=["borg_read-log","borg_regen"]\ndisabled_tools=["borg_remove-document"]\n` +
        ['ack', 'log', 'read-log', 'regen', 'roster', 'stream-status', 'whoami'].map(name =>
          `[mcp_servers.borg.tools."borg:${name}"]\napproval_mode="approve"\noutput_token_limit=123\n`).join('') +
        '[mcp_servers.borg.tools."borg:remove-document"]\napproval_mode="prompt"\noutput_token_limit=101\n';
      const userPath = join(home, '.codex/config.toml');
      const profilePath = join(home, '.codex/team.config.toml');
      const projectPath = join(project, '.codex/config.toml');
      const profileConfig = '[mcp_servers.borg.tools."borg:read-log"]\napproval_mode="prompt"\n';
      const projectConfig = '[mcp_servers.borg.tools."borg:read-log"]\napproval_mode="writes"\n';
      await writeFile(userPath, userConfig);
      await writeFile(profilePath, profileConfig);
      await writeFile(projectPath, projectConfig);
      const env = { ...process.env, HOME: home, CODEX_HOME: join(home, '.codex') };
      const loadCodex = (args: string[], cwd: string, queryEnv: NodeJS.ProcessEnv, profile?: string) =>
        readCodexEffectiveConfig(args, cwd, queryEnv, { profile,
          spawnProcess: ((_command, nativeArgs, options) => spawn(process.env.CODEX_NATIVE_TEST_BIN!, nativeArgs!, options!)) as typeof spawn,
        });
      // Base user configuration, selected profile, and trusted project in turn.
      for (const [cwd, flags, expectedMode] of [
        [home, [], 'approve'],
        [home, ['-c', 'mcp_servers.borg.tools={"borg:read-log"={approval_mode="prompt"}}'], 'prompt'],
        [home, ['--profile', 'team'], 'prompt'],
        [project, ['--profile', 'team', '-c', `projects={${JSON.stringify(project)}={trust_level="trusted"}}`], 'writes'],
      ] as const) {
        const deps = defaultApprovalIo(async () => 'yes', () => false, {
          cwd, env, codexArgs: [...flags], loadCodex,
        });
        const decision = await resolveLaunchBorgApprovals('codex', deps, { skipOverride: true });
        expect(decision.codexCompatibilityArgs!.length).toBeGreaterThan(0);
        const effective = await deps.readCodexConfig(decision.codexArgs, decision.codexCompatibilityArgs) as any;
        const borg = effective.mcp_servers.borg;
        expect(borg.tools['borg:read_log']).toEqual({ approval_mode: expectedMode, output_token_limit: 123 });
        expect(borg.tools['borg:read-log']).toEqual(borg.tools['borg:read_log']);
        expect(borg.tools['borg:stream_status']).toEqual(borg.tools['borg:stream-status']);
        expect(borg.enabled_tools).toEqual(['borg_read-log', 'borg_regen', 'borg_read_log']);
        expect(borg.disabled_tools).toEqual(['borg_remove-document', 'borg_remove_document']);
        // Default coordination approval behavior must not discard compatibility
        // settings when it adds its own later inline-table override.
        const withApprovals = await resolveLaunchBorgApprovals('codex', deps);
        const approved = await deps.readCodexConfig(withApprovals.codexArgs, withApprovals.codexCompatibilityArgs) as any;
        const approvalMode = flags.some(flag => flag.startsWith('mcp_servers.borg.tools=')) ? 'prompt' : 'auto';
        expect(approved.mcp_servers.borg.tools['borg:read_log']).toEqual({ approval_mode: approvalMode, output_token_limit: 123 });
        expect(approved.mcp_servers.borg.disabled_tools).toEqual(borg.disabled_tools);
        expect(approved.mcp_servers.borg.enabled_tools).toEqual(borg.enabled_tools);
        expect(approved.mcp_servers.borg.tools['borg:remove_document']).toEqual({ approval_mode: 'prompt', output_token_limit: 101 });
        expect(approved.mcp_servers.borg.tools['borg:remove-document']).toEqual(approved.mcp_servers.borg.tools['borg:remove_document']);
      }
      expect(await readFile(userPath, 'utf8')).toBe(userConfig);
      expect(await readFile(profilePath, 'utf8')).toBe(profileConfig);
      expect(await readFile(projectPath, 'utf8')).toBe(projectConfig);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
