import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: [] as Array<(request: any) => Promise<any>>,
  runMcpStartupServices: vi.fn(async () => {}),
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

import { main } from '../src/index.js';

describe('OpenCode identity handshake timeout', () => {
  const originalAgentKind = process.env.BORG_AGENT_KIND;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.BORG_AGENT_KIND = 'opencode';
    state.handlers.length = 0;
    state.runMcpStartupServices.mockClear();
  });

  afterEach(() => {
    if (originalAgentKind === undefined) delete process.env.BORG_AGENT_KIND;
    else process.env.BORG_AGENT_KIND = originalAgentKind;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fails closed with an operator-visible diagnostic when initialize never completes', async () => {
    let outcome: unknown;
    const started = main().then(
      () => { outcome = 'resolved'; },
      (error) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      'Borg OpenCode identity error [IDENTITY_HANDSHAKE_TIMEOUT]',
    );
    expect((outcome as Error).message).toContain(
      'OpenCode identity handshake did not complete',
    );
    await expect(started).resolves.toBeUndefined();

    expect(state.runMcpStartupServices).not.toHaveBeenCalled();
  });
});
