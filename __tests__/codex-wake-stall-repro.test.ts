import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  wakeCodexViaAppServer,
  probeCodexBridgeArmed,
  resetCodexWakeForTests,
  CODEX_WAKE_PROMPT,
  CODEX_CATCHUP_PROMPT,
} from '../src/codex-app-wake';

// client#89 — instrumented reproduction of the Codex wake-injection stall.
//
// The failure boundary: a directed activity-log entry is dispatched to a
// Codex seat whose thread is mid-turn ("active"). The per-entry wake cannot
// land, so it is deferred to the coalesced retry-drain, which re-defers on
// every poll while the thread stays active (backoff 5s→60s, up to the 45-min
// age cap; the 20-min heartbeat is the only backstop past that). Throughout
// that whole window the entry is undelivered — yet probeCodexBridgeArmed, the
// sole input to the Codex wake-path health surface
// (inspectWakePath → stream-status.inbox_monitor_healthy), still reports the
// path ARMED because it only checks "target resolves + app-server socket
// alive". SSE health is never the discriminator.
//
// These probes drive the REAL wake code path with an injected transport (the
// module's own DI seams). A full OS-process reproduction (a live codex
// app-server with a genuinely mid-turn thread) is #43's multi-seat harness;
// stated as an unexercised boundary.

const ACTIVE = {
  cubeId: 'cube', droneId: 'drone', name: 'cube',
  sessionToken: 'token', droneLabel: 'drone', apiUrl: 'https://api.example.test',
};
const TARGET = { threadId: 'thread-123', socketPath: '/tmp/codex.sock', updatedAt: '2026-05-28T10:00:00.000Z' };
const WAKE_ENV = { BORG_CODEX_REMOTE_WAKE: '1' } as any;

function midTurnClient() {
  return {
    connect: vi.fn(async () => {}),
    readThread: vi.fn(async () => ({ id: 'thread-123', cwd: '/repo', preview: 'p', status: { type: 'active' }, updatedAt: 1 })),
    startTurn: vi.fn(async () => {}),
    loadedThreadIds: vi.fn(async () => ['thread-123']),
    close: vi.fn(),
  };
}

/** Deps that drive the deferred/retry path deterministically: no real sleep,
 *  an advancing clock so the age cap trips, and a small attempt ceiling so the
 *  retry-drain loop terminates in-test rather than polling for 45 minutes. */
function deferDeps(client: ReturnType<typeof midTurnClient>) {
  let clock = 0;
  return {
    getActiveCube: vi.fn(async () => ACTIVE),
    getCodexWakeTarget: vi.fn(async () => TARGET),
    createClient: vi.fn(() => client),
    hasPendingEntry: vi.fn(async () => true), // the entry stays unread → the stall
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => (clock += 60_000)),
    jitter: () => 0,
    maxAttempts: 5,
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('client#89 Codex wake-injection stall', () => {
  beforeEach(() => { resetCodexWakeForTests(); });
  afterEach(() => { resetCodexWakeForTests(); vi.restoreAllMocks(); });

  it('leaves a directed entry undelivered while the health probe still reports the path armed', async () => {
    const client = midTurnClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deferDeps(client), 'delivery-1', 'entry-1');
    await flush();

    // The stall: the mid-turn thread was read, but no turn (wake or catch-up
    // drain) was ever injected — the directed entry remains undelivered.
    expect(client.readThread).toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();

    // The confirmed defect: during that exact undelivered window the wake-path
    // health probe reports the Codex bridge ARMED (target resolves + socket
    // healthy), so inbox_monitor_healthy would read healthy for a seat that is
    // provably not receiving its wakes.
    const armed = await probeCodexBridgeArmed(
      { cubeId: ACTIVE.cubeId, droneId: ACTIVE.droneId },
      { getCodexWakeTarget: vi.fn(async () => TARGET), checkBridge: () => true },
    );
    expect(armed).toBe(true);
  });

  it('the health probe cannot see the deferred-delivery / retry-drain backlog (diagnostics gap)', async () => {
    // probeCodexBridgeArmed's inputs are only the wake target and the socket
    // health — it has no parameter for, and never consults, whether a wake is
    // currently deferred, retrying, or aged-out. So the two calls below are
    // identical whether or not an entry is stalled: the diagnostic surface
    // cannot distinguish "armed and delivering" from "armed but stalled".
    const idle = await probeCodexBridgeArmed(
      { cubeId: ACTIVE.cubeId, droneId: ACTIVE.droneId },
      { getCodexWakeTarget: vi.fn(async () => TARGET), checkBridge: () => true },
    );
    const client = midTurnClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deferDeps(client), 'delivery-2', 'entry-2');
    await flush();
    const stalled = await probeCodexBridgeArmed(
      { cubeId: ACTIVE.cubeId, droneId: ACTIVE.droneId },
      { getCodexWakeTarget: vi.fn(async () => TARGET), checkBridge: () => true },
    );
    expect(idle).toBe(stalled); // both true — the stall is invisible to the probe
  });

  it('recovery preserves exactly-once: once the thread goes idle the drain delivers a single catch-up turn', async () => {
    // Positive control on the recovery leg — the wake is not lost, and the
    // server-read-cursor catch-up drain delivers exactly one turn when the
    // thread becomes reachable+idle.
    let status: { type: string } = { type: 'active' };
    const client = {
      connect: vi.fn(async () => {}),
      readThread: vi.fn(async () => ({ id: 'thread-123', cwd: '/repo', preview: 'p', status, updatedAt: 1 })),
      startTurn: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => ['thread-123']),
      close: vi.fn(),
    };
    const deps = {
      getActiveCube: vi.fn(async () => ACTIVE),
      getCodexWakeTarget: vi.fn(async () => TARGET),
      createClient: vi.fn(() => client),
      hasPendingEntry: vi.fn(async () => true),
      sleep: vi.fn(async () => { status = { type: 'idle' }; }), // thread frees between polls
      now: vi.fn((() => { let c = 0; return () => (c += 1000); })()),
      jitter: () => 0,
      maxAttempts: 10,
    };
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deps, 'delivery-3', 'entry-3');
    await flush();
    // Exactly one catch-up drain turn was injected — not duplicated across the
    // per-entry wake and the retry-drain.
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('thread-123', CODEX_CATCHUP_PROMPT);
  });
});
