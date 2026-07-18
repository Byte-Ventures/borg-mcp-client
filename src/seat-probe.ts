// Shared per-seat liveness probe (gh#877 reuse).
//
// Extracted from cleanup-cmd.ts so BOTH `borg cleanup` (destructive → fail-SAFE)
// and `borg launch-all` (constructive → fail-OPEN) can classify a saved seat by
// ITS OWN token, without launch-all having to import cleanup-cmd's chalk/report
// graph. cleanup-cmd re-exports `SeatStatus` for backwards compatibility.

import { whoami } from './remote-client.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { BorgServerError } from './server-errors.js';

/**
 * Eviction-probe verdict for ONE worktree's saved seat. Mapped 1:1 from the
 * server's per-caller-seat discrimination:
 *   evicted       ← 410 DRONE_EVICTED   (terminal; the SOLE delete authority — gh#882 S1)
 *   rejected      ← pin-matched 401      (verified server rejected THIS bearer —
 *                   revoked / taken over; recoverable via a scoped worktree reset)
 *   live          ← 200                  (resolves)
 *   indeterminate ← 404 / timeout / 5xx / network / trust-mismatch (transient or
 *                   ambiguous — never authorizes a delete or a seat reset)
 */
export type SeatStatus = 'evicted' | 'rejected' | 'live' | 'indeterminate';

/**
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws typed errors on the authoritative codes
 * (410→DroneEvictedError; pin-matched 401→BorgServerError('SESSION_REJECTED')).
 * A trust-mismatch / unreachable / 5xx / 404 stays INDETERMINATE — and (for the
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
    // Pin-matched session rejection is distinct from unreachable/404/5xx/
    // trust-mismatch (which throw plain Errors and remain indeterminate).
    if (err instanceof BorgServerError && err.code === 'SESSION_REJECTED') return 'rejected';
    return 'indeterminate';
  }
}
