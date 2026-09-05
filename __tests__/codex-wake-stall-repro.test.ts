import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  wakeCodexViaAppServer,
  fireCodexHeartbeatTick,
  probeCodexBridgeArmed,
  getCodexDeliveryState,
  codexWakePathHealthy,
  resetCodexWakeForTests,
  CODEX_WAKE_PROMPT,
  CODEX_CATCHUP_PROMPT,
} from '../src/codex-app-wake';
import { inspectWakePath } from '../src/wake-path-health';

// client#89 — reproduction + fix verification for the Codex wake-injection
// stall diagnostic defect.
//
// The failure boundary: a directed activity-log entry dispatched to a Codex
// seat whose thread is mid-turn ('active') is deferred to the coalesced
// retry-drain, which re-defers on every poll while the thread stays active
// (backoff 5s→60s to the 45-min age cap; the 20-min heartbeat is the only
// backstop past that) — matching the reported 14-40 min stall.
//
// BEFORE the fix, the wake-path health surface reported this ARMED/HEALTHY
// because probeCodexBridgeArmed only checks "target resolves + socket alive".
// AFTER the fix, inspectWakePath folds the delivery state, so a deferred /
// retrying / failed injection reads DEGRADED (null), never healthy — while
// delivery still catches up (exactly-once) when the thread frees.
//
// These probes drive the REAL wake code path with an injected transport (the
// module's own DI seams). A full OS-process reproduction (a live codex
// app-server with a genuinely mid-turn thread) is #43's multi-seat harness.

const ACTIVE = {
  cubeId: 'cube', droneId: 'drone', name: 'cube',
  sessionToken: 'token', droneLabel: 'drone', apiUrl: 'https://api.example.test',
};
const WAKE_ENV = {
  BORG_CODEX_REMOTE_WAKE: '1',
  BORG_CODEX_APP_SERVER_SOCKET: '/tmp/codex.sock',
} as any;

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
    env: WAKE_ENV,
    createClient: vi.fn(() => client),
    hasPendingEntry: vi.fn(async () => true), // the entry stays unread → the stall
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => (clock += 60_000)),
    jitter: () => 0,
    maxAttempts: 5,
  };
}

// Inspect the REAL health surface: bridge armed (injected true), delivery state
// read live from the module the wake path just mutated.
const inspectCodex = () => inspectWakePath(
  { agentKind: 'codex', active: { cubeId: ACTIVE.cubeId, droneId: ACTIVE.droneId }, inboxPath: null, monitorStateRoot: null },
  { probeCodex: vi.fn(async () => true) },
);

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

