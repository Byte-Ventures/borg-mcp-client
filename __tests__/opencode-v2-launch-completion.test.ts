import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/opencode-v2-startup.js', () => ({ withOpenCodeV2Startup: (operation: () => Promise<unknown>) => operation() }));
const state = vi.hoisted(() => ({
  closeServer: vi.fn(async () => {}), closeBroker: vi.fn(async () => {}),
  call: vi.fn(), start: vi.fn(), prepare: vi.fn(async () => []),
  config: vi.fn(async () => []), startupSignal: (() => undefined) as () => AbortSignal | undefined,
}));
vi.mock('../src/opencode-launch-plugin.js', () => ({ migrateLegacyOpenCodePlugin: vi.fn(), installLaunchOpenCodePlugin: () => ({ directory: join(process.env.BORG_STATE_ROOT!, 'plugin') }) }));
vi.mock('../src/opencode-installation.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/opencode-installation.js')>(), verifyOpenCodeExecutableStillMatches: vi.fn() }));
vi.mock('../src/opencode-v2-server.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/opencode-v2-server.js')>(), startOpenCodeV2Server: state.start }));
vi.mock('../src/opencode-v2-transport.js', () => ({ createOpenCodeV2Transport: async (_server, options) => {
  state.startupSignal = options.startupSignal;
  return { client: {
    config: { get: state.config },
    session: { create: vi.fn(async () => {}), inbox: { cancel: vi.fn(async () => {}) } },
    mcp: { list: async () => ({ data: [{ name: 'borg', status: { status: 'connected' } }] }) },
  } };
} }));
vi.mock('../src/opencode-v2-permissions.js', () => ({ applyOpenCodeV2LaunchPermissions: state.prepare }));
vi.mock('../src/opencode-v2-broker.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/opencode-v2-broker.js')>(),
  startOpenCodeV2Broker: async options => ({ descriptor: { sessionID: options.sessionID }, call: state.call, selectSession: vi.fn(async () => {}), close: state.closeBroker }),
}));
import { launchOpenCodeV2Process } from '../src/opencode-v2-launch.js';
import { ToolNameMigrationError } from '../src/tool-name-migration.js';
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-launch-completion-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.stubEnv('HOME', root);
  state.closeServer.mockClear(); state.closeBroker.mockClear(); state.start.mockReset(); state.call.mockReset();
  state.prepare.mockReset(); state.prepare.mockResolvedValue([]);
  state.config.mockReset(); state.config.mockResolvedValue([]);
  state.start.mockResolvedValue({ url: 'http://127.0.0.1:1234', pid: 123, version: '2.1.2', close: state.closeServer,
    tuiEnv: () => ({}), closed: new Promise(() => {}) });
});
it('preserves the actionable migration refusal and cleans up before TUI or kickoff', async () => {
  state.call.mockResolvedValue({ accepted: true, pluginReady: true, tools: ['borg_borg_log'] });
  const failure = new ToolNameMigrationError('opencode', 'a legacy hard policy needs migration.');
  state.prepare.mockRejectedValue(failure);
  const spawnProcess = vi.fn();
  await expect(launchOpenCodeV2Process({ installation: { major: 2, minor: 1, patch: 2, executable: '/native/opencode' } as any,
    cwd: root, env: {}, prompt: 'kickoff', seat: { worktree: root, cubeId: 'cube', droneId: 'drone' },
    spawnProcess: spawnProcess as any,
  })).rejects.toBe(failure);
  expect(spawnProcess).not.toHaveBeenCalled();
  expect(state.closeBroker).toHaveBeenCalledTimes(1);
  expect(state.closeServer).toHaveBeenCalledTimes(1);
  expect(state.call.mock.calls.some(([op, input]) => op === '/wake' && input.key === 'kickoff')).toBe(false);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
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

it('shares a startup deadline through slow config and plugin readiness, then withdraws it before one kickoff', async () => {
  vi.useFakeTimers();
  let deadline: AbortSignal | undefined;
  state.config.mockImplementation(async () => {
    deadline = state.startupSignal();
    await new Promise(resolve => setTimeout(resolve, 11_000));
    expect(deadline?.aborted).toBe(false); return [];
  });
  state.call.mockImplementation(async (operation, body, request) => {
    if (operation === '/wake' && body.key === 'kickoff') {
      expect(state.startupSignal()).toBeUndefined();
      expect(request).toBeUndefined();
    } else expect(request.signal).toBe(deadline);
    if (operation === '/wake' && body.key === 'readiness') await new Promise(resolve => setTimeout(resolve, 16_000));
    return { accepted: true, id: 'msg_probe', pluginReady: true, tools: ['borg_borg_log'] };
  });
  const child = new EventEmitter() as any; child.kill = vi.fn();
  const launched = launchOpenCodeV2Process({ installation: { major: 2, minor: 2, patch: 5, executable: '/native/opencode' } as any,
    cwd: root, env: {}, prompt: 'kickoff', seat: { worktree: root, cubeId: 'cube', droneId: 'drone' },
    spawnProcess: (() => { queueMicrotask(() => child.emit('spawn')); return child; }) as any });
  const assertion = expect(launched).resolves.toBeDefined();
  await vi.advanceTimersByTimeAsync(27_001);
  await assertion;
  const result = await launched;
  expect(state.call.mock.calls.filter(([op, input]) => op === '/wake' && input.key === 'kickoff')).toHaveLength(1);
  await result.cleanup();
});

it('fails a stalled startup at the shared deadline and cleans up before TUI or kickoff', async () => {
  vi.useFakeTimers();
  state.config.mockImplementation(() => new Promise((_, reject) => {
    const signal = state.startupSignal()!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const spawnProcess = vi.fn();
  const failure = expect(launchOpenCodeV2Process({ installation: { major: 2, minor: 2, patch: 5, executable: '/native/opencode' } as any,
    cwd: root, env: {}, prompt: 'kickoff', seat: { worktree: root, cubeId: 'cube', droneId: 'drone' },
    spawnProcess: spawnProcess as any })).rejects.toThrow('configuration inspection. No kickoff was submitted.');
  await vi.advanceTimersByTimeAsync(60_001); await failure;
  expect(spawnProcess).not.toHaveBeenCalled();
  expect(state.call).not.toHaveBeenCalled();
  expect(state.closeServer).toHaveBeenCalledTimes(1);
});
