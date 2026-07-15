/**
 * Eviction-probe verdict for ONE worktree's saved seat. Mapped 1:1 from the
 * server's per-caller-seat discrimination:
 *   evicted       ← 410 DRONE_EVICTED  (terminal; the SOLE delete authority — gh#882 S1)
 *   frozen        ← 423 DRONE_FROZEN   (reversible — subscription downgrade)
 *   live          ← 200                (resolves)
 *   indeterminate ← 401 / 404 / timeout / 5xx / network (transient, or a
 *                   pre-gh#877-deploy worker that still 401s an evicted seat)
 */
export type SeatStatus = 'evicted' | 'frozen' | 'live' | 'indeterminate';
/**
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws the typed lifecycle errors on the structured
 * codes (410→DroneEvictedError, 423→DroneFrozenError); anything else is
 * INDETERMINATE — and (for the destructive cleanup path) must NEVER authorize a
 * delete. The launch path treats indeterminate as launch-anyway (fail-OPEN).
 */
export declare function defaultProbeSeat(sessionToken: string, apiUrl: string): Promise<SeatStatus>;
//# sourceMappingURL=seat-probe.d.ts.map