describe('client#89 Codex wake-injection stall diagnostics', () => {
  beforeEach(() => { resetCodexWakeForTests(); });
  afterEach(() => { resetCodexWakeForTests(); vi.restoreAllMocks(); });

  it('reports the wake path DEGRADED (not healthy) while a directed entry is deferred, though the bridge stays armed', async () => {
    const client = midTurnClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deferDeps(client), 'delivery-1', 'entry-1');
    await flush();

    // The stall: the mid-turn thread was read, but no turn (wake or catch-up
    // drain) was ever injected — the directed entry remains undelivered.
    expect(client.readThread).toHaveBeenCalled();
    expect(client.startTurn).not.toHaveBeenCalled();

    // The raw bridge probe is still ARMED (target resolves + socket alive) —
    // this is what the pre-fix health surface returned verbatim.
    const armed = await probeCodexBridgeArmed(
      { cubeId: ACTIVE.cubeId, droneId: ACTIVE.droneId },
      { env: WAKE_ENV, socketExists: () => true, checkBridge: () => true },
    );
    expect(armed).toBe(true);

    // FIX: the health surface now folds the delivery state → DEGRADED (null),
    // never healthy, for a seat that is provably not receiving its wakes.
    const snap = await inspectCodex();
    expect(snap.healthy).toBe(null);
    expect(snap.healthy).not.toBe(true);
  });

  it('surfaces the selected target, deferred-queue state, and last injection result (no secrets)', async () => {
    const client = midTurnClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deferDeps(client), 'delivery-2', 'entry-2');
    await flush();

    const d = getCodexDeliveryState();
    expect(d.lastTargetThreadId).toBe('thread-123'); // opaque id, not a socket path
    expect(d.lastInjectionResult).toBe('deferred'); // historical reporting
    // A LIVE degraded signal is set (once the retry-drain ages out it hands off
    // from deferredEntryCount to the deliveryDeferred marker — either is live).
    expect(d.deliveryDeferred || d.deferredEntryCount > 0).toBe(true);
    // The status snapshot carries the same delivery block for stream-status.
    const snap = await inspectCodex();
    expect(snap.healthy).toBe(null); // degraded
    expect(snap.codex).toMatchObject({ lastInjectionResult: 'deferred', lastTargetThreadId: 'thread-123' });
    // No socket path or message contents leak into the delivery state.
    expect(JSON.stringify(d)).not.toContain('/tmp/codex.sock');
  });

  it('a fresh armed bridge with no pending delivery reads healthy', async () => {
    const snap = await inspectCodex();
    expect(snap.healthy).toBe(true);
    expect(snap.codex).toMatchObject({ deferredEntryCount: 0, retryDrainActive: false, lastInjectionResult: null });
  });

  it('recovery preserves exactly-once: once the thread goes idle the drain delivers a single catch-up turn and health clears', async () => {
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
      env: WAKE_ENV,
      createClient: vi.fn(() => client),
      hasPendingEntry: vi.fn(async () => true),
      sleep: vi.fn(async () => { status = { type: 'idle' }; }), // thread frees between polls
      now: vi.fn((() => { let c = 0; return () => (c += 1000); })()),
      jitter: () => 0,
      maxAttempts: 10,
    };
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deps, 'delivery-3', 'entry-3');
    await flush();

    // Exactly one catch-up drain turn — not duplicated across the per-entry
    // wake and the retry-drain.
    expect(client.startTurn).toHaveBeenCalledTimes(1);
    expect(client.startTurn).toHaveBeenCalledWith('thread-123', CODEX_CATCHUP_PROMPT);
    // Delivery confirmed → health clears back to healthy.
    const d = getCodexDeliveryState();
    expect(d.lastInjectionResult).toBe('delivered');
    expect(d.deferredEntryCount).toBe(0);
    const snap = await inspectCodex();
    expect(snap.healthy).toBe(true);
  });

  it('the HEARTBEAT path reports DEGRADED when it finds pending work + a mid-turn thread', async () => {
    // gh#89 round-2 blocker: the heartbeat tick sees authoritative pending work
    // and an active thread, then skips without queueing — it must mark the
    // deferral live so health reads degraded, not armed/healthy.
    const client = midTurnClient();
    await fireCodexHeartbeatTick({
      getActiveCube: vi.fn(async () => ACTIVE),
      env: WAKE_ENV,
      createClient: vi.fn(() => client),
      hasPendingWork: vi.fn(async () => true), // authoritative unread work exists
      now: vi.fn(() => 1000),
    });

    // Mid-turn → no catch-up turn injected (skip semantics unchanged).
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(getCodexDeliveryState().deliveryDeferred).toBe(true);
    // RED pre-fix (health was true during a heartbeat-deferred wake) → degraded.
    const snap = await inspectCodex();
    expect(snap.healthy).toBe(null);
  });

  it('round-3 blocker: a recovered seat (authoritative unread empty) clears the degraded marker — not permanently stuck', async () => {
    // First: a heartbeat that finds pending work + a mid-turn thread → degraded.
    const busy = midTurnClient();
    await fireCodexHeartbeatTick({
      getActiveCube: vi.fn(async () => ACTIVE),
      env: WAKE_ENV,
      createClient: vi.fn(() => busy),
      hasPendingWork: vi.fn(async () => true),
      now: vi.fn(() => 1000),
    });
    expect((await inspectCodex()).healthy).toBe(null); // degraded

    // The work is then drained by ANOTHER path (manual read / server read-cursor
    // recovery), so the next heartbeat authoritatively finds NO pending work.
    // The historical lastInjectionRes:'deferred' stays for reporting, but the
    // LIVE marker clears → health returns to healthy (RED without the clear:
    // stuck at null forever).
    await fireCodexHeartbeatTick({
      getActiveCube: vi.fn(async () => ACTIVE),
      hasPendingWork: vi.fn(async () => false), // authoritative unread now empty
      now: vi.fn(() => 2_000_000), // past the cadence so the tick fires
    });
    const d = getCodexDeliveryState();
    expect(d.deliveryDeferred).toBe(false);
    expect(d.lastInjectionResult).toBe('deferred'); // historical reporting is retained
    expect((await inspectCodex()).healthy).toBe(true);
  });

  // No-loaded-thread client: resolveFreshCodexWakeTarget goes through the env
  // socket path and returns null (pickFreshThread finds no thread), while the
  // persisted-target probe can still read armed.
  function noThreadClient() {
    return {
      connect: vi.fn(async () => {}),
      loadedThreadIds: vi.fn(async () => [] as string[]),
      readThread: vi.fn(async () => null),
      startTurn: vi.fn(async () => {}),
      close: vi.fn(),
    };
  }
  const ENV_SOCKET = { BORG_CODEX_REMOTE_WAKE: '1', BORG_CODEX_APP_SERVER_SOCKET: '/tmp/x.sock' } as any;

  it('round-4 blocker: the HEARTBEAT reports DEGRADED when pending work exists but no fresh target resolves', async () => {
    const client = noThreadClient();
    await fireCodexHeartbeatTick({
      getActiveCube: vi.fn(async () => ACTIVE),
      hasPendingWork: vi.fn(async () => true),
      env: ENV_SOCKET,
      createClient: vi.fn(() => client),
      now: vi.fn(() => 1000),
    });
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(getCodexDeliveryState().deliveryDeferred).toBe(true); // RED pre-fix
    expect((await inspectCodex()).healthy).toBe(null);
  });

  it('the PER-ENTRY wake reports DEGRADED when a still-pending scoped entry has no resolvable target', async () => {
    const client = noThreadClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, ENV_SOCKET, {
      getActiveCube: vi.fn(async () => ACTIVE),
      hasPendingEntry: vi.fn(async () => true), // the scoped entry is still pending
      env: ENV_SOCKET,
      createClient: vi.fn(() => client),
      now: vi.fn(() => 1000),
    }, 'delivery-nt', 'entry-nt');
    await flush();
    expect(client.startTurn).not.toHaveBeenCalled();
    expect(getCodexDeliveryState().deliveryDeferred).toBe(true); // RED pre-fix
    expect((await inspectCodex()).healthy).toBe(null);
  });

  it('the retry-drain age-out hands off to the live marker (no stale deferredEntryCount)', async () => {
    // deferDeps ages the retry-drain out (thread active, maxAttempts:5). After
    // the loop exits, the source set is cleared and the live marker is set, so
    // health stays degraded via deliveryDeferred rather than a stale count.
    const client = midTurnClient();
    wakeCodexViaAppServer(CODEX_WAKE_PROMPT, WAKE_ENV, deferDeps(client), 'delivery-ao', 'entry-ao');
    await flush();
    const d = getCodexDeliveryState();
    expect(d.retryDrainActive).toBe(false); // loop has exited (aged out)
    expect(d.deferredEntryCount).toBe(0); // set cleared at hand-off (not stale)
    expect(d.deliveryDeferred).toBe(true); // handed off to the live marker
    expect((await inspectCodex()).healthy).toBe(null);
  });

  it('codexWakePathHealthy keys off LIVE signals only, not historical last-attempt results (unit)', () => {
    const base = {
      lastTargetThreadId: 't', lastInjectionAt: 1, lastInjectionResult: null as any,
      lastInjectionFailureCode: null, deferredEntryCount: 0, retryDrainActive: false,
      deliveryDeferred: false, lastDeliveredAt: null,
    };
    expect(codexWakePathHealthy(false, base)).toBe(false); // positively-dead bridge dominates
    expect(codexWakePathHealthy(null, base)).toBe(null); // could not probe → indeterminate
    expect(codexWakePathHealthy(true, base)).toBe(true); // armed, nothing live-pending
    expect(codexWakePathHealthy(true, { ...base, deferredEntryCount: 1 })).toBe(null); // live queue → degraded
    expect(codexWakePathHealthy(true, { ...base, retryDrainActive: true })).toBe(null); // live retry → degraded
    expect(codexWakePathHealthy(true, { ...base, deliveryDeferred: true })).toBe(null); // live heartbeat pending → degraded
    // HISTORICAL results with NO live signal do NOT degrade — a recovered seat
    // is healthy (this is the round-3 fix; keying off these would stick).
    expect(codexWakePathHealthy(true, { ...base, lastInjectionResult: 'deferred' })).toBe(true);
    expect(codexWakePathHealthy(true, { ...base, lastInjectionResult: 'failed' })).toBe(true);
  });
});
