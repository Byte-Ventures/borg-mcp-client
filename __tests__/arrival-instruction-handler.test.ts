import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  appendLog: vi.fn(),
  getRoster: vi.fn(),
  shouldSuppressLifecycleLog: vi.fn(),
  resolveAgentSessionIdentity: vi.fn(),
  recordLifecycleLog: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) {
      state.handlers.push(handler);
    }

    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));
vi.mock('../src/startup-services.js', () => ({
  runMcpStartupServices: vi.fn(async () => {}),
}));
vi.mock('../src/readiness-probe.js', () => ({ isMcpReadinessProbe: () => false }));
vi.mock('../src/launch-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/launch-gate.js')>()),
  gateAllowsActivation: () => true,
}));
vi.mock('../src/console-prefix.js', () => ({
  consolePrefix: () => '',
  initConsolePrefix: vi.fn(async () => {}),
}));
vi.mock('../src/cubes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cubes.js')>()),
  getActiveCube: vi.fn(async () => ({
    cubeId: 'cube-test',
    name: 'test-cube',
    droneId: 'drone-test',
    droneLabel: 'builder-test',
    roleName: 'Builder',
    sessionToken: 'session-test',
    apiUrl: 'https://127.0.0.1:7091',
    serverTrustIdentity: 'spki-sha256:test',
  })),
  refreshActiveCubeMetadata: vi.fn(async () => true),
}));
vi.mock('../src/remote-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-client.js')>()),
  appendLog: state.appendLog,
  getRoster: state.getRoster,
  whoami: state.whoami,
}));
vi.mock('../src/lifecycle-log-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lifecycle-log-guard.js')>()),
  shouldSuppressLifecycleLog: state.shouldSuppressLifecycleLog,
  recordLifecycleLog: state.recordLifecycleLog,
}));
vi.mock('../src/agent-session-identity.js', () => ({ resolveAgentSessionIdentity: state.resolveAgentSessionIdentity }));

import { main } from '../src/index.js';
import { __resetRegenSessionState, getDronePlaybook } from '../src/regen-format.js';
import { _resetDisplayIdentityForTests } from '../src/display-identity.js';

