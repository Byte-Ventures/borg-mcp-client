import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_BORG_COORDINATION_TOOLS,
  OPENCODE_BORG_COORDINATION_TOOLS,
  buildOpenCodeLaunchArgs,
  codexBorgApprovalArgs,
  codexEffectiveConfigArgs,
  defaultApprovalIo,
  inspectCodexBorgApprovals,
  inspectOpenCodeBorgApprovals,
  mergeOpenCodePermission,
  resolveLaunchBorgApprovals,
  setupApprovalWarnings,
} from '../src/cli-tool-approval.js';

function codexEffective(mode: 'auto' | 'approve') {
  return {
    mcp_servers: {
      borg: { default_tools_approval_mode: mode, tools: {} },
    },
  };
}

function io(overrides: Partial<Parameters<typeof resolveLaunchBorgApprovals>[1]> = {}) {
  return {
    readCodexConfig: () => '',
    readOpenCodeConfig: () => ({}),
    isTTY: () => true,
    confirm: vi.fn(async () => 'yes'),
    ...overrides,
  };
}

describe('Codex Borg coordination approvals', () => {
  it('detects the incident default and exact per-tool approve modes', () => {
    const result = inspectCodexBorgApprovals(`
[mcp_servers.borg]
default_tools_approval_mode = "approve"
[mcp_servers.borg.tools."borg:regen"]
approval_mode = "auto"
[mcp_servers.other]
default_tools_approval_mode = "approve"
`);
    expect(result.restrictiveTools).not.toContain('borg:regen');
    expect(result.restrictiveTools).toHaveLength(CODEX_BORG_COORDINATION_TOOLS.length - 1);
    expect(result.repairSnippet).not.toContain('borg:create-cube');
  });

  it('leaves missing or already-auto coordination policy alone', () => {
    expect(inspectCodexBorgApprovals('').restrictiveTools).toEqual([]);
    const config = CODEX_BORG_COORDINATION_TOOLS.map(
      (tool) => `[mcp_servers.borg.tools."${tool}"]\napproval_mode = "auto"`
    ).join('\n');
    expect(inspectCodexBorgApprovals(config).restrictiveTools).toEqual([]);
  });

  it('builds exact per-tool launch overrides without broadening Borg admin tools', () => {
    const args = codexBorgApprovalArgs();
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(args.join('\n')).toContain('borg:read-log');
    expect(args.join('\n')).toContain('borg:cube');
    expect(args.join('\n')).toContain('borg:role');
    expect(args.join('\n')).toContain('borg:playbook');
    expect(args.join('\n')).not.toContain('borg:create-cube');
    expect(args[1]).not.toContain('tools."borg:');
  });

  it('replays only selected profile/config flags into native effective-config resolution', () => {
    expect(codexEffectiveConfigArgs([
      '--model', 'gpt-5', '-p', 'team', '--config', 'mcp_servers.borg.default_tools_approval_mode="approve"',
      '--remote', 'unix:///tmp/codex.sock', '--strict-config', '--enable=hooks',
    ])).toEqual([
      '-p', 'team', '--config', 'mcp_servers.borg.default_tools_approval_mode="approve"',
      '--strict-config', '--enable=hooks',
    ]);
  });

  it('uses the native resolver result: project deny wins over clean global; project allow wins over global deny', () => {
    expect(inspectCodexBorgApprovals(codexEffective('approve')).restrictiveTools)
      .toHaveLength(CODEX_BORG_COORDINATION_TOOLS.length);
    expect(inspectCodexBorgApprovals(codexEffective('auto')).restrictiveTools).toEqual([]);
  });
});

describe('OpenCode Borg coordination approvals', () => {
  it('resolves wildcard and later exact rules for the exact OpenCode tool ids', () => {
    const result = inspectOpenCodeBorgApprovals({
      permission: {
        'borg_borg_*': 'ask',
        borg_borg_regen: 'allow',
        bash: 'deny',
      },
    });
    expect(result.restrictiveTools).not.toContain('borg_borg_regen');
    expect(result.restrictiveTools).toHaveLength(OPENCODE_BORG_COORDINATION_TOOLS.length - 1);
    expect(result.repairSnippet).toContain('"bash": "deny"');
  });

  it('treats absent/default allow policy as nonrestrictive', () => {
    expect(inspectOpenCodeBorgApprovals({}).restrictiveTools).toEqual([]);
    expect(inspectOpenCodeBorgApprovals({ permission: 'allow' }).restrictiveTools).toEqual([]);
  });

  it('preserves unrelated rules when adding exact launch-only allows', () => {
    expect(mergeOpenCodePermission({ '*': 'ask', bash: 'deny' })).toMatchObject({
      '*': 'ask',
      bash: 'deny',
      borg_borg_regen: 'allow',
    });
    expect(mergeOpenCodePermission('ask')).toMatchObject({
      '*': 'ask',
      borg_borg_regen: 'allow',
    });
    const reordered = mergeOpenCodePermission({
      borg_borg_regen: 'deny',
      'borg_borg_*': 'ask',
      bash: 'deny',
    });
    expect(Object.keys(reordered).at(-OPENCODE_BORG_COORDINATION_TOOLS.length)).toBe('borg_borg_regen');
    expect(Object.keys(reordered).indexOf('borg_borg_*')).toBeLessThan(
      Object.keys(reordered).indexOf('borg_borg_regen')
    );
  });

  it('builds OpenCode argv without the broad auto-approval switch', () => {
    const args = buildOpenCodeLaunchArgs('/repo', 14096, 'wake', ['--model', 'x']);
    expect(args).toEqual(['/repo', '--port', '14096', '--prompt', 'wake', '--model', 'x']);
    expect(args).not.toContain('--auto');
  });
});

