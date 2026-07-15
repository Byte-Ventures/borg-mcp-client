/**
 * Tests for the gh#330 client-side 429 Retry-After honoring helpers in
 * remote-client.ts. The retry logic is extracted behind injected
 * `doRequest` + `sleep` seams so it is fully unit-testable without
 * mocking global fetch or sleeping in real time.
 *
 * Refinement #12 bidirectional: retry-vs-no-retry, honor-vs-fallback,
 * cap-vs-uncapped on each decision.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractHttpErrorMessage, parseRetryAfterMs, rateLimitWaitMs, retryOn429 } from '../src/remote-client';

/** Minimal Response stand-in: just the bits retryOn429 reads. */
function fakeResponse(status: number, retryAfter?: string): Response {
  return {
    status,
    headers: { get: (k: string) => (k === 'Retry-After' && retryAfter != null ? retryAfter : null) },
  } as unknown as Response;
}

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds into ms', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs(' 12 ')).toBe(12000);
  });
  it('returns null for absent / non-integer / negative', () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs('abc')).toBeNull();
    expect(parseRetryAfterMs('-1')).toBeNull();
    expect(parseRetryAfterMs('1.5')).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
  });
});

describe('rateLimitWaitMs', () => {
  const noJitter = () => 0;
  it('honors Retry-After when within the cap', () => {
    expect(rateLimitWaitMs(5000, 0, 60_000, noJitter)).toBe(5000);
  });
  it('caps a large Retry-After (full-window reset cannot wedge the call)', () => {
    expect(rateLimitWaitMs(3_600_000, 0, 60_000, noJitter)).toBe(60_000);
  });
  it('falls back to escalating 1s·(attempt+1) when Retry-After absent', () => {
    expect(rateLimitWaitMs(null, 0, 60_000, noJitter)).toBe(1000);
    expect(rateLimitWaitMs(null, 2, 60_000, noJitter)).toBe(3000);
  });
  it('adds jitter on top of the base wait', () => {
    expect(rateLimitWaitMs(5000, 0, 60_000, () => 250)).toBe(5250);
  });
});

describe('retryOn429', () => {
  it('returns the initial response immediately when it is non-429 (no request, no sleep)', async () => {
    // The caller already made the request; a 200 must NOT trigger a re-fetch.
    const doRequest = vi.fn(async () => fakeResponse(200));
    const sleep = vi.fn(async () => {});
    const res = await retryOn429(fakeResponse(200), doRequest, { sleep });
    expect(res.status).toBe(200);
    expect(doRequest).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('honors the INITIAL 429 Retry-After BEFORE re-requesting (no immediate double-fire — CR d3a564f5)', async () => {
    // Initial 429 (Retry-After 3s) already in hand; the next request must
    // come AFTER a 3s wait, not immediately.
    const doRequest = vi.fn(async () => fakeResponse(200));
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => { slept.push(ms); });
    const res = await retryOn429(fakeResponse(429, '3'), doRequest, { sleep, jitter: () => 0 });
    expect(res.status).toBe(200);
    expect(slept).toEqual([3000]);          // waited the initial 429's Retry-After first
    expect(doRequest).toHaveBeenCalledTimes(1); // exactly one re-request, after the wait
  });

  it('exhausts maxRetries on persistent 429 and returns the final 429', async () => {
    const doRequest = vi.fn(async () => fakeResponse(429, '1'));
    const sleep = vi.fn(async () => {});
    const res = await retryOn429(fakeResponse(429, '1'), doRequest, { sleep, maxRetries: 3, jitter: () => 0 });
    expect(res.status).toBe(429);
    // initial (already had) + 3 waits → 3 re-requests; 3 sleeps.
    expect(doRequest).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('falls back to escalating waits when the 429 has no Retry-After header', async () => {
    const doRequest = vi.fn(async () => fakeResponse(429)); // no header
    const slept: number[] = [];
    const sleep = vi.fn(async (ms: number) => { slept.push(ms); });
    await retryOn429(fakeResponse(429), doRequest, { sleep, maxRetries: 2, jitter: () => 0 });
    expect(slept).toEqual([1000, 2000]); // 1s·(attempt+1)
  });
});

describe('extractHttpErrorMessage', () => {
  it('surfaces structured worker error messages without raw JSON noise', () => {
    expect(
      extractHttpErrorMessage(
        JSON.stringify({
          error: {
            code: 'INVALID_INPUT',
            message: 'Invalid since cursor.',
            details: 'Use an entry id or ISO timestamp.',
          },
        })
      )
    ).toBe('Invalid since cursor. Use an entry id or ISO timestamp.');
  });

  it('keeps legacy string error bodies readable', () => {
    expect(
      extractHttpErrorMessage(
        JSON.stringify({ error: 'Invalid ack body', details: 'entry_id is required' })
      )
    ).toBe('Invalid ack body: entry_id is required');
  });

  it('keeps top-level worker details with the message', () => {
    expect(
      extractHttpErrorMessage(
        JSON.stringify({
          code: 'SUBSCRIPTION_REQUIRED',
          message: 'Subscription required.',
          details: 'Run borg_upgrade-subscription to continue.',
        })
      )
    ).toBe('Subscription required. Run borg_upgrade-subscription to continue.');
  });
});
