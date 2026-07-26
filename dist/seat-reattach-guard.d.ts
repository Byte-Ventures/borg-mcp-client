export type MonitorHeartbeatState = 'fresh' | 'stale' | 'missing';
export interface LiveInboxMonitor {
    pid: number;
    heartbeat: MonitorHeartbeatState;
}
export interface SeatReattachGuardDeps {
    readPidfile: (path: string) => string | null;
    readHeartbeatMtimeMs: (path: string) => number | null;
    isAlive: (pid: number) => boolean;
    now: number;
    heartbeatStaleMs?: number;
}
/**
 * Read-only preflight for reusing a worktree seat. A live PID always blocks:
 * a stale heartbeat may mean the holder is wedged, but only an explicit
 * `--force` decision may launch a second session onto that seat.
 */
export declare function inspectLiveInboxMonitor(inboxPath: string, monitorStateRoot: string, deps?: SeatReattachGuardDeps): LiveInboxMonitor | null;
export declare function formatSeatReattachRefusal(holder: LiveInboxMonitor, forcedCommand: string): string;
export declare function defaultSeatReattachGuardDeps(now?: number): SeatReattachGuardDeps;
//# sourceMappingURL=seat-reattach-guard.d.ts.map