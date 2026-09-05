import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import { CodexAppServerClient } from '../src/codex-app-server';

const configRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'borg-codex-wake-'));
});
vi.mock('../src/private-root.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/private-root.js')>(),
  borgConfigRoot: () => configRoot,
}));
afterAll(() => rmSync(configRoot, { recursive: true, force: true }));
import {
  CODEX_CATCHUP_PROMPT,
  CODEX_HEARTBEAT_CADENCE_MS,
  fireCodexHeartbeatTick,
  formatCodexWakePrompt,
  getLastDeliveredAt,
  isCodexRemoteWakeEnabled,
  probeCodexBridgeArmed,
  resetCodexWakeForTests,
  resolveSessionAgentKind,
  resolveCodexWakeTarget,
  startCodexHeartbeat,
  wakeCodexViaAppServer,
} from '../src/codex-app-wake';
import { wakeRetryBackoffMs } from '../src/codex-wake-resolve';
import { CUBE_ACTIVITY_RESUME_WAKE_MESSAGE } from '../src/cube-activity-wake-copy';

function liveTargetDeps(client: any, threadId = 'thread-123', socketPath = '/tmp/codex.sock') {
  if (!client.loadedThreadIds) client.loadedThreadIds = vi.fn(async () => [threadId]);
  return {
    env: {
      BORG_CODEX_REMOTE_WAKE: '1',
      BORG_CODEX_APP_SERVER_SOCKET: socketPath,
    } as NodeJS.ProcessEnv,
    cwd: () => '/repo',
    createClient: vi.fn(() => client),
  };
}

