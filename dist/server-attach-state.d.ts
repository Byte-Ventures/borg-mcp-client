export interface LocalAttachBinding {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
}
/**
 * Stable local identity for one attach operation. The project root is captured
 * before a sibling worktree is created, so completion never depends on the
 * process's later cwd. Sibling operations deliberately live in a different
 * namespace from the durable in-place seat.
 */
export interface LocalAttachOperation {
    projectRoot: string;
    kind: 'seat' | 'sibling';
    operationKey: string;
}
/** Opaque proof returned by preparation and consumed by exact completion. */
export interface LocalAttachCompletion {
    binding: LocalAttachBinding;
    operation: LocalAttachOperation;
    retryKey: string;
}
/**
 * Load or create the non-authoritative attach correlator before any request is
 * sent. A lost response therefore reuses the exact same server binding.
 */
export declare function getOrCreateLocalAttachRetryKey(binding: LocalAttachBinding, projectRoot?: string): Promise<string>;
/**
 * Replace an evicted seat's retry correlator exactly once. Concurrent callers
 * that all observed the same evicted seat converge on the first replacement
 * instead of minting one correlator (and therefore one seat) each.
 */
export declare function replaceEvictedLocalAttachRetryKey(binding: LocalAttachBinding, expectedRetryKey: string, projectRoot?: string): Promise<string>;
export interface PendingLocalAttach {
    priorDroneId?: string;
    remintInvalidPrior: boolean;
}
/** Persist the exact attach tuple as pending before any attach request. */
export declare function prepareLocalAttachRetry(binding: LocalAttachBinding, pending: PendingLocalAttach, operation: LocalAttachOperation): Promise<string>;
/** Return an exact unfinished attach, if one exists for this request binding. */
export declare function getPendingLocalAttach(binding: LocalAttachBinding, operation: LocalAttachOperation): Promise<PendingLocalAttach | null>;
/** Mark a pending attach complete only after cubes.json accepted its session. */
export declare function completeLocalAttachRetry(completion: LocalAttachCompletion): Promise<void>;
//# sourceMappingURL=server-attach-state.d.ts.map