describe('borg_log ARRIVAL instruction ordering', () => {
  const originalOpenCode = process.env.BORG_OPENCODE;
  const originalAgentKind = process.env.BORG_AGENT_KIND;
  beforeEach(() => {
    delete process.env.BORG_OPENCODE;
    delete process.env.BORG_AGENT_KIND;
    state.appendLog.mockReset();
    state.getRoster.mockReset();
    state.shouldSuppressLifecycleLog.mockReset();
    state.shouldSuppressLifecycleLog.mockResolvedValue({ suppress: false, signal: 'arrival' });
    state.resolveAgentSessionIdentity.mockReset();
    state.resolveAgentSessionIdentity.mockResolvedValue({ kind: 'unknown', reason: 'test-harness' });
    state.recordLifecycleLog.mockReset();
    state.recordLifecycleLog.mockResolvedValue(undefined);
    state.whoami.mockReset();
  });

  afterEach(() => {
    if (originalOpenCode === undefined) delete process.env.BORG_OPENCODE;
    else process.env.BORG_OPENCODE = originalOpenCode;
    if (originalAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
    else process.env.BORG_AGENT_KIND = originalAgentKind;
    __resetRegenSessionState();
    _resetDisplayIdentityForTests();
    vi.restoreAllMocks();
  });

  it('keeps the instruction when appendLog rejects', async () => {
    state.handlers.length = 0;
    state.appendLog.mockRejectedValueOnce(new Error('injected append failure'));
    __resetRegenSessionState();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    expect(state.handlers).toHaveLength(4);
    const callTool = state.handlers[1];
    expect(getDronePlaybook()).toContain('ARRIVAL:');

    const result = await callTool({
      params: {
        name: 'borg_log',
        arguments: {
          message: 'ARRIVAL: builder-test (Builder) online on test-host',
          to: 'broadcast',
        },
      },
    });

    expect(state.appendLog).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('injected append failure');
    expect(getDronePlaybook()).toContain('ARRIVAL:');
  });

  it('resolves identity once and uses the same observation for suppression and successful recording', async () => {
    state.handlers.length = 0;
    const identity = { kind: 'known', id: 'claude:session-a', source: 'claude-session-start', observedAt: new Date(0).toISOString() };
    state.resolveAgentSessionIdentity.mockResolvedValue(identity);
    state.appendLog.mockResolvedValue({ entry: { id: 'entry', visibility: 'broadcast', recipient_drone_ids: [] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await main();
    await state.handlers[1]({ params: { name: 'borg_log', arguments: { message: 'ARRIVAL: online', to: 'broadcast' } } });
    expect(state.resolveAgentSessionIdentity).toHaveBeenCalledOnce();
    expect(state.shouldSuppressLifecycleLog).toHaveBeenCalledWith(expect.anything(), 'ARRIVAL: online', identity);
    expect(state.recordLifecycleLog).toHaveBeenCalledWith(expect.anything(), 'ARRIVAL: online', identity);
  });

  it('stream-status exposes the observed identity source, session id, and age', async () => {
    state.handlers.length = 0;
    state.resolveAgentSessionIdentity.mockResolvedValue({ kind: 'known', id: 'claude:session-a', source: 'claude-session-start', observedAt: new Date(0).toISOString() });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await main();
    const { getActiveCube } = await import('../src/cubes.js');
    vi.mocked(getActiveCube).mockResolvedValueOnce(null);
    const result = await state.handlers[1]({ params: { name: 'borg_stream-status', arguments: {} } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.content[0].text).toContain('Agent session source: claude-session-start');
    expect(result.content[0].text).toContain('Session id: "claude:session-a"');
    expect(result.content[0].text).toMatch(/Identity age: \d+ ms/);
    expect(result.content[0].text).toContain(new Date(0).toISOString());
  });

  it('echoes the server-confirmed identity after whoami instead of persisted display fields', async () => {
    state.handlers.length = 0;
    state.whoami.mockResolvedValueOnce({
      cube_id: 'cube-test',
      cube_name: 'server-cube',
      drone_id: 'drone-test',
      drone_label: 'builder-server',
      role_id: 'role-test',
      role_name: 'Coordinator',
      runtime_metadata: null,
      runtime_metadata_reported: null,
    });
    state.appendLog.mockResolvedValueOnce({
      entry: { id: 'entry-test' },
      routing: null,
      unreachableRecipients: [],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    const callTool = state.handlers[1];
    await callTool({ params: { name: 'borg_whoami', arguments: {} } });
    const result = await callTool({
      params: {
        name: 'borg_log',
        arguments: { message: 'ARRIVAL: online', to: 'broadcast' },
      },
    });

    expect(result.content[0].text).toContain('Logged to cube "server-cube" as builder-server.');
    expect(result.content[0].text).not.toContain('builder-test');
  });

  it('qualifies later arrival echoes after an identity read fails', async () => {
    state.handlers.length = 0;
    state.whoami.mockRejectedValueOnce(new Error('identity read failed'));
    state.appendLog.mockResolvedValueOnce({
      entry: { id: 'entry-test' },
      routing: null,
      unreachableRecipients: [],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    const callTool = state.handlers[1];
    const failed = await callTool({ params: { name: 'borg_whoami', arguments: {} } });
    expect(failed).toMatchObject({ isError: true });

    const result = await callTool({
      params: {
        name: 'borg_log',
        arguments: { message: 'ARRIVAL: online', to: 'broadcast' },
      },
    });
    expect(result.content[0].text).toContain(
      'Logged to cube "test-cube (last confirmed)" as builder-test (last confirmed).',
    );
  });

  it('renders confirmed directed recipients with labels and stable fallbacks', async () => {
    const known = '11111111-1111-4111-8111-111111111111';
    const removed = '22222222-2222-4222-8222-222222222222';
    state.handlers.length = 0;
    state.appendLog.mockResolvedValueOnce({
      entry: {
        id: 'entry-test',
        visibility: 'direct',
        recipient_drone_ids: [known, removed],
      },
      routing: null,
      unreachableRecipients: [],
    });
    state.getRoster.mockResolvedValueOnce({
      drones: [{ id: known, label: 'reviewer-1' }],
      roles: [],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    const result = await state.handlers[1]({
      params: { name: 'borg_log', arguments: { message: 'RESULT', to: [known, removed] } },
    });

    expect(result.content[0].text).toContain('Recipients: reviewer-1, `id:22222222`');
  });

  it('routes a directed audience identically through the direct tool and dispatcher', async () => {
    const audience = ['shaper-b211c127'];
    state.handlers.length = 0;
    state.appendLog.mockResolvedValue({
      entry: { id: 'entry-test', visibility: 'direct', recipient_drone_ids: [] },
      routing: null,
      unreachableRecipients: [],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    const callTool = state.handlers[1];
    await callTool({
      params: { name: 'borg_log', arguments: { message: 'direct', to: audience } },
    });
    await callTool({
      params: {
        name: 'borg_tool',
        arguments: {
          name: 'borg_log',
          arguments: { message: 'dispatched', to: audience },
        },
      },
    });

    expect(state.appendLog).toHaveBeenCalledTimes(2);
    expect(state.appendLog.mock.calls[0][3].to).toEqual(audience);
    expect(state.appendLog.mock.calls[1][3].to).toEqual(audience);
  });

  it.each(([
    undefined,
    null,
    [],
    'builder-test',
    ['builder-test', 'builder-test'],
    [' builder-test'],
    ['builder-test '],
    ['builder\u0000test'],
    Array.from({ length: 101 }, (_, index) => `builder-${index}`),
    ['a'.repeat(121)],
    ['é'.repeat(61)],
  ] as unknown[]).map((value) => [value]))(
    'rejects invalid audience %# before lifecycle duplicate suppression',
    async (to) => {
      state.handlers.length = 0;
      state.shouldSuppressLifecycleLog.mockResolvedValueOnce({ suppress: true, signal: 'arrival' });
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await main();
      const result = await state.handlers[1]({
        params: { name: 'borg_log', arguments: { message: 'ARRIVAL: online', to } },
      });

      expect(result).toMatchObject({ isError: true });
      expect(result.content[0].text).toMatch(/to|selector/);
      expect(state.shouldSuppressLifecycleLog).not.toHaveBeenCalled();
      expect(state.appendLog).not.toHaveBeenCalled();
    },
  );
});