describe('codex app-server wake gating', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  it('is disabled unless BORG_CODEX_REMOTE_WAKE=1', () => {
    expect(isCodexRemoteWakeEnabled({} as any)).toBe(false);
    expect(isCodexRemoteWakeEnabled({ BORG_CODEX_REMOTE_WAKE: '0' } as any)).toBe(false);
    expect(isCodexRemoteWakeEnabled({ BORG_CODEX_REMOTE_WAKE: '1' } as any)).toBe(true);
  });

  it('resolves an explicit CLI identity ahead of legacy remote-wake fallbacks', () => {
    expect(resolveSessionAgentKind({} as any)).toBe('claude');
    expect(resolveSessionAgentKind({ BORG_CODEX_REMOTE_WAKE: '0' } as any)).toBe('claude');
    expect(resolveSessionAgentKind({ BORG_CODEX_REMOTE_WAKE: '1' } as any)).toBe('codex');
    expect(resolveSessionAgentKind({ BORG_AGENT_KIND: 'codex' } as any)).toBe('codex');
    expect(resolveSessionAgentKind({ BORG_AGENT_KIND: 'claude', BORG_CODEX_REMOTE_WAKE: '1' } as any)).toBe('claude');
    expect(resolveSessionAgentKind({ BORG_AGENT_KIND: 'opencode', BORG_CODEX_REMOTE_WAKE: '1' } as any)).toBe('opencode');
  });

  it('enables app-server wake when remote wake is enabled', () => {
    expect(resolveCodexWakeTarget({ BORG_CODEX_REMOTE_WAKE: '1' } as any)).toEqual({
      enabled: true,
    });
  });

  it('keeps a static Codex identity dormant when its launch explicitly disables remote transport', () => {
    const env = {
      BORG_AGENT_KIND: 'codex',
      BORG_CODEX_REMOTE_WAKE: '0',
    } as NodeJS.ProcessEnv;
    const createClient = vi.fn();

    expect(resolveSessionAgentKind(env)).toBe('codex');
    expect(isCodexRemoteWakeEnabled(env)).toBe(false);
    expect(resolveCodexWakeTarget(env)).toEqual({ enabled: false });
    wakeCodexViaAppServer('must not bridge', env, { createClient });
    expect(createClient).not.toHaveBeenCalled();
    expect(startCodexHeartbeat({
      agentKind: resolveSessionAgentKind(env),
      remoteWakeEnabled: isCodexRemoteWakeEnabled(env),
    })).toBeNull();
  });

  it('formats a lightweight wake prompt without forcing regen', () => {
    const prompt = formatCodexWakePrompt('2026-05-28T10:00:00.000Z drone-1 (Coordinator): DISPATCH: drone-2');
    expect(prompt).toContain(CUBE_ACTIVITY_RESUME_WAKE_MESSAGE);
    expect(prompt).toContain('drone-1 (Coordinator): DISPATCH: drone-2');
    expect(prompt).not.toContain('Call borg_regen');
    expect(prompt).not.toContain('follow the playbook');
  });

  it('does not call the app-server when the env socket is unavailable', async () => {
    const client = {
      connect: vi.fn(),
      readThread: vi.fn(),
      startTurn: vi.fn(),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      createClient: vi.fn(() => client),
      env: {} as NodeJS.ProcessEnv,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.connect).not.toHaveBeenCalled();
  });

  it('starts a turn on the thread resolved from the env socket', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'idle' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(client.readThread).toHaveBeenCalledWith('thread-123');
    expect(client.startTurn).toHaveBeenCalledWith('thread-123', 'one');
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('records a wake-path receipt after Codex remote-control delivery succeeds', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'idle' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).toHaveBeenCalledWith('thread-123', 'one');
  });

  it('does not record a Codex wake-path receipt when the thread is already active', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'active' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it('skips turn injection when the resolved Codex thread is already active', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'active' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.readThread).toHaveBeenCalledWith('thread-123');
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(2);
  });

  it('does not mark active-thread wake skips as delivered', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi
        .fn()
        .mockResolvedValueOnce({
          id: 'thread-123',
          cwd: '/repo',
          preview: 'preview',
          status: { type: 'active' },
          updatedAt: 1,
        })
        .mockResolvedValueOnce({
          id: 'thread-123',
          cwd: '/repo',
          preview: 'preview',
          status: { type: 'active' },
          updatedAt: 1,
        })
        .mockResolvedValueOnce({
          id: 'thread-123',
          cwd: '/repo',
          preview: 'preview',
          status: { type: 'idle' },
          updatedAt: 2,
        })
        .mockResolvedValueOnce({
          id: 'thread-123',
          cwd: '/repo',
          preview: 'preview',
          status: { type: 'idle' },
          updatedAt: 2,
        }),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    };

    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.readThread).toHaveBeenCalledTimes(4);
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('thread-123', 'same-log-entry');
  });

  it('serializes distinct concurrent wake attempts while a prior turn injection is running', async () => {
    let release: (() => void) | null = null;
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'idle' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    };

    wakeCodexViaAppServer('one', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    wakeCodexViaAppServer('two', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).toHaveBeenCalledTimes(2);
    expect(client.startTurn).toHaveBeenNthCalledWith(1, 'thread-123', 'one');
    expect(client.startTurn).toHaveBeenNthCalledWith(2, 'thread-123', 'two');
    expect(client.connect).toHaveBeenCalledTimes(4);
  });

  it('drops a queued wake after its durable entry is consumed', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123', cwd: '/repo', preview: 'preview',
        status: { type: 'idle' }, updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube', droneId: 'drone', name: 'cube', sessionToken: 'token',
        droneLabel: 'drone', apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
      hasPendingEntry: vi.fn(async () => false),
    };

    wakeCodexViaAppServer(
      'stale', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps, undefined, 'entry-stale',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).not.toHaveBeenCalled();
    expect(deps.hasPendingEntry).toHaveBeenCalledWith(expect.objectContaining({ cubeId: 'cube' }), 'entry-stale');
  });

  it('still deduplicates identical pending wake prompts after delivery', async () => {
    let release: (() => void) | null = null;
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'idle' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(() => {
        if (!release) {
          return new Promise<void>((resolve) => { release = resolve; });
        }
        return Promise.resolve();
      }),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    };

    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).toHaveBeenCalledTimes(1);
  });

  it('does not inject the same wake prompt again after it was already delivered', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({
        id: 'thread-123',
        cwd: '/repo',
        preview: 'preview',
        status: { type: 'idle' },
        updatedAt: 1,
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube',
        droneId: 'drone',
        name: 'cube',
        sessionToken: 'token',
        droneLabel: 'drone',
        apiUrl: 'https://api.example.test',
      })),
      ...liveTargetDeps(client),
    };

    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    wakeCodexViaAppServer('same-log-entry', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.connect).toHaveBeenCalledTimes(3);
  });
});

describe('gh#633 — probeCodexBridgeArmed (agnostic wake-armed for codex)', () => {
  const ACTIVE = { cubeId: 'c1', droneId: 'd1' };

  it('env socket absent or missing on disk → false', async () => {
    const res = await probeCodexBridgeArmed(ACTIVE, {
      env: {},
      checkBridge: () => {
        throw new Error('should not probe the bridge when there is no socket');
      },
    });
    expect(res).toBe(false);
    expect(await probeCodexBridgeArmed(ACTIVE, {
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/s/missing.sock' },
      socketExists: () => false,
      checkBridge: () => { throw new Error('should not probe a missing socket'); },
    })).toBe(false);
  });

  it('env socket exists → passes it through to the bridge liveness check', async () => {
    let seen = '';
    const res = await probeCodexBridgeArmed(ACTIVE, {
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/s/abc.sock' },
      socketExists: () => true,
      checkBridge: (sp) => {
        seen = sp as string;
        return true;
      },
    });
    expect(seen).toBe('/s/abc.sock');
    expect(res).toBe(true);
  });

  it('passes the bridge tri-state through: dead→false, indeterminate→null', async () => {
    const run = (bridge: boolean | null) =>
      probeCodexBridgeArmed(ACTIVE, {
        env: { BORG_CODEX_APP_SERVER_SOCKET: '/s/abc.sock' },
        socketExists: () => true,
        checkBridge: () => bridge,
      });
    expect(await run(false)).toBe(false);
    expect(await run(null)).toBeNull();
  });

  it('socket inspection throws → null (indeterminate → caller maps to armed)', async () => {
    const res = await probeCodexBridgeArmed(ACTIVE, {
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/s/abc.sock' },
      socketExists: () => { throw new Error('socket inspection failed'); },
    });
    expect(res).toBeNull();
  });
});

