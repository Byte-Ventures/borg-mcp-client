export type BorgServerErrorCode =
  | 'NOT_ENROLLED'
  | 'CREDENTIAL_REJECTED'
  | 'INVITATION_REJECTED'
  | 'ATTACH_CONFLICT';

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
