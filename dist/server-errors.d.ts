export type BorgServerErrorCode = 'NOT_ENROLLED' | 'CREDENTIAL_REJECTED' | 'INVITATION_REJECTED' | 'CREATE_CUBE_DENIED' | 'ATTACH_CONFLICT' | 'SESSION_REJECTED';
/** Safe, non-secret state code for deterministic authority recovery copy. */
export declare class BorgServerError extends Error {
    readonly code: BorgServerErrorCode;
    constructor(code: BorgServerErrorCode, message: string);
}
/**
 * CR5: a STABLE TYPED non-ok HTTP verdict from a verified server. Carries the raw
 * status so the seat probe classifies endpoint/protocol-mismatch (404) vs
 * server-failure (5xx) from the actual code — never a mutable error-text regex.
 * The message is kept identical to the pre-typed string for call-site parity.
 */
export declare class BorgServerHttpError extends Error {
    readonly status: number;
    readonly code?: ErrorCode | undefined;
    constructor(status: number, message: string, code?: ErrorCode | undefined);
}
export declare class LocalManageRequiredError extends Error {
    readonly operation: string;
    readonly cubeName: string;
    readonly noMutation: string;
    constructor(operation: string, cubeName: string, noMutation: string);
}
/**
 * CR5: a STABLE TYPED terminal trust verdict — the pinned server identity no longer
 * matches. This is a security boundary: it must be classified from the error TYPE,
 * never from an error-text regex ("regex classification is not an authority
 * boundary"). trust-mismatch is terminal (never launch-anyway, never credential-send).
 */
export declare class BorgServerTrustError extends Error {
    constructor(message: string);
}
/**
 * CR5: a STABLE TYPED transport-failure verdict — the server was unreachable
 * (connection refused/reset, DNS failure) or the request timed out. Distinct from
 * an HTTP status; genuinely transient.
 */
export declare class BorgServerUnreachableError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
import type { ErrorCode } from 'borgmcp-shared/protocol';
//# sourceMappingURL=server-errors.d.ts.map