describe('gh#708: coalesced catch-up wake on a mid-turn-active thread', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  const ACTIVE_CUBE = {
    cubeId: 'c',
    droneId: 'd',
    name: 'c',
    sessionToken: 't',
    droneLabel: 'd',
    apiUrl: 'https://api.example.test',
  };

  // A fake app-server client whose readThread returns the next status each call
  // (clamped to the last). status[0] is the INITIAL wake; the rest are polls.
  function clientWithStatuses(statuses: Array<'active' | 'idle'>) {
    let i = 0;
    return {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({
        id: 'th',
        status: { type: statuses[Math.min(i++, statuses.length - 1)] },
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(() => {}),
    };
  }

  function baseDeps(client: ReturnType<typeof clientWithStatuses>, now: () => number = () => 1000) {
    return {
      getActiveCube: vi.fn(async () => ACTIVE_CUBE),
      ...liveTargetDeps(client, 'th', '/s'),
      sleep: vi.fn(async () => {}), // immediate — no real timers in tests
      now,
    };
  }

  // flush the async poller microtasks/iterations
  async function flush(ms = 30) {
    await new Promise((r) => setTimeout(r, ms));
  }

  it('delivers ONE static catch-up wake once the thread goes idle (no per-entry replay)', async () => {
    // initial wake → active (DROP) ; poll1 → active ; poll2 → idle → catch-up
    const client = clientWithStatuses(['active', 'active', 'idle']);
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, baseDeps(client));
    await flush();
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });

  it('coalesces N wakes dropped during one busy turn into a SINGLE catch-up', async () => {
    const client = clientWithStatuses(['active', 'active', 'active', 'idle']);
    const deps = baseDeps(client);
    // three entries arrive while the thread is active → three drops, one poller
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    wakeCodexViaAppServer('entry-2', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    wakeCodexViaAppServer('entry-3', { BORG_CODEX_REMOTE_WAKE: '1' } as any, deps);
    await flush();
    const catchUps = client.startTurn.mock.calls.filter((c) => c[1] === CODEX_CATCHUP_PROMPT);
    expect(catchUps).toHaveLength(1); // exactly one coalesced catch-up
  });

  it('re-defers while the thread stays active, then delivers when it goes idle', async () => {
    const client = clientWithStatuses(['active', 'active', 'active', 'active', 'idle']);
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, baseDeps(client));
    await flush();
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
    // polled multiple times before idle (initial + ≥3 polls)
    expect(client.readThread.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('gives up (no catch-up) if the thread never goes idle before the deadline', async () => {
    const client = clientWithStatuses(['active']); // always active
    // advancing clock: each now() call jumps 6 minutes → crosses the 15-min deadline fast
    let t = 0;
    const now = () => (t += 6 * 60_000);
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, baseDeps(client, now));
    await flush();
    expect(client.startTurn).not.toHaveBeenCalled(); // never delivered; heartbeat is the backstop
  });

  it('does NOT schedule a catch-up when the thread is idle on the first wake (normal path intact)', async () => {
    const client = clientWithStatuses(['idle']); // idle on the initial wake
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, baseDeps(client));
    await flush();
    // normal per-entry wake delivered with the entry reason; no catch-up
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('th', 'entry-1');
    expect(client.startTurn).not.toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });

  it('CODEX_CATCHUP_PROMPT is static — carries no token/secret/PII interpolation', () => {
    expect(CODEX_CATCHUP_PROMPT).toContain('borg_read-log unread_only=true');
    expect(CODEX_CATCHUP_PROMPT).toContain('Wake triage');
    expect(CODEX_CATCHUP_PROMPT).toContain(CUBE_ACTIVITY_RESUME_WAKE_MESSAGE);
    expect(CODEX_CATCHUP_PROMPT).toContain('resume the prior interrupted work');
    expect(CODEX_CATCHUP_PROMPT).not.toContain('${');
    expect(CODEX_CATCHUP_PROMPT).not.toMatch(/token|secret|session|bearer/i);
  });
});

describe('gh#855/client#89 — env-socket wake-target resolution', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  const ACTIVE = {
    cubeId: '11111111-1111-4111-8111-111111111111',
    droneId: '22222222-2222-4222-8222-222222222222',
    name: 'cube',
    sessionToken: 'tok',
    droneLabel: 'drone',
    apiUrl: 'https://api.example.test',
  };
  const flush = () => new Promise((r) => setTimeout(r, 10));

  it('wakes via the live env socket and re-resolved thread', async () => {
    const live = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['live-thread']),
      readThread: vi.fn(async (id: string) => ({ id, cwd: '/repo', preview: 'p', status: { type: 'idle' }, updatedAt: 5 })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    wakeCodexViaAppServer('hello', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      createClient: vi.fn(() => live),
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/run/live.sock' } as any,
      cwd: () => '/repo',
    });
    await flush();

    expect(live.loadedThreadIds).toHaveBeenCalled();
    expect(live.startTurn).toHaveBeenCalledWith('live-thread', 'hello');
  });

  it('env socket absent ignores a persisted stale target without app-server calls', async () => {
    const targetFile = join(configRoot, 'codex-wake-targets.json');
    writeFileSync(targetFile, JSON.stringify({ targets: {
      [`${ACTIVE.cubeId}:${ACTIVE.droneId}`]: {
        socketPath: '/stale.sock', threadId: 'stale-thread', updatedAt: 'stale',
      },
    } }));
    const client = {
      connect: vi.fn(),
      loadedThreadIds: vi.fn(),
      readThread: vi.fn(),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    wakeCodexViaAppServer('hi', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      createClient: vi.fn(() => client),
      env: {} as any,
      cwd: () => '/repo',
    });
    await flush();

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.loadedThreadIds).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it.each(['cli', { subagent: { other: 'guardian' } }])('readThread preserves source %j from the RPC response', async (source) => {
    const client = new CodexAppServerClient('/unused.sock');
    const request = vi.spyOn(client as any, 'request').mockResolvedValue({
      thread: { id: 'thread-1', cwd: '/repo', preview: 'p', status: { type: 'idle' }, updatedAt: 1, source },
    });
    try {
      const thread = await client.readThread('thread-1');
      expect(request).toHaveBeenCalledWith('thread/read', { threadId: 'thread-1', includeTurns: false });
      expect(thread?.source).toEqual(source);
    } finally {
      request.mockRestore();
    }
  });

  it('no loaded thread schedules retry-drain and delivers one catch-up after the thread loads', async () => {
    let resolves = 0;
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => (++resolves === 1 ? [] : ['thread-1'])),
      readThread: vi.fn(async (id: string) => ({ id, cwd: '/repo', preview: 'p', status: { type: 'idle' }, updatedAt: 1 })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    wakeCodexViaAppServer('x', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      createClient: vi.fn(() => client),
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/run/live.sock' } as any,
      cwd: () => '/repo',
      hasPendingEntry: vi.fn(async () => true),
      sleep: vi.fn(async () => {}),
      now: () => 1000,
      jitter: () => 0,
      maxAttempts: 2,
    }, 'delivery-1', 'entry-1');
    await flush();

    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('thread-1', CODEX_CATCHUP_PROMPT);
  });

  it('never targets a loaded Codex subagent thread', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['root', 'guardian']),
      readThread: vi.fn(async (id: string) => ({
        id,
        cwd: '/repo',
        preview: 'p',
        status: { type: 'idle' },
        updatedAt: id === 'guardian' ? 999 : 1,
        source: id === 'guardian' ? { subagent: { other: 'guardian' } } : 'cli',
      })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };

    wakeCodexViaAppServer('wake root', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      createClient: vi.fn(() => client),
      env: { BORG_CODEX_APP_SERVER_SOCKET: '/run/live.sock' } as any,
      cwd: () => '/repo',
    });
    await flush();

    expect(client.startTurn).toHaveBeenCalledWith('root', 'wake root');
    expect(client.startTurn).not.toHaveBeenCalledWith('guardian', expect.any(String));
  });

  it.each([false, true])('resolves the Codex 0.153.4 user thread with unreadable id=%s', async (unreadable) => {
    const threads = [
      { id: 'user', cwd: '/repo', source: 'cli', ephemeral: false, threadSource: 'user', preview: 'Borg task', turns: [], createdAt: 100, updatedAt: 101, status: { type: 'idle' } },
      { id: 'system', cwd: '/repo', source: 'vscode', ephemeral: true, threadSource: 'system', preview: '', turns: [], createdAt: 999, updatedAt: 999, status: { type: 'idle' } },
    ];
    const adapter = new CodexAppServerClient('/unused.sock');
    const request = vi.spyOn(adapter as any, 'request').mockImplementation(async (_method, params: any) => {
      if (params.threadId === 'unreadable') throw new Error('thread unavailable');
      return { thread: threads.find((thread) => thread.id === params.threadId) };
    });
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => [...(unreadable ? ['unreadable'] : []), 'user', 'system']),
      readThread: adapter.readThread.bind(adapter),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    try {
      expect(await adapter.readThread('system')).toMatchObject({ ephemeral: true, threadSource: 'system', turns: [] });
      wakeCodexViaAppServer('wake user', { BORG_CODEX_REMOTE_WAKE: '1' }, {
        getActiveCube: vi.fn(async () => ACTIVE),
        createClient: () => client,
        env: { BORG_CODEX_APP_SERVER_SOCKET: '/run/live.sock' },
        cwd: () => '/repo',
      });
      await flush();
      expect(client.startTurn).toHaveBeenCalledExactlyOnceWith('user', 'wake user');
    } finally {
      resetCodexWakeForTests();
      request.mockRestore();
    }
  });
});

