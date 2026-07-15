/**
 * Given the initial check result, retry up to `attempts` total times with
 * `backoffMs` backoff, stopping early as soon as access is granted. A transient
 * error on a retry is swallowed (keep the prior status and keep trying). Returns
 * the latest status.
 */
export async function retrySubscriptionCheck(initial, deps) {
    const attempts = deps.attempts ?? 3;
    const backoffMs = deps.backoffMs ?? 2000;
    let status = initial;
    for (let attempt = 2; attempt <= attempts && !status.hasAccess; attempt++) {
        deps.onRetry?.(attempt, attempts);
        await deps.sleep(backoffMs);
        try {
            status = await deps.check();
        }
        catch {
            // Transient error on a retry — keep the prior status and continue retrying.
        }
    }
    return status;
}
//# sourceMappingURL=subscription-retry.js.map