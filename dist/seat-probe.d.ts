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
export type SeatStatus = 'evicted' | 'rejected' | 'live' | 'credential-rejected' | 'trust-mismatch' | 'indeterminate';
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
export declare function defaultProbeSeat(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<SeatStatus>;
//# sourceMappingURL=seat-probe.d.ts.map