describe('gh#857 WI-1 — durable per-entry retry (no more silent drop)', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  const ACTIVE = {
    cubeId: 'c',
    droneId: 'd',
    name: 'c',
    sessionToken: 't',
    droneLabel: 'd',
    apiUrl: 'https://api.example.test',
  };
  const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  it('a TRANSIENT error on the immediate wake is RETRIED (not swallowed) with backoff and delivers the drain once reachable', async () => {
    // readThread throws on the immediate wake (transient) → old code SWALLOWED it
    // and dropped the entry. Now: catch → retry-drain → next attempt is idle →
    // CODEX_CATCHUP_PROMPT delivered (server cursor then drains all unread).
    let reads = 0;
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => {
        reads++;
        if (reads === 1) throw new Error('transient socket read');
        return { id: 'th', status: { type: 'idle' } };
      }),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const sleep = vi.fn(async () => {});
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      ...liveTargetDeps(client, 'th', '/s'),
      sleep,
      now: () => 1000, // constant → never hits the age cap; the retry succeeds first
      jitter: () => 250,
    });
    await flush();

    // The transient miss was retried and the drain landed (not dropped).
    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
    // Backoff WAS applied (not a busy-spin): first retry waits base + jitter, and
    // the sleep precedes the (successful) second readThread.
    expect(sleep).toHaveBeenCalledWith(wakeRetryBackoffMs(0, 250)); // 5000 + 250
    // Delivery recorded at the injected clock value (feeds the WI-2 gate).
    expect(getLastDeliveredAt()).toBe(1000);
  });

  it('the retry-drain TERMINATES via the iteration ceiling under a non-advancing clock (no hot-spin)', async () => {
    // A thread that never goes idle + a CONSTANT clock: the time-based age cap
    // can never fire, so without the iteration ceiling the loop would hot-spin
    // forever. With deps.maxAttempts the loop bails. Proven by a STABLE call
    // count across two flushes (terminated, not still iterating).
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'active' } })), // never idle
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      ...liveTargetDeps(client, 'th', '/s'),
      sleep: vi.fn(async () => {}),
      now: () => 1000, // constant → age cap never fires
      jitter: () => 0,
      maxAttempts: 3, // small ceiling so the test doesn't run the prod 1000
    });
    await flush();
    const afterFirst = client.readThread.mock.calls.length;
    await flush();
    const afterSecond = client.readThread.mock.calls.length;

    expect(client.startTurn).not.toHaveBeenCalled(); // never idle → never delivered
    expect(afterFirst).toBeLessThanOrEqual(8); // resolver + delivery reads for 1 immediate + ≤3 retries
    expect(afterSecond).toBe(afterFirst); // STABLE → loop terminated, not hot-spinning
  });

  it('records lastDeliveredAt on a successful immediate delivery (feeds the WI-2 heartbeat gate)', async () => {
    const client = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    expect(getLastDeliveredAt()).toBeNull();
    wakeCodexViaAppServer('entry-1', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: vi.fn(async () => ACTIVE),
      ...liveTargetDeps(client, 'th', '/s'),
      now: () => 7777,
    });
    await flush();

    expect(client.startTurn).toHaveBeenCalledWith('th', 'entry-1'); // immediate per-entry reason
    expect(getLastDeliveredAt()).toBe(7777);
  });
});

