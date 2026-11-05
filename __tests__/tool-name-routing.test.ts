import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { LEGACY_TOOL_ALIASES } from '../src/tool-names.js';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  active: null as any,
  readLog: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: class {
  setRequestHandler(schema: any, handler: any) { state.handlers.set(schema.shape.method.value, handler); }
  async connect() {}
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/startup-services.js', () => ({ runMcpStartupServices: vi.fn() }));
vi.mock('../src/console-prefix.js', () => ({ initConsolePrefix: vi.fn(), consolePrefix: () => '' }));
vi.mock('../src/cubes.js', async original => ({
  ...await original<typeof import('../src/cubes.js')>(),
  getActiveCube: async () => state.active,
  requireActiveCube: async () => { if (!state.active) throw new Error('No active fixture cube'); return state.active; },
}));
vi.mock('../src/remote-client.js', async original => {
  const module = await original<typeof import('../src/remote-client.js')>();
  return Object.fromEntries(Object.entries(module).map(([key, value]) => [key,
    key === 'readLog' ? state.readLog : typeof value === 'function' ? vi.fn(() => { throw new Error('Fixture backend refused'); }) : value]));
});
const call = (name: string, args: Record<string, unknown> = {}) => state.handlers.get('tools/call')!({ params: { name, arguments: args } });

beforeAll(async () => {
  vi.stubEnv('BORG_AGENT_KIND', 'claude');
  vi.stubEnv('BORG_OPENCODE', '');
  const { main } = await import('../src/index.js');
  await main();
});
beforeEach(() => {
  vi.stubEnv('BORG_SESSION', '1');
  state.active = null;
  state.readLog.mockReset();
});
afterAll(() => { vi.unstubAllEnvs(); });

describe('main MCP alias routing through the actual handler', () => {
  it.each(Object.entries(LEGACY_TOOL_ALIASES).filter(([, canonical]) => !canonical.startsWith('borg_representative_')))(
    '%s uses the same handler and validation as %s', async (legacy, canonical) => {
      expect(await call(legacy)).toEqual(await call(canonical));
      expect(await call('borg_tool', { name: legacy, arguments: {} })).toEqual(
        await call(canonical === 'borg_describe_tool' ? 'borg_tool' : canonical,
          canonical === 'borg_describe_tool' ? { name: canonical, arguments: {} } : {}));
      expect(await call('borg_describe-tool', { name: legacy })).toEqual(await call('borg_describe_tool', { name: canonical }));
    });
  it('guards legacy describe recursion before dispatch and never exposes representative tools', async () => {
    expect((await call('borg_tool', { name: 'borg_describe-tool', arguments: { name: 'borg_read-log' } })).isError).toBe(true);
    for (const name of ['borg_representative-send', 'borg_representative_send', 'borg_read--log']) {
      expect((await call(name)).isError).toBe(true);
      expect((await call('borg_tool', { name })).isError).toBe(true);
    }
  });
  it('keeps activation closed for both spellings and dispatch', async () => {
    vi.stubEnv('BORG_SESSION', '');
    for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_ALIASES).filter(([, name]) => !name.startsWith('borg_representative_') && name !== 'borg_describe_tool')) {
      const result = await call(legacy);
      expect(result).toEqual(await call(canonical));
      expect(result).toEqual(await call('borg_tool', { name: legacy }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('inactive');
    }
    expect(state.readLog).not.toHaveBeenCalled();
  });
  it('passes the same validated identity, trust and arguments once per accepted or refused read', async () => {
    state.active = { sessionToken: 'fixture-session', apiUrl: 'https://127.0.0.1:7000', serverTrustIdentity: 'fixture-trust', name: 'fixture', droneId: 'fixture-drone' };
    for (const denied of [false, true]) {
      state.readLog.mockImplementation(async () => {
        if (denied) throw new Error('Forbidden: fixture cube grant revoked');
        return { entries: [], drones: [], roles: [], behind_by: 0, has_more: false };
      });
      const args = { unread_only: true, limit: 5 };
      const canonical = await call('borg_read_log', args);
      expect(await call('borg_read-log', args)).toEqual(canonical);
      expect(await call('borg_tool', { name: 'borg_read-log', arguments: args })).toEqual(canonical);
      expect(canonical.isError === true).toBe(denied);
    }
    expect(state.readLog).toHaveBeenCalledTimes(6);
    for (const args of state.readLog.mock.calls) expect(args).toEqual(['fixture-session', 'https://127.0.0.1:7000', {
      since: undefined, limit: 5, unreadOnly: true, serverTrustIdentity: 'fixture-trust',
    }]);
  });
});
