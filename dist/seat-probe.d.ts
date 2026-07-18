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
export declare function defaultProbeSeat(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<SeatStatus>;
//# sourceMappingURL=seat-probe.d.ts.map