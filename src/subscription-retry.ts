/**
 * gh#521 — post-subscribe subscription-status retry.
 *
 * A user who just subscribed via the web hits propagation lag: `borg setup`
 * authenticates, then the subscription check can still report no-access for a
 * few seconds (or up to the ~60s server-side subscription cache) — so setup
 * flashed a scary "No active subscription found" right after payment. This
 * retries the check a few times (non-alarmingly) before declaring no
 * subscription, so most just-subscribed users succeed on retry 2-3.
 *
 * Pure + injectable (no console / network / real timer of its own) so it's
 * unit-testable without the interactive setup flow — the cli-help.ts /
 * parse-assimilate-args.ts pattern.
 */
export interface SubscriptionStatus {
  hasAccess: boolean;
  /** ISO date / epoch / Date of subscription expiry, when present. */
  expiresAt?: string | number | Date;
  [key: string]: unknown;
}

export interface RetrySubscriptionDeps {
  /** Re-check subscription status (e.g. checkSubscriptionStatus). */
  check: () => Promise<SubscriptionStatus>;
  /** Delay between attempts (injected so tests don't actually wait). */
  sleep: (ms: number) => Promise<void>;
  /** Called before each RETRY (attempts 2..total) — for a non-alarming status line. */
  onRetry?: (attempt: number, total: number) => void;
  /** Total attempts including the initial one (default 3). */
  attempts?: number;
  /** Backoff between attempts in ms (default 2000). */
  backoffMs?: number;
}

/**
 * Given the initial check result, retry up to `attempts` total times with
 * `backoffMs` backoff, stopping early as soon as access is granted. A transient
 * error on a retry is swallowed (keep the prior status and keep trying). Returns
 * the latest status.
 */
export async function retrySubscriptionCheck(
  initial: SubscriptionStatus,
  deps: RetrySubscriptionDeps,
): Promise<SubscriptionStatus> {
  const attempts = deps.attempts ?? 3;
  const backoffMs = deps.backoffMs ?? 2000;
  let status = initial;
  for (let attempt = 2; attempt <= attempts && !status.hasAccess; attempt++) {
    deps.onRetry?.(attempt, attempts);
    await deps.sleep(backoffMs);
    try {
      status = await deps.check();
    } catch {
      // Transient error on a retry — keep the prior status and continue retrying.
    }
  }
  return status;
}
