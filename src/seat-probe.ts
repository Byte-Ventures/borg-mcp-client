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
 * Eviction-probe verdict for ONE worktree's saved seat. Distinct CAUSES are
 * preserved (CR #6 — the probe must NOT collapse them to `indeterminate`):
 *   evicted            ← 410 DRONE_EVICTED (terminal; the SOLE delete authority — gh#882 S1)
 *   rejected           ← pin-matched drone-SESSION 401 carrying the EXACT typed
 *                        SESSION_REJECTED code (revoked / taken over; recover via
 *                        the offline `borg reset-local-seat` — never here)
 *   credential-rejected← any OTHER 401 on the drone session (bare/untyped or a
 *                        non-SESSION typed code): the saved credential is no longer
 *                        accepted, but this is NON-DESTRUCTIVE — re-enroll, NEVER a
 *                        seat reset and never a "restart the server" blip
 *   trust-mismatch     ← the pinned server identity no longer matches (terminal
 *                        trust error; restarting the server does not fix it)
 *   live               ← 200 (resolves)
 *   indeterminate      ← 404 / timeout / 5xx / network (genuinely transient/
 *                        ambiguous — never authorizes a delete or a seat reset)
 */
export type SeatStatus =
  | 'evicted'
  | 'rejected'
  | 'live'
  | 'credential-rejected'
  | 'trust-mismatch'
  | 'indeterminate';

/**
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws typed errors on the authoritative codes
 * (410→DroneEvictedError; pin-matched typed 401→BorgServerError('SESSION_REJECTED');
 * every other 401→BorgServerError('CREDENTIAL_REJECTED')). A trust-identity /
 * pinned-CA mismatch throws a distinct plain Error and is preserved as
 * `trust-mismatch`; only a genuinely transient 404/5xx/network failure stays
 * `indeterminate`. The cleanup path must NEVER delete on anything but `evicted`;
 * the launch path treats every non-`evicted` cause as fail-OPEN.
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
    if (err instanceof BorgServerError) {
      if (err.code === 'SESSION_REJECTED') return 'rejected';
      // Every non-SESSION 401 (bare/untyped or a different typed code) is a
      // credential rejection — non-destructive, distinct from a takeover.
      if (err.code === 'CREDENTIAL_REJECTED') return 'credential-rejected';
    }
    // A pinned-identity / CA mismatch is a TERMINAL trust error, not a transient
    // blip: authedFetch / loadBorgServerTrust throw a plain Error naming it.
    const message = err instanceof Error ? err.message : String(err);
    if (/\btrust\b|certificate|\bCA\b|pinned identity|identity changed/i.test(message)) {
      return 'trust-mismatch';
    }
    return 'indeterminate';
  }
}
