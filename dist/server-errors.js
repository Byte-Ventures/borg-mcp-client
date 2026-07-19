/** Safe, non-secret state code for deterministic authority recovery copy. */
export class BorgServerError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'BorgServerError';
    }
}
/**
 * CR5: a STABLE TYPED non-ok HTTP verdict from a verified server. Carries the raw
 * status so the seat probe classifies endpoint/protocol-mismatch (404) vs
 * server-failure (5xx) from the actual code — never a mutable error-text regex.
 * The message is kept identical to the pre-typed string for call-site parity.
 */
export class BorgServerHttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'BorgServerHttpError';
    }
}
/**
 * CR5: a STABLE TYPED terminal trust verdict — the pinned server identity no longer
 * matches. This is a security boundary: it must be classified from the error TYPE,
 * never from an error-text regex ("regex classification is not an authority
 * boundary"). trust-mismatch is terminal (never launch-anyway, never credential-send).
 */
export class BorgServerTrustError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BorgServerTrustError';
    }
}
/**
 * CR5: a STABLE TYPED transport-failure verdict — the server was unreachable
 * (connection refused/reset, DNS failure) or the request timed out. Distinct from
 * an HTTP status; genuinely transient.
 */
export class BorgServerUnreachableError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'BorgServerUnreachableError';
    }
}
//# sourceMappingURL=server-errors.js.map