// Shared per-seat liveness probe (gh#877 reuse).
//
// Extracted from cleanup-cmd.ts so BOTH `borg cleanup` (destructive → fail-SAFE)
// and `borg launch-all` (constructive → fail-OPEN) can classify a saved seat by
// ITS OWN token, without launch-all having to import cleanup-cmd's chalk/report
// graph. cleanup-cmd re-exports `SeatStatus` for backwards compatibility.

import { whoami } from './remote-client.js';
import { DroneEvictedError } from './drone-lifecycle.js';

/**
 * Eviction-probe verdict for ONE worktree's saved seat. Mapped 1:1 from the
 * server's per-caller-seat discrimination:
 *   evicted       ← 410 DRONE_EVICTED  (terminal; the SOLE delete authority — gh#882 S1)
 *   live          ← 200                (resolves)
 *   indeterminate ← 401 / 404 / timeout / 5xx / network (transient, or a
 *                   pre-gh#877-deploy worker that still 401s an evicted seat)
 */
export type SeatStatus = 'evicted' | 'live' | 'indeterminate';

/**
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws the typed lifecycle error on the structured
 * code (410→DroneEvictedError); anything else is INDETERMINATE — and (for the
 * destructive cleanup path) must NEVER authorize a delete. The launch path
 * treats indeterminate as launch-anyway (fail-OPEN).
 */
export async function defaultProbeSeat(
  sessionToken: string,
  apiUrl: string,
  serverTrustIdentity?: string,
): Promise<SeatStatus> {
  try {
    await whoami(sessionToken, apiUrl, serverTrustIdentity);
    return 'live';
  } catch (err) {
    if (err instanceof DroneEvictedError) return 'evicted';
    return 'indeterminate';
  }
}
