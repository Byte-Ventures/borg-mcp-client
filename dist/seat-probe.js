// Shared per-seat liveness probe (gh#877 reuse).
//
// Extracted from cleanup-cmd.ts so BOTH `borg cleanup` (destructive → fail-SAFE)
// and `borg launch-all` (constructive → fail-OPEN) can classify a saved seat by
// ITS OWN token, without launch-all having to import cleanup-cmd's chalk/report
// graph. cleanup-cmd re-exports `SeatStatus` for backwards compatibility.
import { whoami } from './remote-client.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { BorgServerError, BorgServerHttpError, BorgServerTrustError, BorgServerUnreachableError, } from './server-errors.js';
// Stable transport-level errno / undici codes (a CODE check, not error-text). A
// pinned-CA TLS failure and a refused/reset/timeout all surface one of these.
const TRANSPORT_ERRNOS = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ABORT_ERR',
]);
function isTransportFailure(err) {
    if (err instanceof BorgServerUnreachableError)
        return true;
    const e = err;
    if (e?.name === 'AbortError')
        return true;
    const code = e?.code ?? e?.cause?.code;
    return typeof code === 'string' && TRANSPORT_ERRNOS.has(code);
}
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
export async function defaultProbeSeat(sessionToken, apiUrl, serverTrustIdentity) {
    try {
        await whoami(sessionToken, apiUrl, serverTrustIdentity);
        return 'live';
    }
    catch (err) {
        if (err instanceof DroneEvictedError)
            return 'evicted';
        // A pinned-identity / CA mismatch is a TERMINAL trust verdict — classified from
        // the error TYPE, never from message text (the security boundary).
        if (err instanceof BorgServerTrustError)
            return 'trust-mismatch';
        if (err instanceof BorgServerError) {
            if (err.code === 'SESSION_REVOKED')
                return 'revoked';
            if (err.code === 'SESSION_REJECTED')
                return 'rejected';
            // Every non-SESSION 401 (bare/untyped or a different typed code) is a
            // credential rejection — non-destructive, distinct from a takeover.
            if (err.code === 'CREDENTIAL_REJECTED')
                return 'credential-rejected';
        }
        if (err instanceof BorgServerHttpError) {
            if (err.status === 404)
                return 'endpoint-mismatch';
            if (err.status >= 500 && err.status <= 599)
                return 'server-failure';
            return 'indeterminate';
        }
        if (isTransportFailure(err))
            return 'unreachable';
        return 'indeterminate';
    }
}
//# sourceMappingURL=seat-probe.js.map