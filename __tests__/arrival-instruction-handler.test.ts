import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  appendLog: vi.fn(),
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
    sessionToken: 'session-test',
    apiUrl: 'https://127.0.0.1:7091',
    serverTrustIdentity: 'spki-sha256:test',
  })),
}));
vi.mock('../src/remote-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-client.js')>()),
  appendLog: state.appendLog,
}));
vi.mock('../src/lifecycle-log-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lifecycle-log-guard.js')>()),
  shouldSuppressLifecycleLog: vi.fn(async () => ({ suppress: false, signal: 'arrival' })),
  recordLifecycleLog: vi.fn(async () => {}),
}));

import { main } from '../src/index.js';
import { __resetRegenSessionState, getDronePlaybook } from '../src/regen-format.js';

describe('borg_log ARRIVAL instruction ordering', () => {
  afterEach(() => {
    __resetRegenSessionState();
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
          message: 'ARRIVAL: builder-test (Builder) online on test-host at /test',
        },
      },
    });

    expect(state.appendLog).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('injected append failure');
    expect(getDronePlaybook()).toContain('ARRIVAL:');
  });
});
