export interface EnrollmentTrustPointer {
    version: 1;
    origin: string;
    generationId: string;
    trustIdentity: string;
}
export interface EnrollmentArtifactBinding {
    artifactFormatVersion: number;
    artifactDigest: string;
    endpoint: string;
    caSpkiSha256: string;
    trustIdentity: string;
    expectedAuthority: 'owner' | 'client';
    stagedGenerationId: string;
}
export interface EnrollmentReplacementCapability {
    token: string;
    priorAccountsDigest: string;
    endpoint: string;
    caSpkiSha256: string;
    trustIdentity: string;
    retryKey: string;
    artifactDigest: string;
}
export interface EnrollmentRollbackSnapshot {
    activeAccounts: Record<string, string>;
    pendingAccount: string;
    pendingValue: string;
}
export interface EnrollmentRollbackRecord {
    version: 1;
    state: 'rollback-snapshot';
    origin: string;
    snapshot: EnrollmentRollbackSnapshot;
}
export interface AcceptedEnrollmentMarker {
    version: 1;
    state: 'accepted';
    origin: string;
    trustIdentity: string;
    generationId: string;
    previousPointer: EnrollmentTrustPointer | null;
    activeDigest: string;
    rollbackAccount: string;
    rollbackDigest: string;
}
//# sourceMappingURL=enrollment-types.d.ts.map