import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = '1234567890abcdef1234567890abcdef12345678';
const state = vi.hoisted(() => ({
  active: {} as Record<string, unknown>,
  appendLog: vi.fn(),
  findProjectRoot: vi.fn(() => '/fallback-repo'),
  handlers: [] as Array<(request: any) => Promise<any>>,
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: state.spawnSync,
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
  findProjectRoot: state.findProjectRoot,
  getActiveCube: vi.fn(async () => state.active),
  refreshActiveCubeMetadata: vi.fn(async () => true),
}));
vi.mock('../src/remote-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/remote-client.js')>()),
  appendLog: state.appendLog,
}));

import { main } from '../src/index.js';

describe('borg_log provenance handler', () => {
  const originalAgentKind = process.env.BORG_AGENT_KIND;
  const originalOpenCode = process.env.BORG_OPENCODE;

  beforeEach(() => {
    delete process.env.BORG_AGENT_KIND;
    delete process.env.BORG_OPENCODE;
    state.handlers.length = 0;
    state.active = {
      cubeId: 'cube-test',
      name: 'test-cube',
      droneId: 'drone-test',
      droneLabel: 'builder-test',
      roleName: 'Builder',
      sessionToken: 'session-test',
      apiUrl: 'https://127.0.0.1:7091',
      serverTrustIdentity: 'spki-sha256:test',
      worktree: '/repo',
    };
    state.appendLog.mockReset();
    state.appendLog.mockResolvedValue({
      entry: { id: 'entry-test', visibility: 'broadcast', recipient_drone_ids: [], documents: [] },
      unreachableRecipients: [],
    });
    state.findProjectRoot.mockClear();
    state.spawnSync.mockReset();
    state.spawnSync.mockReturnValue({ status: 0, stdout: `${SHA}\n`, stderr: '' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
    else process.env.BORG_AGENT_KIND = originalAgentKind;
    if (originalOpenCode === undefined) delete process.env.BORG_OPENCODE;
    else process.env.BORG_OPENCODE = originalOpenCode;
    vi.restoreAllMocks();
  });

  async function call(params: any) {
    await main();
    return state.handlers[1]({ params });
  }

  it('C2 refuses a failed ref without appending', async () => {
    state.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'fatal: bad revision\n' });
    const result = await call({
      name: 'borg_log',
      arguments: { message: 'RESULT', to: 'broadcast', refs: ['missing'] },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('fatal: bad revision');
    expect(state.appendLog).not.toHaveBeenCalled();
  });

  it('C6 requires refs for REVIEW-READY and appends resolved provenance when present', async () => {
    const refused = await call({
      name: 'borg_log',
      arguments: { message: 'REVIEW-READY branch', to: 'broadcast' },
    });
    expect(refused).toMatchObject({ isError: true });
    expect(state.appendLog).not.toHaveBeenCalled();

    state.handlers.length = 0;
    const posted = await call({
      name: 'borg_log',
      arguments: { message: 'REVIEW-READY branch', to: 'broadcast', refs: ['HEAD'] },
    });
    expect(posted.isError).toBeFalsy();
    expect(state.appendLog.mock.calls[0][2]).toBe(`REVIEW-READY branch\n\nHEAD = ${SHA}`);
  });

  it('C7 applies leading-dash refusal through borg_tool before Git or append', async () => {
    const result = await call({
      name: 'borg_tool',
      arguments: {
        name: 'borg_log',
        arguments: { message: 'RESULT', to: 'broadcast', refs: ['--output=x'] },
      },
    });
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toContain('must not start with');
    expect(state.spawnSync).not.toHaveBeenCalled();
    expect(state.appendLog).not.toHaveBeenCalled();
  });

  it('C8 falls back to findProjectRoot and refuses a non-repository directory', async () => {
    delete state.active.worktree;
    await call({
      name: 'borg_log',
      arguments: { message: 'RESULT', to: 'broadcast', refs: ['HEAD'] },
    });
    expect(state.findProjectRoot).toHaveBeenCalledOnce();
    expect(state.spawnSync.mock.calls[0][2]).toMatchObject({ cwd: '/fallback-repo' });
    expect(state.appendLog).toHaveBeenCalledOnce();

    state.handlers.length = 0;
    state.active.worktree = '/not-a-repo';
    state.spawnSync.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any parent): .git\n',
    });
    const refused = await call({
      name: 'borg_log',
      arguments: { message: `foreign ${'a'.repeat(40)}`, to: 'broadcast', refs: ['HEAD'] },
    });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content[0].text).toContain('not a git repository');
    expect(state.appendLog).toHaveBeenCalledOnce();
  });

  it('adds unresolved foreign SHA advisories only to the tool result', async () => {
    const foreign = 'abcdef0123456789abcdef0123456789abcdef01';
    state.spawnSync.mockImplementation((_command, args: string[]) => {
      const ref = args.at(-1);
      return ref === 'HEAD^{commit}'
        ? { status: 0, stdout: `${SHA}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: '' };
    });
    const result = await call({
      name: 'borg_log',
      arguments: { message: `RESULT ${foreign}`, to: 'broadcast', refs: ['HEAD'] },
    });
    expect(result.content[0].text).toContain(`unverified Git SHA(s): ${foreign}`);
    expect(state.appendLog.mock.calls[0][2]).not.toContain('unverified');
  });
});
