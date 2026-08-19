import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// gh#501: the borg_tool dispatcher unwraps to the same CallTool switch as a
// direct borg_ack, and only requires its inner arguments to be an object. This
// drives the real handler to prove an invalid inner kind (including an explicit
// null) is refused with isError and ZERO acknowledgement mutations, while the
// documented default (omitted kind) and a valid kind still mutate.
const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  ackLogEntry: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) {
      state.handlers.push(handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/startup-services.js', () => ({ runMcpStartupServices: vi.fn(async () => {}) }));
vi.mock('../src/readiness-probe.js', () => ({ isMcpReadinessProbe: () => false }));
vi.mock('../src/launch-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/launch-gate.js')>()),
  gateAllowsActivation: () => true,
}));
vi.mock('../src/console-prefix.js', () => ({ consolePrefix: () => '', initConsolePrefix: vi.fn(async () => {}) }));
vi.mock('../src/cubes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/cubes.js')>()),
  getActiveCube: vi.fn(async () => ({
    cubeId: 'cube-test', name: 'test-cube', droneId: 'drone-test', droneLabel: 'builder-test',
    roleName: 'Builder', sessionToken: 'session-test', apiUrl: 'https://127.0.0.1:7091',
    serverTrustIdentity: 'spki-sha256:test',
  })),
  refreshActiveCubeMetadata: vi.fn(async () => true),
}));
vi.mock('../src/remote-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-client.js')>()),
  ackLogEntry: state.ackLogEntry,
}));

import { main } from '../src/index.js';

const ENTRY = '33333333-3333-4333-8333-333333333333';

describe('borg_tool → borg_ack invalid kind refuses without mutating', () => {
  beforeEach(() => {
    state.handlers.length = 0;
    state.ackLogEntry.mockReset();
    state.ackLogEntry.mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  async function callTool(params: any) {
    await main();
    return state.handlers[1]({ params });
  }

  it('refuses an invalid inner kind ("bogus") with zero adapter calls', async () => {
    const result = await callTool({
      name: 'borg_tool',
      arguments: { name: 'borg_ack', arguments: { entry_id: ENTRY, kind: 'bogus' } },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/kind/);
    expect(state.ackLogEntry).not.toHaveBeenCalled();
  });

  it('refuses an explicit null inner kind with zero adapter calls', async () => {
    const result = await callTool({
      name: 'borg_tool',
      arguments: { name: 'borg_ack', arguments: { entry_id: ENTRY, kind: null } },
    });
    expect(result).toMatchObject({ isError: true });
    expect(state.ackLogEntry).not.toHaveBeenCalled();
  });

  it('positive control: omitted kind acknowledges with "ack"', async () => {
    const result = await callTool({
      name: 'borg_tool',
      arguments: { name: 'borg_ack', arguments: { entry_id: ENTRY } },
    });
    expect(result.isError).toBeFalsy();
    expect(state.ackLogEntry).toHaveBeenCalledOnce();
    expect(state.ackLogEntry).toHaveBeenCalledWith(
      'session-test', 'https://127.0.0.1:7091', ENTRY, 'ack', 'spki-sha256:test',
    );
  });

  it('positive control: an explicit valid kind ("claim") is honored', async () => {
    await callTool({
      name: 'borg_tool',
      arguments: { name: 'borg_ack', arguments: { entry_id: ENTRY, kind: 'claim' } },
    });
    expect(state.ackLogEntry).toHaveBeenCalledOnce();
    expect(state.ackLogEntry).toHaveBeenCalledWith(
      'session-test', 'https://127.0.0.1:7091', ENTRY, 'claim', 'spki-sha256:test',
    );
  });
});
