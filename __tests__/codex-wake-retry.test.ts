/**
 * gh#857 — codex wake resilience Phase 2 pure helpers.
 *
 * WI-1 (durable per-entry retry): a wake that hits a transient connect/read
 * error or a mid-turn-active thread is re-enqueued with exponential backoff and
 * retried until delivered, instead of being swallowed (the old best-effort drop)
 * or handed to a 15-min-give-up catch-up poller. A generous age cap bounds the
 * queue; the WI-2 heartbeat is the backstop beyond it.
 *
 * WI-2 (codex /loop-equivalent heartbeat): a periodic drain injected on a fixed
 * cadence, SKIPPED when a delivery already landed inside the cadence window
 * (double-fire avoidance with the per-entry wake).
 *
 * These pin the pure decisions; the IO orchestration lives in codex-app-wake.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  WAKE_RETRY_BASE_MS,
  WAKE_RETRY_CAP_MS,
  wakeRetryBackoffMs,
  wakeRetryExpired,
  shouldFireHeartbeat,
} from '../src/codex-wake-resolve';

describe('gh#857 WI-1 — wakeRetryBackoffMs (exponential, capped)', () => {
  it('doubles per attempt from the base, then saturates at the cap', () => {
    expect(wakeRetryBackoffMs(0)).toBe(WAKE_RETRY_BASE_MS); // 5s
    expect(wakeRetryBackoffMs(1)).toBe(WAKE_RETRY_BASE_MS * 2); // 10s
    expect(wakeRetryBackoffMs(2)).toBe(WAKE_RETRY_BASE_MS * 4); // 20s
    expect(wakeRetryBackoffMs(3)).toBe(WAKE_RETRY_BASE_MS * 8); // 40s
    expect(wakeRetryBackoffMs(4)).toBe(WAKE_RETRY_CAP_MS); // 80s → capped 60s
    expect(wakeRetryBackoffMs(99)).toBe(WAKE_RETRY_CAP_MS); // stays capped
  });

  it('adds caller-supplied jitter on top (so siblings do not retry in lockstep)', () => {
    expect(wakeRetryBackoffMs(0, 250)).toBe(WAKE_RETRY_BASE_MS + 250);
    expect(wakeRetryBackoffMs(4, 500)).toBe(WAKE_RETRY_CAP_MS + 500);
  });

  it('treats negative attempts as 0 (defensive)', () => {
    expect(wakeRetryBackoffMs(-3)).toBe(WAKE_RETRY_BASE_MS);
  });
});

describe('gh#857 WI-1 — wakeRetryExpired (age cap; heartbeat backstops beyond)', () => {
  it('not expired before the cap, expired at/after it', () => {
    const t0 = 1_000_000;
    expect(wakeRetryExpired(t0, t0 + 1000, 60_000)).toBe(false);
    expect(wakeRetryExpired(t0, t0 + 60_000, 60_000)).toBe(true);
    expect(wakeRetryExpired(t0, t0 + 120_000, 60_000)).toBe(true);
  });
});

describe('gh#857 WI-2 — shouldFireHeartbeat (double-fire avoidance)', () => {
  const CADENCE = 20 * 60_000;
  const now = 100 * 60_000;

  it('fires when no delivery has ever landed', () => {
    expect(shouldFireHeartbeat(null, now, CADENCE)).toBe(true);
  });

  it('SKIPS when a delivery landed within the cadence window', () => {
    expect(shouldFireHeartbeat(now - (CADENCE - 1), now, CADENCE)).toBe(false);
  });

  it('fires when the last delivery is older than the cadence window', () => {
    expect(shouldFireHeartbeat(now - CADENCE, now, CADENCE)).toBe(true);
    expect(shouldFireHeartbeat(now - 2 * CADENCE, now, CADENCE)).toBe(true);
  });
});
