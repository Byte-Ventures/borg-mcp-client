import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const state = vi.hoisted(() => ({
  closeServer: vi.fn(async () => {}), closeBroker: vi.fn(async () => {}),
  call: vi.fn(), start: vi.fn(), prepare: vi.fn(async () => []),
}));
vi.mock('../src/opencode-launch-plugin.js', () => ({ migrateLegacyOpenCodePlugin: vi.fn(), installLaunchOpenCodePlugin: () => ({ directory: join(process.env.BORG_STATE_ROOT!, 'plugin') }) }));
vi.mock('../src/opencode-installation.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/opencode-installation.js')>(), verifyOpenCodeExecutableStillMatches: vi.fn() }));
vi.mock('../src/opencode-v2-server.js', () => ({ startOpenCodeV2Server: state.start }));
vi.mock('../src/opencode-v2-transport.js', () => ({ createOpenCodeV2Transport: async () => ({ client: {
  config: { get: async () => [] },
  session: { create: vi.fn(async () => {}), inbox: { cancel: vi.fn(async () => {}) } },
  mcp: { list: async () => ({ data: [{ name: 'borg', status: { status: 'connected' } }] }) },
} }) }));
vi.mock('../src/opencode-v2-permissions.js', () => ({ applyOpenCodeV2LaunchPermissions: state.prepare }));
vi.mock('../src/opencode-v2-broker.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/opencode-v2-broker.js')>(),
  startOpenCodeV2Broker: async options => ({ descriptor: { sessionID: options.sessionID }, call: state.call, selectSession: vi.fn(async () => {}), close: state.closeBroker }),
}));
import { launchOpenCodeV2Process } from '../src/opencode-v2-launch.js';
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-launch-completion-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.stubEnv('HOME', root);
  state.closeServer.mockClear(); state.closeBroker.mockClear(); state.start.mockReset(); state.call.mockReset();
  state.start.mockResolvedValue({ url: 'http://127.0.0.1:1234', pid: 123, version: '2.1.2', close: state.closeServer,
    tuiEnv: () => ({}), closed: new Promise(() => {}) });
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('retains an exit during kickoff admission and lets callers await idempotent cleanup', async () => {
  const child = new EventEmitter() as any; child.kill = vi.fn();
  state.call.mockImplementation(async (operation, body) => {
    if (operation === '/wake') {
      if (body.key === 'kickoff') {
        child.emit('exit', 7, null);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { accepted: true, id: 'msg_probe' };
    }
    return { pluginReady: true, tools: ['borg_borg_log'] };
  });
  const subdir = join(root, 'src'); mkdirSync(subdir);
  const launched = await launchOpenCodeV2Process({ installation: { major: 2, minor: 1, patch: 2, executable: '/native/opencode' } as any,
    cwd: subdir, env: {}, prompt: 'kickoff', seat: { worktree: root, cubeId: 'cube', droneId: 'drone' },
    spawnProcess: ((_executable, _args, options) => {
      expect(options.cwd).toBe(root); queueMicrotask(() => child.emit('spawn')); return child;
    }) as any });
  expect(await launched.completion).toEqual({ kind: 'exit', code: 7, signal: null });
  await Promise.all([launched.cleanup(), launched.cleanup()]);
  expect(state.closeBroker).toHaveBeenCalledTimes(1); expect(state.closeServer).toHaveBeenCalledTimes(1);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(state.call.mock.calls.filter(([op, input]) => op === '/wake' && input.key === 'kickoff')).toHaveLength(1);
});
