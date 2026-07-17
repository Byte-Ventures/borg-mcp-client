import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  CODEX_BORG_COORDINATION_TOOLS,
  OPENCODE_BORG_COORDINATION_TOOLS,
  buildOpenCodeLaunchArgs,
  codexBorgApprovalArgs,
  codexEffectiveConfigArgs,
  codexSelectedProfile,
  composeCodexProfileConfig,
  defaultApprovalIo,
  inspectCodexBorgApprovals,
  inspectOpenCodeBorgApprovals,
  mergeOpenCodePermission,
  readCodexEffectiveConfig,
  resolveLaunchBorgApprovals,
  setupApprovalWarnings,
} from '../src/cli-tool-approval.js';
import { resolveCodexLaunchCwd } from '../src/codex-remote.js';

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

function fakeCodexConfigChild() {
  const child = new EventEmitter() as any;
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn((_payload: string, callback?: (error?: Error) => void) => {
    callback?.();
    return true;
  });
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function codexQueryDecision(
  child: ReturnType<typeof fakeCodexConfigChild>,
  runtime: { timeoutMs?: number; maxResponseBytes?: number } = {}
) {
  return resolveLaunchBorgApprovals('codex', io({
    readCodexConfig: () => readCodexEffectiveConfig([], '/repo', {}, {
      spawnProcess: (() => child) as any,
      timeoutMs: runtime.timeoutMs ?? 100,
      ...(runtime.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: runtime.maxResponseBytes }),
    }),
  }));
}

function expectStaticQueryFailure(result: Awaited<ReturnType<typeof codexQueryDecision>>) {
  expect(result.codexArgs).toEqual([]);
  expect(result.warning).toBe(
    'Could not inspect codex Borg tool approvals: Codex effective-config query failed. No approval override was applied.'
  );
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

  it('separates runtime-only profiles from app-server config flags', () => {
    expect(codexEffectiveConfigArgs([
      '--model', 'gpt-5', '-p', 'team', '--config', 'mcp_servers.borg.default_tools_approval_mode="approve"',
      '--remote', 'unix:///tmp/codex.sock', '--strict-config', '--enable=hooks',
    ])).toEqual([
      '--config', 'mcp_servers.borg.default_tools_approval_mode="approve"',
      '--strict-config', '--enable=hooks',
    ]);
    expect(codexSelectedProfile([
      '--profile', 'first', '-psecond', '--profile=third', '-p=fourth', '--', '-pfifth',
    ])).toBe('fourth');
  });

  it('inserts the selected profile between base-user and project/runtime layers', () => {
    const snapshot = {
      layers: [
        { name: { type: 'project' }, config: codexEffective('auto'), disabledReason: null },
        { name: { type: 'user', profile: null }, config: codexEffective('auto'), disabledReason: null },
        { name: { type: 'system' }, config: codexEffective('approve'), disabledReason: null },
      ],
    };
    expect(inspectCodexBorgApprovals(
      composeCodexProfileConfig(snapshot, codexEffective('approve'))
    ).restrictiveTools).toEqual([]);

    snapshot.layers[0].config = {};
    expect(inspectCodexBorgApprovals(
      composeCodexProfileConfig(snapshot, codexEffective('approve'))
    ).restrictiveTools).toHaveLength(CODEX_BORG_COORDINATION_TOOLS.length);
  });

  it('uses the native resolver result: project deny wins over clean global; project allow wins over global deny', () => {
    expect(inspectCodexBorgApprovals(codexEffective('approve')).restrictiveTools)
      .toHaveLength(CODEX_BORG_COORDINATION_TOOLS.length);
    expect(inspectCodexBorgApprovals(codexEffective('auto')).restrictiveTools).toEqual([]);
  });
});

