export declare const STREAM_OWNER_STALE_MS = 70000;
/** Grace window for mkdir→owner.json initialization before an empty lock is reclaimable. */
export declare const STREAM_OWNER_INIT_STALE_MS = 5000;
export interface StreamOwnerRecord {
    schemaVersion: number;
    pid: number;
    processNonce: string;
    cwd: string;
    startedAt: string;
    heartbeatAt: string;
}
export interface StreamOwnershipSnapshot {
    state: 'owner' | 'owned-by-other-process' | 'initializing' | 'orphaned-initialization' | 'unowned';
    pid?: number;
    processNonce?: string;
    cwd?: string;
    startedAt?: string;
    heartbeatAt?: string;
    ageMs?: number;
    lockPath?: string;
    /** Directory mtime used to compare-before-reap an orphaned initialization. */
    lockMtimeMs?: number;
}
export interface StreamLease {
    lockPath: string;
    record: StreamOwnerRecord;
    refresh(): Promise<boolean>;
    release(): Promise<void>;
}
export interface StreamOwnerDeps {
    now?: () => Date;
    pid?: number;
    cwd?: string;
    locksDir?: string;
    processNonce?: string;
    processStartedAt?: string;
    isPidAlive?: (pid: number) => boolean;
    beforeTakeoverVerify?: (takeoverPath: string) => Promise<void>;
    /** Initialization/refresh writer seam for failure-path regression tests. */
    writeRecord?: (lockPath: string, record: StreamOwnerRecord) => Promise<void>;
}
export declare function streamLockPath(cubeId: string, droneId: string, locksDir?: string): string;
export declare function acquireStreamLease(cubeId: string, droneId: string, staleMs?: number, deps?: StreamOwnerDeps): Promise<StreamLease | null>;
export declare function readOwnershipSnapshot(cubeId: string, droneId: string, deps?: StreamOwnerDeps): Promise<StreamOwnershipSnapshot>;
//# sourceMappingURL=stream-owner.d.ts.map