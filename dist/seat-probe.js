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
 * Default seat probe: a lightweight drone-authed `whoami` with the seat's OWN
 * saved token. authedFetch throws typed errors on the authoritative codes
 * (410→DroneEvictedError; pin-matched 401→BorgServerError('SESSION_REJECTED')).
 * A trust-mismatch / unreachable / 5xx / 404 stays INDETERMINATE — and (for the
 * destructive cleanup path) must NEVER authorize a delete. The launch path
 * treats indeterminate as launch-anyway (fail-OPEN).
 */
export async function defaultProbeSeat(sessionToken, apiUrl, serverTrustIdentity) {
    try {
        await whoami(sessionToken, apiUrl, serverTrustIdentity);
        return 'live';
    }
    catch (err) {
        if (err instanceof DroneEvictedError)
            return 'evicted';
        // Pin-matched session rejection is distinct from unreachable/404/5xx/
        // trust-mismatch (which throw plain Errors and remain indeterminate).
        if (err instanceof BorgServerError && err.code === 'SESSION_REJECTED')
            return 'rejected';
        return 'indeterminate';
    }
}
//# sourceMappingURL=seat-probe.js.map