describe('Codex native effective-config query failures', () => {
  it('fails closed when process creation throws synchronously', async () => {
    const result = await resolveLaunchBorgApprovals('codex', io({
      readCodexConfig: () => readCodexEffectiveConfig([], '/repo', {}, {
        spawnProcess: (() => { throw new Error('spawn detail must not escape'); }) as any,
      }),
    }));
    expectStaticQueryFailure(result);
  });

  it('fails closed on a process spawn error', async () => {
    const child = fakeCodexConfigChild();
    const decision = codexQueryDecision(child);
    child.emit('error', new Error('host detail must not escape'));
    expectStaticQueryFailure(await decision);
  });

  it('fails closed when the process exits before initialize', async () => {
    const child = fakeCodexConfigChild();
    const decision = codexQueryDecision(child);
    child.emit('exit', 1, null);
    const result = await decision;
    expect(result.codexArgs).toEqual([]);
    expect(result.warning).toBe(
      'Could not inspect codex Borg tool approvals: Codex effective-config query exited before responding. No approval override was applied.'
    );
  });

  it('handles stdin EPIPE after initialize without an unhandled stream error', async () => {
    const child = fakeCodexConfigChild();
    let writes = 0;
    child.stdin.write.mockImplementation((_payload: string, callback?: (error?: Error) => void) => {
      writes += 1;
      if (writes > 1) {
        const error = Object.assign(new Error('broken pipe detail'), { code: 'EPIPE' });
        queueMicrotask(() => {
          callback?.(error);
          child.stdin.emit('error', error);
        });
      } else {
        callback?.();
      }
      return true;
    });
    const decision = codexQueryDecision(child);
    child.stdout.emit('data', Buffer.from('{"id":1,"result":{}}\n'));
    expectStaticQueryFailure(await decision);
    expect(writes).toBeGreaterThan(1);
  });

  it('ignores late initialize data after timeout and never writes to the killed child', async () => {
    const child = fakeCodexConfigChild();
    const decision = codexQueryDecision(child, { timeoutMs: 1 });
    const result = await decision;
    expect(result.codexArgs).toEqual([]);
    expect(result.warning).toContain('query timed out');
    const writesAtTimeout = child.stdin.write.mock.calls.length;
    child.stdout.emit('data', Buffer.from('{"id":1,"result":{}}\n'));
    await Promise.resolve();
    expect(child.stdin.write).toHaveBeenCalledTimes(writesAtTimeout);
  });

  it('fails closed when cumulative response bytes exceed the bound', async () => {
    const child = fakeCodexConfigChild();
    const decision = codexQueryDecision(child, { maxResponseBytes: 16 });
    child.stdout.emit('data', Buffer.alloc(17, 0x20));
    const result = await decision;
    expect(result.codexArgs).toEqual([]);
    expect(result.warning).toContain('response exceeded 4 MiB');
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
      [], '/repo/subdir', expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) }), 'team'
    );
    expect(loadOpenCode).toHaveBeenCalledWith(
      '/repo/subdir', expect.objectContaining({ OPENCODE_CONFIG_CONTENT: expect.any(String) })
    );
  });

  it('detects a restrictive selected profile and verifies the launch-only override in the same profile', async () => {
    const loadCodex = vi.fn(async (args: string[], _cwd: string, _env: NodeJS.ProcessEnv, profile?: string) => {
      expect(profile).toBe('team');
      return args.some((arg) => arg.includes('approval_mode="auto"'))
        ? codexEffective('auto')
        : codexEffective('approve');
    });
    const approvalIo = defaultApprovalIo(async () => 'yes', () => true, {
      cwd: '/repo',
      env: {},
      codexArgs: ['-pteam'],
      loadCodex,
    });
    const result = await resolveLaunchBorgApprovals('codex', approvalIo);
    expect(result.codexArgs).toHaveLength(2);
    expect(loadCodex).toHaveBeenCalledTimes(2);
    expect(loadCodex.mock.calls.every((call) => call[3] === 'team')).toBe(true);
  });

  it('inspects the explicit restrictive Codex project instead of a clean wrapper cwd', async () => {
    const wrapperCwd = '/repo/clean-wrapper';
    const targetCwd = '/repo/restrictive-project';
    const loadCodex = vi.fn(async (args: string[], cwd: string) =>
      args.length > 0 || cwd === wrapperCwd ? codexEffective('auto') : codexEffective('approve')
    );
    const approvalIo = defaultApprovalIo(async () => 'yes', () => true, {
      cwd: resolveCodexLaunchCwd([`-C${targetCwd}`], wrapperCwd),
      env: {},
      codexArgs: [`-C${targetCwd}`],
      loadCodex,
    });
    const result = await resolveLaunchBorgApprovals('codex', approvalIo);
    expect(result.codexArgs).toHaveLength(2);
    expect(loadCodex).toHaveBeenNthCalledWith(1, [], targetCwd, {});
  });

  it('does not report a restrictive wrapper when explicit -C selects a clean Codex project', async () => {
    const wrapperCwd = '/repo/restrictive-wrapper';
    const targetCwd = '/repo/clean-project';
    const loadCodex = vi.fn(async (_args: string[], cwd: string) =>
      cwd === wrapperCwd ? codexEffective('approve') : codexEffective('auto')
    );
    const confirm = vi.fn(async () => 'yes');
    const approvalIo = defaultApprovalIo(confirm, () => true, {
      cwd: resolveCodexLaunchCwd([`-C=${targetCwd}`], wrapperCwd),
      env: {},
      codexArgs: [`-C=${targetCwd}`],
      loadCodex,
    });
    expect(await resolveLaunchBorgApprovals('codex', approvalIo)).toEqual({ codexArgs: [] });
    expect(loadCodex).toHaveBeenCalledWith([], targetCwd, {});
    expect(confirm).not.toHaveBeenCalled();
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
