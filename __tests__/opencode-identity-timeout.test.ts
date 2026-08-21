import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  runMcpStartupServices: vi.fn(async () => {}),
  ensurePrivateRoot: vi.fn(() => new Promise<void>(() => {})),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    oninitialized?: () => void;
    setRequestHandler(_schema: unknown, handler: (request: any) => Promise<any>) {
      state.handlers.push(handler);
    }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/startup-services.js', () => ({ runMcpStartupServices: state.runMcpStartupServices }));
vi.mock('../src/readiness-probe.js', () => ({ isMcpReadinessProbe: () => false }));
vi.mock('../src/console-prefix.js', () => ({ consolePrefix: () => '', initConsolePrefix: vi.fn(async () => {}) }));
vi.mock('../src/private-root.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/private-root.js')>();
  return { ...actual, ensurePrivateBorgConfigRoot: state.ensurePrivateRoot };
});

import { main } from '../src/index.js';
import { openCodeStartupDiagnosticLogPath } from '../src/opencode-drone.js';
import {
  BORG_STATE_ROOT_ENV,
  borgConfigRoot,
  ensurePrivateBorgConfigRootSync,
} from '../src/private-root.js';

describe('OpenCode identity handshake timeout', () => {
  const originalAgentKind = process.env.BORG_AGENT_KIND;
  const originalStateRoot = process.env[BORG_STATE_ROOT_ENV];
  let testStateRoot: string;

  beforeEach(() => {
    testStateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'borg-opencode-identity-timeout-')));
    process.env[BORG_STATE_ROOT_ENV] = testStateRoot;
    vi.useFakeTimers();
    process.env.BORG_AGENT_KIND = 'opencode';
    state.handlers.length = 0;
    state.runMcpStartupServices.mockClear();
    state.ensurePrivateRoot.mockClear();
  });

  afterEach(() => {
    if (originalAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
    else process.env.BORG_AGENT_KIND = originalAgentKind;
    if (originalStateRoot === undefined) delete process.env[BORG_STATE_ROOT_ENV];
    else process.env[BORG_STATE_ROOT_ENV] = originalStateRoot;
    rmSync(testStateRoot, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('writes a doctor-readable diagnostic when initialize never completes', async () => {
    let outcome: unknown;
    const started = main().then(
      () => { outcome = 'resolved'; },
      (error) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(started).resolves.toBeUndefined();
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      'Borg OpenCode identity error [IDENTITY_HANDSHAKE_TIMEOUT]',
    );
    expect((outcome as Error).message).toContain(
      'OpenCode identity handshake did not complete',
    );
    const diagnosticPath = openCodeStartupDiagnosticLogPath();
    expect(readFileSync(diagnosticPath, 'utf8')).toContain(
      'Borg OpenCode identity error [IDENTITY_HANDSHAKE_TIMEOUT]',
    );
    expect(statSync(diagnosticPath).mode & 0o777).toBe(0o600);
    expect(state.runMcpStartupServices).not.toHaveBeenCalled();
    expect(state.ensurePrivateRoot).not.toHaveBeenCalled();
  });

  it('propagates the original identity error when diagnostic writing fails', async () => {
    ensurePrivateBorgConfigRootSync(borgConfigRoot());
    mkdirSync(openCodeStartupDiagnosticLogPath());
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let outcome: unknown;

    try {
      const started = main().then(
        () => { outcome = 'resolved'; },
        (error) => { outcome = error; },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(started).resolves.toBeUndefined();
    } finally {
      stderr.mockRestore();
    }

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      'Borg OpenCode identity error [IDENTITY_HANDSHAKE_TIMEOUT]',
    );
    expect(state.runMcpStartupServices).not.toHaveBeenCalled();
  });
});
