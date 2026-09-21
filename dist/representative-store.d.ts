/**
 * Private on-disk state for the human representative connection.
 *
 * One 0600 file under the Borg config root holds, per representative worktree:
 * - the BINDING: the one explicit cube + Coordinator drone this worktree's
 *   dedicated seat may talk to. Changing it requires an explicit operator rebind.
 * - the REQUEST LEDGER: one record per sent request id, so a retry never becomes
 *   a second message and an ambiguous send survives a reconnect.
 *
 * The file never holds a bearer (the seat store owns credentials) and never
 * holds message text (only a payload digest).
 */
export declare function isRepresentativeUuid(value: unknown): value is string;
export interface RepresentativeBinding {
    /** Canonical worktree holding the dedicated representative seat. */
    worktree: string;
    origin: string;
    trustIdentity: string;
    cubeId: string;
    cubeName: string;
    representativeDroneId: string;
    representativeLabel: string;
    representativeRoleName: string;
    coordinatorDroneId: string;
    coordinatorLabel: string;
    coordinatorRoleName: string;
    repositoryOrigin?: string;
    boundAt: string;
}
export declare function representativeRecoveryCommand(binding: RepresentativeBinding): string;
export type RepresentativeRequestState = 'pending' | 'ambiguous' | 'sent' | 'rejected';
export interface RepresentativeRequestRecord {
    /** Stable request identity; also the protocol `post_id` idempotency key. */
    requestId: string;
    /** sha256 of kind, authorization, message, cube and Coordinator — never the text. */
    payloadDigest: string;
    kind: string;
    authorization: string;
    state: RepresentativeRequestState;
    entryId?: string;
    /** An attempt under this id may have reached the log; a later refusal must not clear that. */
    maybeStored?: boolean;
    createdAt: string;
    updatedAt: string;
}
export declare class RepresentativeStoreError extends Error {
    readonly code: 'BINDING_CONFLICT';
    constructor(code: 'BINDING_CONFLICT', message: string);
}
export interface RepresentativeStore {
    getBinding(worktree: string): Promise<RepresentativeBinding | null>;
    saveBinding(binding: RepresentativeBinding, options: {
        rebind: boolean;
    }): Promise<'created' | 'unchanged' | 'rebound'>;
    /** Read-compare-write over one worktree's ledger under the store lock. */
    transactRequests<T>(worktree: string, op: (records: RepresentativeRequestRecord[]) => T): Promise<T>;
}
export declare function representativeStorePath(): string;
export declare function createRepresentativeStore(storePath?: string): RepresentativeStore;
//# sourceMappingURL=representative-store.d.ts.map