import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  appendLog: vi.fn(),
  getRoster: vi.fn(),
  shouldSuppressLifecycleLog: vi.fn(),
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
  recordLifecycleLog: vi.fn(async () => {}),
}));

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
      params: { name: 'borg_log', arguments: { message: 'REVIEW-READY', to: [known, removed] } },
    });

    expect(result.content[0].text).toContain('Recipients: reviewer-1, `id:22222222`');
  });

  it('rejects a missing audience before lifecycle duplicate suppression', async () => {
    state.handlers.length = 0;
    state.shouldSuppressLifecycleLog.mockResolvedValueOnce({ suppress: true, signal: 'arrival' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main();
    const result = await state.handlers[1]({
      params: { name: 'borg_log', arguments: { message: 'ARRIVAL: online' } },
    });

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('to is required');
    expect(state.shouldSuppressLifecycleLog).not.toHaveBeenCalled();
    expect(state.appendLog).not.toHaveBeenCalled();
  });
});
