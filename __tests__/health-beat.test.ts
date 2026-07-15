/**
 * Tests for gh#541 WU-2 — client health beat (the Part B producer).
 *
 * The MCP-client child emits a health beat to POST /api/drone/health, below
 * the agent classifier (WU-0-confirmed: child-process HTTP is independent of
 * the agent tool-call path). The beat carries
 *   { sse_connected, inbox_monitor_armed, agent_kind, hostname, version, last_event_at }
 * — NO token material in the body (auth is the X-Drone-Session header). It is
 * best-effort: a failed POST must NEVER crash the stream.
 *
 * fetch + token + clock + cube/status/monitor probes are injected so the whole
 * producer is unit-tested without real network, keychain, or pgrep.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordEventReceipt,
  getLastEventReceivedAt,
  buildHealthPayload,
  postHealthBeat,
  emitHealthBeat,
  runHealthBeatOnce,
  startHealthBeatTick,
  getCachedMonitorHealthy,
  getCachedWakeArmed,
  __resetHealthBeatStateForTest,
  type HealthBeatActive,
} from '../src/health-beat.js';

const ACTIVE: HealthBeatActive = {
  cubeId: 'cube-1',
  droneId: 'drone-1',
  sessionToken: 'sess-tok-xyz',
  apiUrl: 'https://api.borgmcp.ai',
};

beforeEach(() => {
  __resetHealthBeatStateForTest();
});

describe('recordEventReceipt / getLastEventReceivedAt (gh#541 WU-2)', () => {
  it('starts null and records the receipt timestamp', () => {
    expect(getLastEventReceivedAt()).toBeNull();
    const t = new Date('2026-06-03T08:00:00.000Z');
    recordEventReceipt(t);
    expect(getLastEventReceivedAt()).toEqual(t);
  });
});

describe('buildHealthPayload (gh#541 WU-2 + gh#633 + gh#634 + gh#646)', () => {
  it('maps a recorded receipt to an ISO last_event_at; null when none', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').last_event_at).toBeNull();
    recordEventReceipt(new Date('2026-06-03T08:05:00.000Z'));
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').last_event_at).toBe('2026-06-03T08:05:00.000Z');
  });

  it('passes sse_connected through', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').sse_connected).toBe(true);
    expect(buildHealthPayload(false, true, true, 'claude', 'host-a', '0.9.67').sse_connected).toBe(false);
  });

  it('inbox_monitor_armed: healthy=true → true, positively-broken=false → false', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').inbox_monitor_armed).toBe(true);
    expect(buildHealthPayload(true, false, true, 'claude', 'host-a', '0.9.67').inbox_monitor_armed).toBe(false);
  });

  it('inbox_monitor_armed: unknown (null) → true (only POSITIVELY-broken reports false; avoids false-deaf)', () => {
    expect(buildHealthPayload(true, null, true, 'claude', 'host-a', '0.9.67').inbox_monitor_armed).toBe(true);
  });

  it('gh#633 wake_armed: healthy=true → true, positively-dead=false → false, unknown(null) → true (same false-deaf-avoidance map as inbox_monitor_armed)', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').wake_armed).toBe(true);
    expect(buildHealthPayload(true, true, false, 'claude', 'host-a', '0.9.67').wake_armed).toBe(false);
    expect(buildHealthPayload(true, true, null, 'claude', 'host-a', '0.9.67').wake_armed).toBe(true);
  });

  it('gh#633 wake_armed is INDEPENDENT of inbox_monitor_armed (codex: no tail-F Monitor but live bridge)', () => {
    const payload = buildHealthPayload(true, false, true, 'codex', 'host-a', '0.9.67');
    expect(payload.inbox_monitor_armed).toBe(false);
    expect(payload.wake_armed).toBe(true);
  });

  it('gh#634 agent_kind: passes the runtime kind through verbatim', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').agent_kind).toBe('claude');
    expect(buildHealthPayload(true, true, true, 'codex', 'host-a', '0.9.67').agent_kind).toBe('codex');
  });

  it('gh#408 hostname: passes the caller-computed hostname through verbatim', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'MacBook.local', '0.9.67').hostname).toBe('MacBook.local');
    expect(buildHealthPayload(true, true, true, 'claude', null, '0.9.67').hostname).toBeNull();
  });

  it('gh#646 version: passes the installed package version through verbatim', () => {
    expect(buildHealthPayload(true, true, true, 'claude', 'host-a', '0.9.67').version).toBe('0.9.67');
  });

  it('carries ONLY health fields — no token material', () => {
    recordEventReceipt(new Date('2026-06-03T08:05:00.000Z'));
    const payload = buildHealthPayload(true, true, true, 'codex', 'host-a', '0.9.67');
    expect(Object.keys(payload).sort()).toEqual([
      'agent_kind',
      'hostname',
      'inbox_monitor_armed',
      'last_event_at',
      'sse_connected',
      'version',
      'wake_armed',
    ]);
    expect(JSON.stringify(payload)).not.toContain(ACTIVE.sessionToken);
  });
});

describe('postHealthBeat (gh#541 WU-2)', () => {
  it('POSTs to /api/drone/health with Bearer + X-Drone-Session + JSON body', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const payload = {
      sse_connected: true,
      inbox_monitor_armed: true,
      wake_armed: true,
      agent_kind: 'claude' as const,
      hostname: 'host-a',
      version: '0.9.67',
      last_event_at: null,
    };
    await postHealthBeat(ACTIVE, payload, { fetchImpl, getToken: async () => 'id-token-abc' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.borgmcp.ai/api/drone/health');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['Authorization']).toBe('Bearer id-token-abc');
    expect(calls[0].init.headers['X-Drone-Session']).toBe('sess-tok-xyz');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual(payload);
  });

  it('is best-effort: a thrown fetch does NOT reject (never crashes the stream)', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      postHealthBeat(
        ACTIVE,
        {
          sse_connected: true,
          inbox_monitor_armed: true,
          wake_armed: true,
          agent_kind: 'claude',
          hostname: 'host-a',
          version: '0.9.67',
          last_event_at: null,
        },
        {
          fetchImpl,
          getToken: async () => 't',
        }
      )
    ).resolves.toBeUndefined();
  });

  it('is best-effort: a throwing getToken does NOT reject', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await expect(
      postHealthBeat(
        ACTIVE,
        {
          sse_connected: true,
          inbox_monitor_armed: true,
          wake_armed: true,
          agent_kind: 'claude',
          hostname: 'host-a',
          version: '0.9.67',
          last_event_at: null,
        },
        {
          fetchImpl,
          getToken: async () => {
            throw new Error('keychain locked');
          },
        }
      )
    ).resolves.toBeUndefined();
  });
});

describe('emitHealthBeat (gh#541 WU-2)', () => {
  it('builds from current state + POSTs the beat', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    recordEventReceipt(new Date('2026-06-03T08:09:00.000Z'));
    await emitHealthBeat(ACTIVE, {
      sseConnected: true,
      inboxMonitorHealthy: false,
      wakeArmed: true,
      agentKind: 'codex',
      hostname: 'host-a',
      version: '0.9.67',
      fetchImpl,
      getToken: async () => 't',
    });
    expect(calls[0]).toEqual({
      sse_connected: true,
      inbox_monitor_armed: false,
      wake_armed: true,
      agent_kind: 'codex',
      hostname: 'host-a',
      version: '0.9.67',
      last_event_at: '2026-06-03T08:09:00.000Z',
    });
  });

  it('does not send the hosted health route for a local server cube', async () => {
    const fetchImpl = vi.fn();
    const getToken = vi.fn(async () => 'cloud-token');
    await emitHealthBeat({
      ...ACTIVE,
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
    }, {
      sseConnected: true,
      inboxMonitorHealthy: true,
      wakeArmed: true,
      agentKind: 'codex',
      hostname: 'host-a',
      version: '1.1.15',
      fetchImpl: fetchImpl as typeof fetch,
      getToken,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it('does not let a noncanonical endpoint without trust obtain Cloud auth', async () => {
    const fetchImpl = vi.fn();
    const getToken = vi.fn(async () => 'cloud-token');
    await emitHealthBeat({
      ...ACTIVE,
      apiUrl: 'https://127.0.0.1:7091',
      // Deliberately removed: serverTrustIdentity.
    }, {
      sseConnected: true,
      inboxMonitorHealthy: true,
      wakeArmed: true,
      agentKind: 'codex',
      hostname: 'host-a',
      version: '1.1.15',
      fetchImpl: fetchImpl as typeof fetch,
      getToken,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });
});

describe('runHealthBeatOnce (gh#541 WU-2 — the ~60s tick body)', () => {
  function deps(overrides: Partial<any> = {}) {
    const calls: any[] = [];
    return {
      calls,
      d: {
        getActiveCube: async () => ACTIVE,
        getStreamConnected: () => true,
        getInboxPath: (_a: HealthBeatActive) => '/inbox/drone-1.log',
        checkMonitor: (_p: string | null) => true as boolean | null,
        isCodexRemoteWake: () => false,
        probeBridgeArmed: async (_a: HealthBeatActive) => null as boolean | null,
        resolveAgentKind: () => 'claude' as 'claude' | 'codex' | 'opencode',
        resolveHostname: () => 'host-a',
        resolveVersion: () => '0.9.67',
        getToken: async () => 't',
        fetchImpl: (async (_url: any, init: any) => {
          calls.push(JSON.parse(init.body));
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
        ...overrides,
      },
    };
  }

  it('emits a beat with the live connected + monitor state', async () => {
    const { calls, d } = deps();
    await runHealthBeatOnce(d);
    expect(calls).toHaveLength(1);
    expect(calls[0].sse_connected).toBe(true);
    expect(calls[0].inbox_monitor_armed).toBe(true);
  });

  it('caches the monitor-health result (for cheap per-event beats — no pgrep per event)', async () => {
    const { d } = deps({ checkMonitor: () => false });
    await runHealthBeatOnce(d);
    expect(getCachedMonitorHealthy()).toBe(false);
  });

  it('gh#633 claude (not codex remote-wake): wake_armed mirrors the monitor probe', async () => {
    const { calls, d } = deps({ isCodexRemoteWake: () => false, checkMonitor: () => false });
    await runHealthBeatOnce(d);
    expect(calls[0].inbox_monitor_armed).toBe(false);
    expect(calls[0].wake_armed).toBe(false);
    expect(getCachedWakeArmed()).toBe(false);
  });

  it('gh#633 codex remote-wake: wake_armed comes from the BRIDGE probe, NOT the monitor', async () => {
    // The corrosive case: codex has no tail-F Monitor (monitor=false) but a live
    // bridge (probe=true) → must NOT be flagged. monitor_armed stays false (the
    // claude diagnostic); wake_armed=true is what HOP-2 now reads.
    const { calls, d } = deps({
      resolveAgentKind: () => 'codex' as const,
      isCodexRemoteWake: () => true,
      checkMonitor: () => false,
      probeBridgeArmed: async () => true,
    });
    await runHealthBeatOnce(d);
    expect(calls[0].inbox_monitor_armed).toBe(false);
    expect(calls[0].wake_armed).toBe(true);
    expect(getCachedWakeArmed()).toBe(true);
  });

  it('gh#633 codex with a DEAD bridge: wake_armed false (preserves real-deaf detection)', async () => {
    const { calls, d } = deps({
      resolveAgentKind: () => 'codex' as const,
      isCodexRemoteWake: () => true,
      checkMonitor: () => false,
      probeBridgeArmed: async () => false,
    });
    await runHealthBeatOnce(d);
    expect(calls[0].wake_armed).toBe(false);
    expect(getCachedWakeArmed()).toBe(false);
  });

  it('gh#633 codex with INDETERMINATE bridge (null): wake_armed true (false-deaf-avoidance)', async () => {
    const { calls, d } = deps({
      resolveAgentKind: () => 'codex' as const,
      isCodexRemoteWake: () => true,
      checkMonitor: () => false,
      probeBridgeArmed: async () => null,
    });
    await runHealthBeatOnce(d);
    expect(calls[0].wake_armed).toBe(true);
  });

  it('gh#634: beats the live runtime agent_kind from resolveAgentKind', async () => {
    const { calls, d } = deps({ resolveAgentKind: () => 'codex' as 'claude' | 'codex' | 'opencode' });
    await runHealthBeatOnce(d);
    expect(calls[0].agent_kind).toBe('codex');
  });

  it('reports a Codex CLI with no remote transport as unarmed instead of borrowing Claude monitor state', async () => {
    const probeBridgeArmed = vi.fn(async () => true);
    const { calls, d } = deps({
      resolveAgentKind: () => 'codex' as const,
      isCodexRemoteWake: () => false,
      checkMonitor: () => true,
      probeBridgeArmed,
    });
    await runHealthBeatOnce(d);
    expect(calls[0].agent_kind).toBe('codex');
    expect(calls[0].wake_armed).toBe(false);
    expect(probeBridgeArmed).not.toHaveBeenCalled();
  });

  it('gh#408: beats the live runtime hostname from resolveHostname', async () => {
    const { calls, d } = deps({ resolveHostname: () => 'Mac-Studio.local' });
    await runHealthBeatOnce(d);
    expect(calls[0].hostname).toBe('Mac-Studio.local');
  });

  it('gh#646: beats the installed version from resolveVersion', async () => {
    const { calls, d } = deps({ resolveVersion: () => '0.9.68' });
    await runHealthBeatOnce(d);
    expect(calls[0].version).toBe('0.9.68');
  });

  it('does nothing (no beat) when there is no active cube', async () => {
    const { calls, d } = deps({ getActiveCube: async () => null });
    await runHealthBeatOnce(d);
    expect(calls).toHaveLength(0);
  });

  it('never throws even if the probe throws (best-effort tick)', async () => {
    const { d } = deps({
      getActiveCube: async () => {
        throw new Error('probe blew up');
      },
    });
    await expect(runHealthBeatOnce(d)).resolves.toBeUndefined();
  });
});

describe('startHealthBeatTick', () => {
  it('emits an immediate startup beat so a relaunch does not wait for the 60s cadence', async () => {
    const calls: any[] = [];
    const d = {
      getActiveCube: async () => ACTIVE,
      getStreamConnected: () => true,
      getInboxPath: () => '/inbox/drone-1.log',
      checkMonitor: () => true as boolean | null,
      isCodexRemoteWake: () => false,
      probeBridgeArmed: async () => null as boolean | null,
      resolveAgentKind: () => 'codex' as const,
      resolveHostname: () => 'host-a',
      resolveVersion: () => '0.9.67',
      getToken: async () => 't',
      fetchImpl: (async (_url: any, init: any) => {
        calls.push(JSON.parse(init.body));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    };
    const timer = startHealthBeatTick(d, 60_000);
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0].agent_kind).toBe('codex');
    } finally {
      clearInterval(timer);
    }
  });
});