describe('launch consent', () => {
  it('keeps Claude unchanged', async () => {
    const deps = io({ readCodexConfig: vi.fn(() => { throw new Error('unused'); }) });
    expect(await resolveLaunchBorgApprovals('claude', deps)).toEqual({ codexArgs: [] });
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('applies a launch-only Codex fix only after explicit TTY consent', async () => {
    const deps = io({
      readCodexConfig: (approvalArgs = []) =>
        approvalArgs.length > 0 ? codexEffective('auto') : codexEffective('approve'),
    });
    const result = await resolveLaunchBorgApprovals('codex', deps);
    expect(result.codexArgs).toHaveLength(2);
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining(
      'approving the dispatcher also approves any Borg operation invoked through it'
    ));
  });

  it('does not prompt or override in a non-TTY and emits exact repair copy', async () => {
    const deps = io({
      isTTY: () => false,
      readCodexConfig: () => '[mcp_servers.borg]\ndefault_tools_approval_mode = "approve"',
    });
    const result = await resolveLaunchBorgApprovals('codex', deps);
    expect(result.codexArgs).toEqual([]);
    expect(result.warning).toContain('[mcp_servers.borg.tools."borg:regen"]');
    expect(result.warning).toContain('approves any Borg operation invoked through it');
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('fails closed when managed Codex policy rejects the hypothetical override', async () => {
    const deps = io({ readCodexConfig: () => codexEffective('approve') });
    const result = await resolveLaunchBorgApprovals('codex', deps);
    expect(result.codexArgs).toEqual([]);
    expect(result.warning).toContain('managed policy prevents');
  });

  it('decline leaves policy unchanged and never broadens other OpenCode permissions', async () => {
    const deps = io({
      readOpenCodeConfig: () => ({ permission: { '*': 'ask', bash: 'deny' } }),
      confirm: vi.fn(async () => 'no'),
    });
    const result = await resolveLaunchBorgApprovals('opencode', deps);
    expect(result.openCodePermission).toBeUndefined();
    expect(result.warning).toContain('"borg_borg_regen": "allow"');
    expect(result.warning).toContain('"bash": "deny"');
  });

  it('consent produces only exact OpenCode Borg coordination allows', async () => {
    const deps = io({
      readOpenCodeConfig: (permissionOverride) => permissionOverride
        ? ({ permission: JSON.parse(permissionOverride) })
        : ({ permission: { 'borg_borg_*': 'ask', bash: 'deny' } }),
    });
    const result = await resolveLaunchBorgApprovals('opencode', deps);
    const parsed = JSON.parse(result.openCodePermission!);
    expect(parsed.bash).toBe('deny');
    expect(Object.entries(parsed)
      .filter(([key, action]) => key.startsWith('borg_borg_') && action === 'allow')
      .map(([key]) => key)).toEqual(OPENCODE_BORG_COORDINATION_TOOLS);
  });

  it('fails closed when inline/managed OpenCode policy remains restrictive', async () => {
    const deps = io({
      readOpenCodeConfig: () => ({ permission: { 'borg_borg_*': 'deny', edit: 'ask' } }),
    });
    const result = await resolveLaunchBorgApprovals('opencode', deps);
    expect(result.openCodePermission).toBeUndefined();
    expect(result.warning).toContain('managed policy prevents');
  });

  it('passes actual cwd/profile/env to harness-native resolvers, including JSONC/inline layers', async () => {
    const loadCodex = vi.fn(async () => codexEffective('auto'));
    const loadOpenCode = vi.fn(() => ({ permission: { bash: 'deny' }, jsoncResolved: true }));
    const approvalIo = defaultApprovalIo(async () => '', () => false, {
      cwd: '/repo/subdir',
      env: { OPENCODE_CONFIG_CONTENT: '{ /* jsonc */ "permission": {"bash":"deny"} }' },
      codexArgs: ['--profile', 'team', '--model', 'gpt-5'],
      loadCodex,
      loadOpenCode,
    });
    await approvalIo.readCodexConfig();
    await approvalIo.readOpenCodeConfig();
    expect(loadCodex).toHaveBeenCalledWith(
      ['--profile', 'team'], '/repo/subdir', expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) })
    );
    expect(loadOpenCode).toHaveBeenCalledWith(
      '/repo/subdir', expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) })
    );
  });
});

describe('setup diagnostics', () => {
  it('reports exact repair snippets without prompting or mutating config', async () => {
    const warnings = await setupApprovalWarnings({
      readCodexConfig: () => '[mcp_servers.borg]\ndefault_tools_approval_mode = "approve"',
      readOpenCodeConfig: () => ({ permission: { 'borg_borg_*': 'ask', bash: 'deny' } }),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('borg:regen');
    expect(warnings[0]).toContain('approves any Borg operation invoked through it');
    expect(warnings[1]).toContain('borg_borg_regen');
    expect(warnings[1]).toContain('"bash": "deny"');
  });

  it('queries only installed harnesses', async () => {
    const readCodexConfig = vi.fn(() => codexEffective('approve'));
    const readOpenCodeConfig = vi.fn(() => ({ permission: 'ask' }));
    await setupApprovalWarnings(
      { readCodexConfig, readOpenCodeConfig },
      { codex: true, opencode: false }
    );
    expect(readCodexConfig).toHaveBeenCalledOnce();
    expect(readOpenCodeConfig).not.toHaveBeenCalled();
  });
});
