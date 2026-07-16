/**
 * gh#866 items 1+2+3 — codex heartbeat PRODUCTION-WIRING + runLoop lifecycle +
 * mid-session ENOENT self-heal.
 *
 * The existing codex-app-wake suite exercises `fireCodexHeartbeatTick` with
 * HAND-PASSED deps (codex-app-wake.test.ts ~:804) — it proves the tick LOGIC
 * but NOT that log-stream.ts's production path actually wires those deps. And
 * runLoop's heartbeat teardown/re-arm seams (log-stream.ts) had NO lifecycle
 * test because every suite suppresses runLoop (`startLogStream({runForever})`).
 *
 * Item 1: drive the REAL `defaultStartCodexHeartbeat` (reached as the default
 *   arg of `ensureCodexHeartbeatStarted`) and assert it reaches
 *   `fireCodexHeartbeatTick` via the production wire, with both gh#861 gates
 *   wired (`isStreamOwner` reads streamState ownership; `onAppServerSocketDead`
 *   is the ENOENT teardown handler).
 * Item 2: drive ONE bounded runLoop iteration (via `__runLoopForTest`) down each
 *   branch and assert the heartbeat is torn down on a cleared cube / re-armed on
 *   an active cube.
 * Item 3: a mid-session ENOENT teardown schedules a one-shot deferred re-arm so a
 *   transient app-server restart self-heals within the session (the runLoop-top
 *   re-arm is unreachable while `streamOnce` holds the connected session); a
 *   cube-cleared teardown does NOT (runLoop re-arms on cube return).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Intercept the codex-app-wake boundary so we can (a) capture the `tick`
// log-stream's defaultStartCodexHeartbeat hands to startCodexHeartbeat, and
// (b) capture the gate object that tick passes to fireCodexHeartbeatTick. Real
// exports are preserved; only these two are spy-wrapped. vi.mock is hoisted, so
// the spies come from vi.hoisted.
const { startSpy, fireSpy } = vi.hoisted(() => ({
  startSpy: vi.fn(),
  fireSpy: vi.fn(),
}));
vi.mock('../src/codex-app-wake', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/codex-app-wake')>();
  return {
    ...actual,
    startCodexHeartbeat: (cfg: unknown) => startSpy(cfg),
    fireCodexHeartbeatTick: (...args: unknown[]) => fireSpy(...args),
  };
});

import {
  ensureCodexHeartbeatStarted,
  __resetCodexHeartbeatForTest,
  __resetStreamStateForTest,
  __setCodexReArmDelayForTest,
  getStreamStatus,
  __runLoopForTest,
} from '../src/log-stream';

const ACTIVE = {
  cubeId: 'cube-1',
  droneId: 'drone-1',
  sessionToken: 'token-1',
  apiUrl: 'https://test.example.com',
};

// A throwaway timer the guard can store as "armed" (startCodexHeartbeat's real
// return is a NodeJS.Timeout for a codex session; the mock stands in for it).
function fakeTimer(): ReturnType<typeof setInterval> {
  return setInterval(() => {}, 1_000_000);
}

describe('gh#866 item 1 — defaultStartCodexHeartbeat production wiring', () => {
  beforeEach(() => {
    __resetCodexHeartbeatForTest();
    __resetStreamStateForTest();
    startSpy.mockReset();
    fireSpy.mockReset();
  });
  afterEach(() => __resetCodexHeartbeatForTest());

  it('reaches fireCodexHeartbeatTick via the REAL wire with both gh#861 gates wired', () => {
    const timer = fakeTimer();
    startSpy.mockReturnValue(timer);

    // No injected `start` → ensureCodexHeartbeatStarted runs the REAL
    // defaultStartCodexHeartbeat (the production wiring under test).
    ensureCodexHeartbeatStarted();

    // defaultStartCodexHeartbeat must have called startCodexHeartbeat with a tick.
    expect(startSpy).toHaveBeenCalledTimes(1);
    const cfg = startSpy.mock.calls[0][0] as { tick: () => void };
    expect(typeof cfg.tick).toBe('function');

    // fireCodexHeartbeatTick is NOT reached until the tick actually runs (this is
    // the production wire — not a hand-passed call).
    expect(fireSpy).not.toHaveBeenCalled();
    cfg.tick();

    expect(fireSpy).toHaveBeenCalledTimes(1);
    const gates = fireSpy.mock.calls[0][0] as {
      isStreamOwner: () => boolean;
      onAppServerSocketDead: () => void;
    };
    expect(typeof gates.isStreamOwner).toBe('function');
    // gh#866 item 3: the teardown gate is the ENOENT handler (tears down AND
    // schedules a deferred re-arm). Its behavior — not its identity — is pinned by
    // the dedicated re-arm lifecycle test below.
    expect(typeof gates.onAppServerSocketDead).toBe('function');

    // gh#861 finding 2: isStreamOwner reads the LIVE streamState ownership, not a
    // constant — it tracks getStreamStatus(). (Unowned is the only state drivable
    // without an ownership write seam; the 'owner'→true branch is covered by the
    // codex-app-wake suite's hand-passed isStreamOwner cases.)
    const ownedView = getStreamStatus().ownership?.state === 'owner';
    expect(gates.isStreamOwner()).toBe(ownedView);
    expect(gates.isStreamOwner()).toBe(false);

    clearInterval(timer);
  });
});

describe('gh#866 item 2 — runLoop heartbeat teardown / re-arm lifecycle', () => {
  beforeEach(() => {
    __resetCodexHeartbeatForTest();
    __resetStreamStateForTest();
    startSpy.mockReset();
    fireSpy.mockReset();
    startSpy.mockImplementation(() => fakeTimer());
  });
  afterEach(() => __resetCodexHeartbeatForTest());

  it('tears down the heartbeat when an iteration sees NO active cube (log-stream.ts:354)', async () => {
    // Pre-arm the heartbeat so the teardown has something to clear.
    ensureCodexHeartbeatStarted();
    // Sanity: armed → a follow-up ensure(spy) is a no-op (guard non-empty).
    const preSpy = vi.fn(() => null);
    ensureCodexHeartbeatStarted(preSpy);
    expect(preSpy).not.toHaveBeenCalled();

    // One iteration, no active cube → the `!active` branch runs stopCodexHeartbeat.
    await __runLoopForTest({
      getActiveCube: async () => null,
      sleep: async () => {},
      maxIterations: 1,
    });

    // Torn down → the guard is now empty, so a fresh ensure(spy) FIRES.
    const postSpy = vi.fn(() => null);
    ensureCodexHeartbeatStarted(postSpy);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('re-arms the heartbeat when an iteration sees an active cube (log-stream.ts:362)', async () => {
    // Start torn-down: prove runLoop itself re-arms.
    __resetCodexHeartbeatForTest();

    // Active cube → re-arm (line 362) runs BEFORE lease acquisition. Inject an
    // acquireStreamLease that rejects to exit the iteration immediately after the
    // re-arm seam, with no ownership/streamOnce IO. The rejection escapes runLoop
    // (lease acquisition sits outside its try/catch); swallow only that sentinel.
    const sentinel = new Error('gh866-stop-after-rearm');
    await __runLoopForTest({
      getActiveCube: async () => ({
        ...ACTIVE,
        cubeId: '11111111-1111-4111-8111-111111111111',
        droneId: '22222222-2222-4222-8222-222222222222',
      }),
      acquireStreamLease: async () => {
        throw sentinel;
      },
      sleep: async () => {},
      maxIterations: 1,
    }).catch((e) => {
      if (e !== sentinel) throw e;
    });

    // Re-armed via the production wire: startCodexHeartbeat fired (through the
    // real defaultStartCodexHeartbeat), and a follow-up ensure(spy) is a no-op.
    expect(startSpy).toHaveBeenCalled();
    const postSpy = vi.fn(() => null);
    ensureCodexHeartbeatStarted(postSpy);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('releases stream ownership when the run loop exits', async () => {
    const release = vi.fn(async () => {});
    const refresh = vi.fn(async () => true);
    const acquire = vi.fn(async () => ({
      lockPath: '/tmp/borg-stream-owner-test',
      record: {
        schemaVersion: 1,
        pid: process.pid,
        processNonce: 'run-loop-test',
        cwd: process.cwd(),
        startedAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      },
      refresh,
      release,
    }));

    await __runLoopForTest({
      getActiveCube: async () => ({
        ...ACTIVE,
        cubeId: '11111111-1111-4111-8111-111111111111',
        droneId: '22222222-2222-4222-8222-222222222222',
      }),
      acquireStreamLease: acquire,
      streamOnce: async () => {},
      sleep: async () => {},
      maxIterations: 1,
    });

    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      70_000,
      { isPidAlive: expect.any(Function) },
    );
  });
});

describe('gh#866 item 3 — mid-session ENOENT teardown schedules a deferred re-arm', () => {
  beforeEach(() => {
    __resetCodexHeartbeatForTest();
    __resetStreamStateForTest();
    startSpy.mockReset();
    fireSpy.mockReset();
    startSpy.mockImplementation(() => fakeTimer());
  });
  afterEach(() => __resetCodexHeartbeatForTest());

  // Reach the REAL onAppServerSocketDead handler the production wire installs:
  // arm via the default wiring, run the captured tick to capture the gate object.
  function captureGates(): { onAppServerSocketDead: () => void } {
    ensureCodexHeartbeatStarted();
    const cfg = startSpy.mock.calls[0][0] as { tick: () => void };
    cfg.tick();
    return fireSpy.mock.calls[0][0] as { onAppServerSocketDead: () => void };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met in time');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it('an ENOENT teardown tears the timer down AND re-arms after the deferred delay (closes the mid-session deaf gap)', async () => {
    __setCodexReArmDelayForTest(5); // 5ms instead of the 20-min cadence

    const gates = captureGates();
    expect(startSpy).toHaveBeenCalledTimes(1); // armed once

    // Simulate the tick finding the app-server socket positively dead (ENOENT).
    gates.onAppServerSocketDead();
    // Synchronously after teardown the re-arm has NOT fired yet (it is deferred).
    expect(startSpy).toHaveBeenCalledTimes(1);

    // After the deferred delay, the one-shot re-arm fires → heartbeat restarted
    // via the production wire (startCodexHeartbeat called a 2nd time). This is the
    // self-heal that runLoop-top cannot provide while streamOnce holds the session.
    await waitFor(() => startSpy.mock.calls.length >= 2);
    expect(startSpy).toHaveBeenCalledTimes(2);
  });

  it('a cube-cleared runLoop teardown does NOT schedule a re-arm (only ENOENT self-heals)', async () => {
    __setCodexReArmDelayForTest(5);

    // Arm, then drive ONE runLoop iteration with no active cube → cube-cleared
    // teardown calls stopCodexHeartbeat directly, NOT the ENOENT handler.
    ensureCodexHeartbeatStarted();
    expect(startSpy).toHaveBeenCalledTimes(1);
    await __runLoopForTest({
      getActiveCube: async () => null,
      sleep: async () => {},
      maxIterations: 1,
    });

    // Wait past the deferred-delay window: no re-arm timer was queued, so
    // startCodexHeartbeat is NOT called again (runLoop, not a timer, re-arms on
    // cube return).
    await new Promise((r) => setTimeout(r, 40));
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
