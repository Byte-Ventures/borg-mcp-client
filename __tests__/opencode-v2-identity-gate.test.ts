import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  startup: vi.fn(async () => {}), bind: vi.fn(async () => true), inject: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({ Server: class {
  oninitialized?: () => void;
  setRequestHandler(_schema: unknown, handler: any) { state.handlers.push(handler); }
  async connect() { this.oninitialized?.(); }
} }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/startup-services.js', () => ({ runMcpStartupServices: state.startup }));
vi.mock('../src/readiness-probe.js', () => ({ isMcpReadinessProbe: () => false }));
vi.mock('../src/console-prefix.js', () => ({ consolePrefix: () => '', initConsolePrefix: vi.fn(async () => {}) }));
vi.mock('../src/opencode-seat-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/opencode-seat-identity.js')>(),
  resolveOpenCodeSeatIdentity: vi.fn(async () => ({ cubeId: 'cube-B', droneId: 'drone-B', worktree: '/seat-B', droneLabel: 'B', name: 'cube' })),
}));
vi.mock('../src/opencode-v2-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/opencode-v2-runtime.js')>(), connectOpenCodeV2Runtime: state.bind,
}));
vi.mock('../src/log-stream.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/log-stream.js')>(), setModuleInjectOpenCode: state.inject,
}));
import { main } from '../src/index.js';
let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-identity-bind-')));
  vi.stubEnv('BORG_STATE_ROOT', root); vi.stubEnv('BORG_AGENT_KIND', 'opencode'); vi.stubEnv('BORG_OPENCODE_V2_DESCRIPTOR', '/descriptor-A');
  state.handlers.length = 0; state.startup.mockClear(); state.bind.mockReset(); state.inject.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

it('blocks tools and startup services when V2 cannot bind the resolved seat', async () => {
  state.bind.mockRejectedValueOnce(new Error('capability-secret-do-not-print'));
  await expect(main()).rejects.toThrow('LAUNCH_BINDING_INVALID');
  expect(state.bind).toHaveBeenCalledWith({ cubeId: 'cube-B', droneId: 'drone-B', worktree: '/seat-B' }, process.env);
  expect(state.startup).not.toHaveBeenCalled(); expect(state.inject).not.toHaveBeenCalled();
  expect(await state.handlers[0]({})).toEqual({ tools: [] });
  const tool = await state.handlers[1]({ params: { name: 'borg_whoami' } });
  expect(tool.isError).toBe(true);
  expect(JSON.stringify(tool)).toContain('LAUNCH_BINDING_INVALID');
  expect(JSON.stringify(tool)).not.toContain('capability-secret');
});

it('cannot install injection callbacks when binding resolves after the identity timeout', async () => {
  vi.useFakeTimers(); let release!: (bound: boolean) => void;
  state.bind.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const started = main().catch(error => error);
  await vi.advanceTimersByTimeAsync(5001);
  expect((await started).message).toContain('IDENTITY_HANDSHAKE_TIMEOUT');
  release(true); await vi.advanceTimersByTimeAsync(0);
  expect(state.inject).not.toHaveBeenCalled(); expect(state.startup).not.toHaveBeenCalled();
});
