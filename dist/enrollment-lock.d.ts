/**
 * Serialize every authoritative enrollment read, commit, and recovery for one
 * server origin. The in-process queue also covers injected test backends; the
 * file lock is the cross-process authority in production.
 */
export declare function withEnrollmentOriginLock<T>(origin: string, operation: () => Promise<T>, options?: {
    processShared?: boolean;
}): Promise<T>;
export declare function __clearEnrollmentOriginLocksForTest(): void;
//# sourceMappingURL=enrollment-lock.d.ts.map