import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// client#499: the borg_create-cube handler requires an EXPLICIT repository (no
// cwd fallback) and reports an existing repository cube honestly on 'resolved'.
const state = vi.hoisted(() => ({ handlers: [] as Array<(r: any) => Promise<any>>, createCube: vi.fn() }));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class { setRequestHandler(_s: unknown, h: (r: any) => Promise<any>) { state.handlers.push(h); } async connect() {} },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/startup-services.js', () => ({ runMcpStartupServices: vi.fn(async () => {}) }));
vi.mock('../src/readiness-probe.js', () => ({ isMcpReadinessProbe: () => false }));
vi.mock('../src/launch-gate.js', async (o) => ({ ...(await o<typeof import('../src/launch-gate.js')>()), gateAllowsActivation: () => true }));
vi.mock('../src/console-prefix.js', () => ({ consolePrefix: () => '', initConsolePrefix: vi.fn(async () => {}) }));
vi.mock('../src/cubes.js', async (o) => ({
  ...(await o<typeof import('../src/cubes.js')>()),
  getActiveCube: vi.fn(async () => ({ cubeId: 'c', name: 'c', droneId: 'd', droneLabel: 'l', roleName: 'Builder', sessionToken: 's', apiUrl: 'https://127.0.0.1:7091', serverTrustIdentity: 'spki-sha256:t' })),
  refreshActiveCubeMetadata: vi.fn(async () => true),
}));
// Keep normalizeExplicitRepository real; only stub the network createCube.
vi.mock('../src/remote-client.js', async (o) => ({ ...(await o<typeof import('../src/remote-client.js')>()), createCube: state.createCube }));

import { main } from '../src/index.js';

const CUBE = { id: 'cube-1', name: 'made', cube_directive: 'existing' };

describe('borg_create-cube handler — explicit repository (client#499)', () => {
  const originalOpenCode = process.env.BORG_OPENCODE;
  const originalAgentKind = process.env.BORG_AGENT_KIND;
  beforeEach(() => {
    delete process.env.BORG_OPENCODE;
    delete process.env.BORG_AGENT_KIND;
    state.handlers.length = 0;
    state.createCube.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    if (originalOpenCode === undefined) delete process.env.BORG_OPENCODE;
    else process.env.BORG_OPENCODE = originalOpenCode;
    if (originalAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
    else process.env.BORG_AGENT_KIND = originalAgentKind;
    vi.restoreAllMocks();
  });

  async function callTool(args: any) {
    await main();
    return state.handlers[1]({ params: { name: 'borg_create-cube', arguments: args } });
  }

  it('refuses when repository is absent — no cwd fallback', async () => {
    const result = await callTool({ name: 'made', cube_directive: 'd' });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toMatch(/repository is required/);
    expect(state.createCube).not.toHaveBeenCalled();
  });

  it('threads the normalized repository and reports a newly created cube', async () => {
    state.createCube.mockResolvedValueOnce({ result: 'created', cube: CUBE });
    const result = await callTool({ name: 'made', cube_directive: 'hello', repository: 'https://github.com/owner/made' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Created cube \*\*made\*\*/);
    expect(result.structuredContent).toMatchObject({ result: 'created' });
    expect(state.createCube).toHaveBeenCalledWith('made', 'hello', expect.objectContaining({
      repository: { kind: 'origin', value: 'https://github.com/owner/made' },
      workingRepoName: 'made',
    }));
  });

  it('reports an existing repository cube honestly on resolved (directive unchanged, no create claim)', async () => {
    state.createCube.mockResolvedValueOnce({ result: 'resolved', cube: CUBE });
    const result = await callTool({ name: 'made', cube_directive: 'NEW must not land', repository: 'https://github.com/owner/made' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/already exists for this repository/);
    expect(result.content[0].text).not.toMatch(/^Created cube/);
    expect(result.structuredContent).toMatchObject({ result: 'resolved' });
  });
});
