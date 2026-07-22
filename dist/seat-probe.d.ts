/**
 * Eviction-probe verdict for ONE worktree's saved seat. Distinct CAUSES are
 * preserved (CR #6 / CR5 — the probe must NOT collapse them). Each verdict is
 * derived from the actual error TYPE/CODE, never from a mutable error-text regex:
 *   evicted            ← 410 DRONE_EVICTED (terminal; the SOLE delete authority — gh#882 S1)
 *   revoked            ← pin-matched drone-SESSION 401 carrying SESSION_REVOKED
 *   rejected           ← pin-matched drone-SESSION 401 carrying SESSION_REJECTED
 *                        (superseded by a newer enrollment)
 *   credential-rejected← any OTHER 401 on the drone session (bare/untyped or a
 *                        non-SESSION typed code): the saved credential is no longer
 *                        accepted, but this is NON-DESTRUCTIVE — re-enroll, NEVER a
 *                        seat reset and never a "restart the server" blip
 *   trust-mismatch     ← the pinned server identity no longer matches (TYPED
 *                        BorgServerTrustError; terminal — restarting does not fix it)
 *   unreachable        ← transport failure: connection refused/reset, DNS, or a
 *                        request timeout (TYPED BorgServerUnreachableError or a stable
 *                        transport errno) — genuinely transient
 *   endpoint-mismatch  ← a 404 from a verified server: the drone endpoint/protocol is
 *                        not recognized (a client/server version mismatch)
 *   server-failure     ← a 5xx from a verified server (its internal error; transient)
 *   live               ← 200 (resolves)
 *   indeterminate      ← any other ambiguous/unknown failure — never authorizes a
 *                        delete or a seat reset
 */
export type SeatStatus = 'evicted' | 'revoked' | 'rejected' | 'live' | 'credential-rejected' | 'trust-mismatch' | 'unreachable' | 'endpoint-mismatch' | 'server-failure' | 'indeterminate';
/**
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws TYPED errors on the authoritative outcomes
 * (410→DroneEvictedError; pin-matched typed 401→BorgServerError('SESSION_REJECTED');
 * every other 401→BorgServerError('CREDENTIAL_REJECTED'); a pinned-identity mismatch
 * →BorgServerTrustError; a non-ok status→BorgServerHttpError(status); a transport
 * failure/timeout→BorgServerUnreachableError). Each maps to a STABLE typed verdict
 * so recovery copy is cause-accurate; the cleanup path must NEVER delete on anything
 * but `evicted`; the launch path treats every non-`evicted`/non-terminal cause as
 * fail-OPEN.
 */
export declare function defaultProbeSeat(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<SeatStatus>;
//# sourceMappingURL=seat-probe.d.ts.map