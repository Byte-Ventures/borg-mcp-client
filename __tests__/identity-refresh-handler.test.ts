import { afterEach, describe, expect, it, vi } from 'vitest';

const OLD_ACTIVE = {
  cubeId: '11111111-1111-4111-8111-111111111111',
  name: 'old-cube',
  droneId: '22222222-2222-4222-8222-222222222222',
  droneLabel: 'security-auditor-old',
  sessionToken: 'session-test',
  apiUrl: 'https://127.0.0.1:7091',
  serverTrustIdentity: 'spki-sha256:test',
  localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
  roleName: 'Security Auditor',
  roleClass: 'worker' as const,
  isHumanSeat: false,
};

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  appendLog: vi.fn(),
  whoami: vi.fn(),
  refreshActiveCubeMetadata: vi.fn(),
  refreshConsolePrefixIdentity: vi.fn(),
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
  refreshConsolePrefixIdentity: state.refreshConsolePrefixIdentity,
}));
vi.mock('../src/cubes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/cubes.js')>();
  return {
    ...original,
    getActiveCube: vi.fn(async () => original.activeCubeWithObservedIdentity(OLD_ACTIVE)),
    refreshActiveCubeMetadata: state.refreshActiveCubeMetadata,
  };
});
vi.mock('../src/remote-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-client.js')>()),
  appendLog: state.appendLog,
  whoami: state.whoami,
}));
vi.mock('../src/lifecycle-log-guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lifecycle-log-guard.js')>()),
  shouldSuppressLifecycleLog: vi.fn(async () => ({ suppress: false })),
  recordLifecycleLog: vi.fn(async () => {}),
}));

import { main } from '../src/index.js';

describe('server-authoritative session identity', () => {
  afterEach(async () => {
    const { __resetObservedIdentityForTests } = await import('../src/cubes.js');
    __resetObservedIdentityForTests();
    state.handlers.length = 0;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('uses a fresh whoami identity for later echoes even when persistence cannot commit', async () => {
    state.refreshActiveCubeMetadata.mockResolvedValue(false);
    state.whoami.mockResolvedValue({
      cube_id: OLD_ACTIVE.cubeId,
      cube_name: 'renamed-cube',
      drone_id: OLD_ACTIVE.droneId,
      drone_label: 'coordinator-live',
      role_id: '33333333-3333-4333-8333-333333333333',
      role_name: 'Coordinator',
      role_class: 'queen',
      is_human_seat: true,
      runtime_metadata: {},
      runtime_metadata_reported: false,
    });
    state.appendLog.mockResolvedValue({ entry: { id: 'entry-1' } });

    await main();
    const listTools = state.handlers[0];
    const callTool = state.handlers[1];
    await callTool({ params: { name: 'borg_whoami', arguments: {} } });
    const listed = await listTools({ params: {} });
    const logged = await callTool({
      params: { name: 'borg_log', arguments: { message: 'PROGRESS - identity refreshed' } },
    });

    expect(logged.content[0].text).toContain('Logged to cube "renamed-cube" as coordinator-live');
    expect(logged.content[0].text).not.toContain('security-auditor-old');
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toContain('borg_evict-drone');
    expect(state.refreshConsolePrefixIdentity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'renamed-cube',
      droneLabel: 'coordinator-live',
    }));
    expect(state.refreshActiveCubeMetadata).toHaveBeenCalledWith(expect.objectContaining({
      name: 'renamed-cube',
      droneLabel: 'coordinator-live',
      roleName: 'Coordinator',
      roleClass: 'queen',
      isHumanSeat: true,
      sessionToken: OLD_ACTIVE.sessionToken,
      localSessionCredentialRef: OLD_ACTIVE.localSessionCredentialRef,
    }));
  });

  it('does not replace the last server identity when a later identity request fails', async () => {
    state.refreshActiveCubeMetadata.mockRejectedValue(new Error('injected metadata write failure'));
    state.whoami
      .mockResolvedValueOnce({
        cube_id: OLD_ACTIVE.cubeId,
        cube_name: 'renamed-cube',
        drone_id: OLD_ACTIVE.droneId,
        drone_label: 'coordinator-live',
        role_id: '33333333-3333-4333-8333-333333333333',
        role_name: 'Coordinator',
        role_class: 'queen',
        is_human_seat: true,
        runtime_metadata: {},
        runtime_metadata_reported: false,
      })
      .mockRejectedValueOnce(new Error('injected identity read failure'));
    state.appendLog.mockResolvedValue({ entry: { id: 'entry-2' } });

    await main();
    const callTool = state.handlers[1];
    await callTool({ params: { name: 'borg_whoami', arguments: {} } });
    const failed = await callTool({ params: { name: 'borg_whoami', arguments: {} } });
    const logged = await callTool({
      params: { name: 'borg_log', arguments: { message: 'PROGRESS - prior truth retained' } },
    });

    expect(failed).toMatchObject({ isError: true });
    expect(logged.content[0].text).toContain('Logged to cube "renamed-cube" as coordinator-live');
  });
});
