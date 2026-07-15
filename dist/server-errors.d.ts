export type BorgServerErrorCode = 'NOT_ENROLLED' | 'CREDENTIAL_REJECTED' | 'INVITATION_REJECTED' | 'ATTACH_CONFLICT';
/** Safe, non-secret state code for deterministic authority recovery copy. */
export declare class BorgServerError extends Error {
    readonly code: BorgServerErrorCode;
    constructor(code: BorgServerErrorCode, message: string);
}
//# sourceMappingURL=server-errors.d.ts.map