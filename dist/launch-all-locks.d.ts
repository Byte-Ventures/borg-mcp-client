import type { LaunchAllDeps } from './launch-all-deps.js';
export declare const LOCK_STALE_MS: number;
/** SHA-1 hex of the worktree abs path → fixed-length collision-safe filename. */
export declare function worktreeLockName(absPath: string): string;
export declare function locksDir(homeDir: string, cubeId: string): string;
export declare function lockPath(homeDir: string, cubeId: string, absPath: string): string;
export interface LockMarker {
    launchedAt: string;
    droneLabel: string;
    worktreeDir: string;
}
/** Write the launch marker (mkdir -p the cube's locks dir first). Mode 0o600. */
export declare function writeLockMarker(deps: LaunchAllDeps, cubeId: string, droneLabel: string, worktreeDir: string, launchedAtISO: string): void;
/** Delete mtime-stale (>5min) `.pid` markers in locks/<cubeId>/ (crash cleanup). */
export declare function sweepStaleLocks(deps: LaunchAllDeps, cubeId: string, nowMs: number): void;
/** True iff a fresh (<=5min by its launchedAt content) marker exists for the seat. */
export declare function isLockLive(deps: LaunchAllDeps, cubeId: string, worktreeDir: string, nowMs: number): {
    live: boolean;
    launchedAt?: string;
};
//# sourceMappingURL=launch-all-locks.d.ts.map