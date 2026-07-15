/**
 * gh#521 — retrySubscriptionCheck absorbs post-subscribe propagation lag so
 * `borg setup` doesn't flash "no subscription" immediately after payment.
 */
import { describe, it, expect, vi } from 'vitest';
import { retrySubscriptionCheck } from '../src/subscription-retry';

const noSleep = () => Promise.resolve();

describe('gh#521 — retrySubscriptionCheck', () => {
  it('does not retry when the initial status already has access', async () => {
    const check = vi.fn();
    const onRetry = vi.fn();
    const out = await retrySubscriptionCheck({ hasAccess: true }, { check, sleep: noSleep, onRetry });
    expect(out.hasAccess).toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries up to 3 total attempts and stops early once access is granted', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ hasAccess: false }) // attempt 2
      .mockResolvedValueOnce({ hasAccess: true }); // attempt 3
    const onRetry = vi.fn();
    const out = await retrySubscriptionCheck({ hasAccess: false }, { check, sleep: noSleep, onRetry });
    expect(out.hasAccess).toBe(true);
    expect(check).toHaveBeenCalledTimes(2); // 2 retries (attempts 2,3)
    expect(onRetry).toHaveBeenNthCalledWith(1, 2, 3);
    expect(onRetry).toHaveBeenNthCalledWith(2, 3, 3);
  });

  it('exhausts all attempts and returns no-access when never granted', async () => {
    const check = vi.fn().mockResolvedValue({ hasAccess: false });
    const onRetry = vi.fn();
    const out = await retrySubscriptionCheck(
      { hasAccess: false },
      { check, sleep: noSleep, onRetry, attempts: 3 },
    );
    expect(out.hasAccess).toBe(false);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('swallows a transient error on a retry and keeps trying', async () => {
    const check = vi
      .fn()
      .mockRejectedValueOnce(new Error('network blip')) // attempt 2 throws
      .mockResolvedValueOnce({ hasAccess: true }); // attempt 3 grants
    const out = await retrySubscriptionCheck({ hasAccess: false }, { check, sleep: noSleep });
    expect(out.hasAccess).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
