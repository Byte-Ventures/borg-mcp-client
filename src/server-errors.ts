export type BorgServerErrorCode =
  | 'NOT_ENROLLED'
  | 'CREDENTIAL_REJECTED'
  | 'INVITATION_REJECTED'
  | 'LOCAL_CREDENTIAL_EXISTS'
  | 'CREATE_CUBE_DENIED'
  | 'ATTACH_CONFLICT'
  | 'SESSION_REJECTED'
  | 'SESSION_REVOKED';

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

export class BorgProtocolMismatchError extends Error {
  constructor() {
    super(
      'This client and the selected Borg server use different protocol versions. ' +
      'Update `borgmcp-server` and `borgmcp` to matching releases, server first and then client.',
    );
    this.name = 'BorgProtocolMismatchError';
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

export class LocalUnsupportedError extends Error {
  constructor(public readonly capability: string) {
    super(`Local Borg server does not support ${capability}`);
    this.name = 'LocalUnsupportedError';
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

export class CubeCreationOutcomeUnknownError extends Error {
  constructor() {
    super('Cube creation outcome is unknown.');
    this.name = 'CubeCreationOutcomeUnknownError';
  }
}

export class CubeCreationConfirmationError extends Error {
  constructor(message = 'The Borg server returned conflicting repository cube state.') {
    super(message);
    this.name = 'CubeCreationConfirmationError';
  }
}

export class CubeDeletionConfirmationError extends Error {
  constructor(
    public readonly cubeId: string,
    public readonly confirmCubeId: string | undefined,
  ) {
    const supplied = confirmCubeId === undefined ? '(missing)' : `"${confirmCubeId}"`;
    super(
      `Cube deletion is irreversible. The confirmation cube ID ${supplied} must exactly match ` +
      `the requested cube ID "${cubeId}". No cube was deleted.`,
    );
    this.name = 'CubeDeletionConfirmationError';
  }
}

export type RepositoryAssociationFailure =
  | 'repository-already-associated'
  | 'cube-already-associated'
  | 'access-denied'
  | 'invalid-cube';

export class RepositoryAssociationOperationError extends Error {
  constructor(public readonly failure: RepositoryAssociationFailure) {
    super('Borg server rejected the repository cube association');
    this.name = 'RepositoryAssociationOperationError';
  }
}

export class RepositoryAssociationOutcomeUnknownError extends Error {
  constructor() {
    super('Repository cube association outcome is unknown.');
    this.name = 'RepositoryAssociationOutcomeUnknownError';
  }
}

export class RepositoryAssociationResolutionError extends Error {
  constructor() {
    super('Repository cube association could not be resolved.');
    this.name = 'RepositoryAssociationResolutionError';
  }
}

/** Exact retired TTL-replacement state: two saved bearers and no safe implicit winner. */
export class LegacySessionCredentialCollisionError extends Error {
  constructor(public readonly origin: string) {
    super('Local session credential collision detected');
    this.name = 'LegacySessionCredentialCollisionError';
  }
}
import type { ErrorCode } from 'borgmcp-shared/protocol';