describe('gh#857 WI-2 — codex /loop-equivalent heartbeat', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  const ACTIVE = {
    cubeId: 'c',
    droneId: 'd',
    name: 'c',
    sessionToken: 't',
    droneLabel: 'd',
    apiUrl: 'https://api.example.test',
  };
  const CADENCE = 20 * 60_000;
  const idleClient = () => ({
    connect: vi.fn(async () => {}),
    loadedThreadIds: vi.fn(async () => ['th']),
    readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
    startTurn: vi.fn(async () => {}),
    close: vi.fn(),
  });
  const activeClient = () => ({
    connect: vi.fn(async () => {}),
    loadedThreadIds: vi.fn(async () => ['th']),
    readThread: vi.fn(async () => ({ id: 'th', status: { type: 'active' } })),
    startTurn: vi.fn(async () => {}),
    close: vi.fn(),
  });
  const deps = (client: any, now: number) => ({
    getActiveCube: vi.fn(async () => ACTIVE),
    hasPendingWork: vi.fn(async () => true),
    ...liveTargetDeps(client, 'th', '/s'),
    now: () => now,
  });

  it('SKIPS repeated idle cadences when the token-free preflight finds no pending work', async () => {
    const client = idleClient();
    const idleDeps = {
      ...deps(client, 100_000),
      hasPendingWork: vi.fn(async () => false),
    };

    await fireCodexHeartbeatTick(idleDeps, CADENCE);
    await fireCodexHeartbeatTick({ ...idleDeps, now: () => 100_000 + CADENCE }, CADENCE);

    expect(idleDeps.hasPendingWork).toHaveBeenCalledTimes(2);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(getLastDeliveredAt()).toBeNull();
  });

  it('fails closed without a model turn when the pending-work preflight fails', async () => {
    const client = idleClient();
    await fireCodexHeartbeatTick({
      ...deps(client, 100_000),
      hasPendingWork: vi.fn(async () => { throw new Error('preflight unavailable'); }),
    }, CADENCE);

    expect(client.connect).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it('FIRES the drain when pending work exists and no delivery landed within the cadence window', async () => {
    const client = idleClient();
    await fireCodexHeartbeatTick(deps(client, 100_000), CADENCE);
    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
    expect(getLastDeliveredAt()).toBe(100_000);
  });

  it('SKIPS when a delivery already landed within the cadence window (double-fire avoidance)', async () => {
    const c1 = idleClient();
    await fireCodexHeartbeatTick(deps(c1, 100_000), CADENCE); // delivers → lastDeliveredAt=100_000
    const c2 = idleClient();
    await fireCodexHeartbeatTick(deps(c2, 100_000 + 5 * 60_000), CADENCE); // +5min, within 20min
    expect(c2.startTurn).not.toHaveBeenCalled();
  });

  it('SKIPS (no drain, not marked delivered) when the thread is mid-turn', async () => {
    const client = activeClient();
    await fireCodexHeartbeatTick(deps(client, 100_000), CADENCE);
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(getLastDeliveredAt()).toBeNull();
  });

  it('FIRES again after a full cadence when pending work still exists', async () => {
    const c1 = idleClient();
    await fireCodexHeartbeatTick(deps(c1, 0), CADENCE); // fires @0
    const c2 = idleClient();
    await fireCodexHeartbeatTick(deps(c2, CADENCE), CADENCE); // exactly one cadence later → fires again
    expect(c2.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });

  it('startCodexHeartbeat returns null for a claude session (claude has no app-server heartbeat)', () => {
    expect(startCodexHeartbeat({ agentKind: 'claude', remoteWakeEnabled: true })).toBeNull();
  });

  it('startCodexHeartbeat schedules ticks only for a Codex CLI with remote wake transport', () => {
    vi.useFakeTimers();
    try {
      const tick = vi.fn();
      const timer = startCodexHeartbeat({
        agentKind: 'codex',
        remoteWakeEnabled: true,
        intervalMs: 1000,
        tick,
      });
      expect(timer).not.toBeNull();
      vi.advanceTimersByTime(3500);
      expect(tick).toHaveBeenCalledTimes(3);
      clearInterval(timer!);
    } finally {
      vi.useRealTimers();
    }
  });

  it('startCodexHeartbeat does not start for a Codex CLI without remote wake transport', () => {
    expect(startCodexHeartbeat({ agentKind: 'codex', remoteWakeEnabled: false })).toBeNull();
  });

  it('retains Codex 20-minute drains independently of Claude adaptive recovery', () => {
    expect(CODEX_HEARTBEAT_CADENCE_MS).toBe(20 * 60_000);
    const source = readFileSync(new URL('../src/codex-app-wake.ts', import.meta.url), 'utf8');
    expect(source).toContain('no Claude-style per-entry inbox');
    expect(source).toContain('3h ±30m');
    expect(source).toContain('15m ±3m');
    expect(source).not.toContain("Tighter than claude's");
    expect(source).not.toContain('~60-min /loop ScheduleWakeup');
  });

  it('in-flight guard: a second tick fired while the first is mid-IO is SKIPPED (no double-inject)', async () => {
    // Tick 1 stalls in connect() (simulating a slow/hung network round-trip past
    // the next interval). Tick 2 must see heartbeatInFlight and bail BEFORE its
    // own IO — otherwise both read the stale lastDeliveredAt and double-inject.
    let releaseConnect!: () => void;
    let connects = 0;
    const c1 = {
      connect: vi.fn(() => {
        connects++;
        if (connects === 1) return Promise.resolve();
        return new Promise<void>((r) => { releaseConnect = r; });
      }),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    const c2 = idleClient();
    const p1 = fireCodexHeartbeatTick(deps(c1, 100_000), CADENCE); // enters, sets flag, awaits connect (hangs)
    await new Promise((r) => setTimeout(r, 20)); // let tick 1 reach the hung connect()
    expect(c1.connect).toHaveBeenCalled(); // tick 1 is parked in IO (flag held)
    await fireCodexHeartbeatTick(deps(c2, 100_000), CADENCE); // flag set → bails immediately

    expect(c2.connect).not.toHaveBeenCalled(); // tick 2 never started its IO
    expect(c2.startTurn).not.toHaveBeenCalled();

    releaseConnect(); // let tick 1 finish
    await p1;
    expect(c1.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT); // exactly ONE drain landed
  });

  it('does NOT advance the gh#541 receipt watermark — heartbeat is synthetic, not real inbound delivery (CR 7439f931)', async () => {
    // recordEventReceipt()/last_event_received_at is BELOW-classifier evidence of
    // a REAL inbound cube event; the gh#541 invariant is it advances ONLY on
    // genuine inbound delivery, never self-generated. A time-driven heartbeat
    // recording a receipt would mask a genuinely-deaf drone. So: heartbeat updates
    // ONLY its local double-fire gate (lastDeliveredAt), NOT the receipt axis.
    const client = idleClient();
    await fireCodexHeartbeatTick(deps(client, 100_000), CADENCE);

    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT); // drain delivered
    expect(getLastDeliveredAt()).toBe(100_000); // local heartbeat-gating state updated
  });
});

describe('gh#861 — cross-path inject mutex + lease-gated + teardown-aware heartbeat', () => {
  beforeEach(() => {
    resetCodexWakeForTests();
  });

  const ACTIVE = {
    cubeId: 'c',
    droneId: 'd',
    name: 'c',
    sessionToken: 't',
    droneLabel: 'd',
    apiUrl: 'https://api.example.test',
  };
  const CADENCE = 20 * 60_000;
  const idleClient = () => ({
    connect: vi.fn(async () => {}),
    loadedThreadIds: vi.fn(async () => ['th']),
    readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
    startTurn: vi.fn(async () => {}),
    close: vi.fn(),
  });
  // Yield twice so queued microtasks (drain queue, retry loop) settle.
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('finding 1: a per-entry wake does NOT inject while the heartbeat holds the cross-path lock (defers, no double-inject)', async () => {
    let releaseHb!: () => void;
    const hbClient = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
      startTurn: vi.fn(() => new Promise<void>((r) => { releaseHb = r; })), // hangs → holds lock
      close: vi.fn(),
    };
    const p = fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        ...liveTargetDeps(hbClient, 'th', '/s'),
        now: () => 100_000,
      },
      CADENCE
    );
    await settle();
    expect(hbClient.startTurn).toHaveBeenCalledTimes(1); // heartbeat is mid-inject (lock held)

    const wakeClient = idleClient();
    wakeCodexViaAppServer('wake', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: async () => ACTIVE,
      ...liveTargetDeps(wakeClient, 'th', '/s'),
      sleep: async () => {},
      now: () => 0,
      jitter: () => 0,
      maxAttempts: 2,
    });
    await settle();
    // The per-entry wake could not acquire the cross-path lock → deferred to the
    // retry-drain (which also backs off on the held lock). No collision.
    expect(wakeClient.connect).not.toHaveBeenCalled();
    expect(wakeClient.startTurn).not.toHaveBeenCalled();

    releaseHb();
    await p;
    expect(hbClient.startTurn).toHaveBeenCalledTimes(1); // exactly ONE inject landed
  });

  it('finding 1: the heartbeat tick SKIPS while a per-entry wake holds the cross-path lock', async () => {
    let releaseWake!: () => void;
    const wakeClient = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'idle' } })),
      startTurn: vi.fn(() => new Promise<void>((r) => { releaseWake = r; })), // hangs → holds lock
      close: vi.fn(),
    };
    wakeCodexViaAppServer('w', { BORG_CODEX_REMOTE_WAKE: '1' } as any, {
      getActiveCube: async () => ACTIVE,
      ...liveTargetDeps(wakeClient, 'th', '/s'),
    });
    await settle();
    expect(wakeClient.startTurn).toHaveBeenCalledTimes(1); // per-entry wake holds the lock (hung)

    const hbClient = idleClient();
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        ...liveTargetDeps(hbClient, 'th', '/s'),
        now: () => 100_000,
      },
      CADENCE
    );
    expect(hbClient.connect).not.toHaveBeenCalled(); // bailed on the cross-path lock (no IO)
    expect(hbClient.startTurn).not.toHaveBeenCalled();

    releaseWake();
    await settle();
  });

  it('finding 2: heartbeat SKIPS when this child is NOT the stream-lease owner (lease-losing duplicate)', async () => {
    const client = idleClient();
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        ...liveTargetDeps(client, 'th', '/s'),
        now: () => 100_000,
        isStreamOwner: () => false,
      },
      CADENCE
    );
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();
  });

  it('finding 2: heartbeat FIRES when this child OWNS the stream lease', async () => {
    const client = idleClient();
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        ...liveTargetDeps(client, 'th', '/s'),
        now: () => 100_000,
        isStreamOwner: () => true,
      },
      CADENCE
    );
    expect(client.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });

  it('finding 3: heartbeat signals onAppServerSocketDead when the env socket is gone (ENOENT)', async () => {
    const enoent = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    const deadClient = {
      connect: vi.fn(async () => { throw enoent; }),
      readThread: vi.fn(),
      startTurn: vi.fn(),
      close: vi.fn(),
    };
    const onDead = vi.fn();
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        env: { BORG_CODEX_APP_SERVER_SOCKET: '/gone.sock' } as any,
        createClient: () => deadClient as any,
        now: () => 100_000,
        isStreamOwner: () => true,
        onAppServerSocketDead: onDead,
      },
      CADENCE
    );
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(deadClient.startTurn).not.toHaveBeenCalled();
  });

  it('finding 3: a TRANSIENT error (ECONNREFUSED) does NOT signal teardown', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const flakyClient = {
      connect: vi.fn(async () => { throw refused; }),
      readThread: vi.fn(),
      startTurn: vi.fn(),
      close: vi.fn(),
    };
    const onDead = vi.fn();
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        env: { BORG_CODEX_APP_SERVER_SOCKET: '/flaky.sock' } as any,
        createClient: () => flakyClient as any,
        now: () => 100_000,
        isStreamOwner: () => true,
        onAppServerSocketDead: onDead,
      },
      CADENCE
    );
    expect(onDead).not.toHaveBeenCalled();
  });

  it('finding 1: lock is released after a delivery — a later inject can proceed', async () => {
    const c1 = idleClient();
    await fireCodexHeartbeatTick(
      { getActiveCube: async () => ACTIVE, hasPendingWork: async () => true, ...liveTargetDeps(c1, 'th', '/s'), now: () => 0, isStreamOwner: () => true },
      CADENCE
    );
    expect(c1.startTurn).toHaveBeenCalledTimes(1);
    const c2 = idleClient();
    await fireCodexHeartbeatTick(
      { getActiveCube: async () => ACTIVE, hasPendingWork: async () => true, ...liveTargetDeps(c2, 'th', '/s'), now: () => CADENCE, isStreamOwner: () => true },
      CADENCE
    );
    expect(c2.startTurn).toHaveBeenCalledTimes(1); // lock was freed; second tick delivers
  });

  // gh#861 CR mutation-guard (entry 745ed879): the success-path release-after-delivery
  // test above does NOT pin release on the ERROR/SKIP exits. A mutant moving
  // releaseInjectLock() out of fireCodexHeartbeatTick's finally{} into the success
  // branch only passes all other tests but leaks injectInFlight=true forever on a
  // mid-turn skip / ENOENT / transient error → every future inject path backs off
  // permanently → cube-wide DEAF codex drone. These two tests fire a NON-success
  // tick then prove a subsequent idle tick can RE-ACQUIRE (i.e. the lock was freed
  // on the error/skip path), killing that mutant.
  it('finding 1 (mutation guard): the inject lock is RELEASED on a mid-turn SKIP — a later tick re-acquires', async () => {
    const activeClient = {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['th']),
      readThread: vi.fn(async () => ({ id: 'th', status: { type: 'active' } })),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
    await fireCodexHeartbeatTick(
      { getActiveCube: async () => ACTIVE, hasPendingWork: async () => true, ...liveTargetDeps(activeClient, 'th', '/s'), now: () => 0, isStreamOwner: () => true },
      CADENCE
    );
    expect(activeClient.startTurn).not.toHaveBeenCalled(); // mid-turn → skipped (no inject, not delivered)

    const idle = idleClient();
    await fireCodexHeartbeatTick(
      { getActiveCube: async () => ACTIVE, hasPendingWork: async () => true, ...liveTargetDeps(idle, 'th', '/s'), now: () => CADENCE, isStreamOwner: () => true },
      CADENCE
    );
    // If the lock leaked on the mid-turn skip, this tick would early-return at
    // tryAcquireInjectLock() and startTurn would NOT fire. It does → lock freed.
    expect(idle.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });

  it('finding 1 (mutation guard): the inject lock is RELEASED on an ENOENT error — a later tick re-acquires', async () => {
    const enoent = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    const deadClient = {
      connect: vi.fn(async () => { throw enoent; }),
      readThread: vi.fn(),
      startTurn: vi.fn(),
      close: vi.fn(),
    };
    await fireCodexHeartbeatTick(
      {
        getActiveCube: async () => ACTIVE,
        hasPendingWork: async () => true,
        env: { BORG_CODEX_APP_SERVER_SOCKET: '/gone.sock' } as any,
        createClient: () => deadClient as any,
        now: () => 0,
        isStreamOwner: () => true,
        onAppServerSocketDead: vi.fn(),
      },
      CADENCE
    );
    expect(deadClient.startTurn).not.toHaveBeenCalled(); // errored before any inject

    const idle = idleClient();
    await fireCodexHeartbeatTick(
      { getActiveCube: async () => ACTIVE, hasPendingWork: async () => true, ...liveTargetDeps(idle, 'th', '/s'), now: () => CADENCE, isStreamOwner: () => true },
      CADENCE
    );
    // If the lock leaked on the error path, this tick would early-return → no inject.
    expect(idle.startTurn).toHaveBeenCalledWith('th', CODEX_CATCHUP_PROMPT);
  });
});
