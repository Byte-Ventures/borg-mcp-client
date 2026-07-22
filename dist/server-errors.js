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
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'BorgServerHttpError';
    }
}
export class LocalManageRequiredError extends Error {
    operation;
    cubeName;
    noMutation;
    constructor(operation, cubeName, noMutation) {
        super(`[LOCAL-MANAGE-REQUIRED] This session cannot ${operation} because ` +
            'the selected local client does not have cube management access.\n\n' +
            'Coordinator and Queen are workflow roles; they do not grant server permissions. ' +
            `${noMutation} Do not retry this request from this session.\n\n` +
            'Use a session whose local client already has management access to this cube.');
        this.operation = operation;
        this.cubeName = cubeName;
        this.noMutation = noMutation;
        this.name = 'LocalManageRequiredError';
    }
}
export class LocalManageCredentialUnavailableError extends Error {
    operation;
    cubeName;
    noMutation;
    constructor(operation, cubeName, noMutation) {
        super(`The selected local client credential for cube "${cubeName}" is missing or unreadable. ` +
            `This session cannot ${operation}. ${noMutation} Restore or re-enroll the selected local ` +
            'client before retrying.');
        this.operation = operation;
        this.cubeName = cubeName;
        this.noMutation = noMutation;
        this.name = 'LocalManageCredentialUnavailableError';
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
/** Exact retired TTL-replacement state: two saved bearers and no safe implicit winner. */
export class LegacySessionCredentialCollisionError extends Error {
    origin;
    constructor(origin) {
        super('Local session credential collision detected');
        this.origin = origin;
        this.name = 'LegacySessionCredentialCollisionError';
    }
}
//# sourceMappingURL=server-errors.js.map