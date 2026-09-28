/**
 * The human representative's bindings and request ledger, stored in the
 * representative state database (representative-db.ts).
 *
 * - The BINDING: the one explicit cube + Coordinator drone a worktree's
 *   dedicated seat may talk to. Changing it requires an explicit operator
 *   rebind, which starts a new generation (binding_fingerprint).
 * - The REQUEST LEDGER, per generation: one record per sent request id, so a
 *   retry never becomes a second message and an ambiguous send survives a
 *   reconnect.
 *
 * Nothing here holds a bearer or message text (only a payload digest). The
 * only 5.x input is a worktree's binding, read once by representative-legacy.ts
 * while no 6.x row exists (decision clean-slate-no-backwards-compat).
 */
import { type RepresentativeState, type Transaction } from './representative-db.js';
export declare function isRepresentativeUuid(value: unknown): value is string;
/**
 * Host fence for one binding generation: hex SHA-256 of the canonical JSON array
 * [origin, trustIdentity, cubeId, representativeDroneId, coordinatorDroneId,
 * boundAt]. It changes on every rebind (boundAt) and trust change, and carries
 * no path or credential.
 */
export declare function bindingFingerprint(binding: RepresentativeBinding): string;
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
    readonly state: RepresentativeState;
    /**
     * Create the state if none exists (the first generation imports 5.x
     * bindings, once). Status never calls this: it creates nothing.
     */
    initialize(): Promise<void>;
    /** Whether a generation is published. Read-only. */
    initialized(): Promise<boolean>;
    /** The worktree's binding row, or null. Read-only; never creates anything and never reads 5.x files. */
    getBinding(worktree: string): Promise<RepresentativeBinding | null>;
    /** Every binding row. Read-only. */
    listBindings(): Promise<RepresentativeBinding[]>;
    /** The current generation's ledger for a worktree. Read-only. */
    readRequests(worktree: string): Promise<RepresentativeRequestRecord[]>;
    saveBinding(binding: RepresentativeBinding, options: {
        rebind: boolean;
    }): Promise<'created' | 'unchanged' | 'rebound'>;
    /**
     * Read-compare-write over the ledger of `binding`'s generation in one
     * transaction, after checking that the generation is still the worktree's
     * CURRENT one. A stale generation refuses (BINDING_MISMATCH), or with
     * `onStale: 'skip'` changes nothing and returns undefined.
     */
    transactRequests<T>(binding: RepresentativeBinding, op: (records: RepresentativeRequestRecord[]) => T, options?: {
        onStale?: 'refuse' | 'skip';
    }): Promise<T | undefined>;
}
export declare class RepresentativeGenerationError extends Error {
    readonly code = "BINDING_MISMATCH";
    constructor(message?: string);
}
/** A binding read from any untrusted source: validated exactly as `prepare` saves one, or null. */
export declare function parseBinding(value: unknown, worktree: string): RepresentativeBinding | null;
/** The worktree's CURRENT binding row inside a transaction, or null. */
export declare function currentBindingRow(db: Transaction, worktree: string): {
    binding: RepresentativeBinding;
    generation: string;
    origin: 'prepared' | 'legacy';
} | null;
/** Refuse unless `binding`'s generation is the worktree's CURRENT one (inside the same transaction). */
export declare function requireCurrentGeneration(db: Transaction, binding: RepresentativeBinding): string;
/**
 * `origin`: 'prepared' for a binding created by this version's `prepare`
 * (its delivery starts at the binding start), 'legacy' for a 5.x binding
 * imported on first use (its start follows the 5.x delivery evidence).
 */
/**
 * A binding generation belongs to exactly one worktree: its fingerprint names
 * no worktree, so two rows with one generation would share delivery and ledger
 * state. A second worktree claiming it refuses (the schema enforces it too).
 */
export declare function insertBindingRow(db: Transaction, binding: RepresentativeBinding, seat: string, origin: 'prepared' | 'legacy'): void;
export interface RepresentativeStoreDeps {
    state: RepresentativeState;
    seatKey(binding: RepresentativeBinding): string;
}
/** The production state: its first generation is seeded once from 5.x files. */
export declare function createDefaultRepresentativeState(): RepresentativeState;
export declare function createRepresentativeStore(overrides?: Partial<RepresentativeStoreDeps>): RepresentativeStore;
//# sourceMappingURL=representative-store.d.ts.map