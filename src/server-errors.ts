export type BorgServerErrorCode =
  | 'NOT_ENROLLED'
  | 'CREDENTIAL_REJECTED'
  | 'INVITATION_REJECTED'
  | 'CREATE_CUBE_DENIED'
  | 'ATTACH_CONFLICT'
  | 'SESSION_REJECTED';

/** Safe, non-secret state code for deterministic authority recovery copy. */
export class BorgServerError extends Error {
  constructor(
    public readonly code: BorgServerErrorCode,
    message: string,
  ) {
    super(message);
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
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: ErrorCode,
  ) {
    super(message);
    this.name = 'BorgServerHttpError';
  }
}

export class LocalManageRequiredError extends Error {
  constructor(
    public readonly operation: string,
    public readonly cubeName: string,
    public readonly noMutation: string,
  ) {
    super(
      `[LOCAL-MANAGE-REQUIRED] This session cannot ${operation} because ` +
      'the selected local client does not have cube management access.\n\n' +
      'Coordinator and Queen are workflow roles; they do not grant server permissions. ' +
      `${noMutation} Do not retry this request from this session.\n\n` +
      'Use a session whose local client already has management access to this cube.',
    );
    this.name = 'LocalManageRequiredError';
  }
}

export class LocalManageCredentialUnavailableError extends Error {
  constructor(
    public readonly operation: string,
    public readonly cubeName: string,
    public readonly noMutation: string,
  ) {
    super(
      `The selected local client credential for cube "${cubeName}" is missing or unreadable. ` +
      `This session cannot ${operation}. ${noMutation} Restore or re-enroll the selected local ` +
      'client before retrying.',
    );
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
  constructor(message: string) {
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
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BorgServerUnreachableError';
  }
}
import type { ErrorCode } from 'borgmcp-shared/protocol';
