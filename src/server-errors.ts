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
