/** §8.2 staleness threshold — ≥30 days; conservative, well beyond any plausible offline period. */
export declare const ORPHAN_INBOX_STALE_MS: number;
/** Roster signal for a drone_id. `absent` is the safe default when no roster is available. */
export type DroneRosterState = 'present' | 'evicted' | 'absent';
export interface OrphanInboxEntry {
    /** the drone_id parsed from the `<drone_id>.log` filename */
    droneId: string;
    /** absolute path to the `.log` */
    inboxPath: string;
    /** local mtime of the `.log`, in ms */
    mtimeMs: number;
}
export interface SelectOrphanInboxesArgs {
    entries: OrphanInboxEntry[];
    /** §2 HARD gate: true if ANY live-holder signal fires (pgrep / fresh-heartbeat / live-pid). */
    isLive: (inboxPath: string) => boolean;
    /** roster bonus (when available): a `present` member is never reaped. */
    droneState: (droneId: string) => DroneRosterState;
    now: number;
    staleMs: number;
}
/**
 * Pure, FS-free selection (mirrors the `acquireInboxLock` dep-injection style so
 * the live-safety + staleness logic is unit-pinned without touching the FS).
 *
 * An inbox is GC-eligible ONLY when ALL hold:
 *   §2  NO live holder              — `isLive` false (the absolute gate; one live signal vetoes)
 *   §3  mtime stale past `staleMs`  — the staleness belt (always required, even for evicted)
 *   §3.2 not a current roster member — `droneState` !== 'present' (roster bonus; 'absent' by default)
 */
export declare function selectOrphanInboxes(args: SelectOrphanInboxesArgs): OrphanInboxEntry[];
export interface InboxLivenessDeps {
    /** raw `pgrep -f <inboxPath>` match — true if a tail process is following the file (heartbeat-independent). */
    pgrepTailMatch: (inboxPath: string) => boolean;
    /** mtime (ms) of the heartbeat sidecar, or null if absent/unreadable. */
    readHeartbeatMtimeMs: (heartbeatPath: string) => number | null;
    /** parsed PID from the pidfile, or null if absent/unparseable. */
    readPidfilePid: (pidfilePath: string) => number | null;
    /** kill(pid, 0) liveness: true if the process exists. */
    isAlive: (pid: number) => boolean;
    now: number;
    heartbeatStaleMs?: number;
}
/**
 * §2 live-safety check — the HARD gate. LIVE if ANY of three INDEPENDENT signals
 * fire (so a single positive vetoes the delete):
 *   1. a raw `tail` pgrep match (a wedged-but-present tail still holds the inode → KEEP)
 *   2. a heartbeat sidecar present AND fresh (within the stale threshold)
 *   3. a pidfile whose PID is alive (kill-0)
 */
export declare function isInboxLive(inboxPath: string, deps: InboxLivenessDeps, monitorStateRoot?: string | null): boolean;
export interface OrphanGcDeps {
    /** list the `<drone_id>.log` entries in the cube inbox dir (excludes sidecars). */
    listInboxLogs: (cubeInboxDir: string) => OrphanInboxEntry[];
    isLive: (inboxPath: string) => boolean;
    droneState: (droneId: string) => DroneRosterState;
    unlink: (path: string) => void;
    now: number;
    staleMs: number;
}
/**
 * Wire the GC for one cube dir: select orphans (excluding the just-assimilated
 * drone), then unlink each orphan's inbox plus its derived worktree-runtime
 * PID/heartbeat state. Legacy inbox-adjacent artifacts are intentionally left
 * for explicit operator cleanup: GC must never race an old binary that does
 * not participate in modern state serialization. Best-effort — every unlink is
 * swallowed per-file so a
 * single failure never aborts the sweep or blocks assimilate. Returns the paths
 * actually removed. Never rmdir's the cube dir (a live sibling may use it).
 */
export declare function gcOrphanInboxesForCube(args: {
    cubeInboxDir: string;
    selfDroneId: string;
    /** Explicit current-worktree root; legacy sidecars remain untouched. */
    monitorStateRoot?: string | null;
    deps: OrphanGcDeps;
}): string[];
/** Real FS/process-backed deps, reusing the #795/#822 primitives. */
export declare function defaultInboxLivenessDeps(now?: number): InboxLivenessDeps;
/** Real directory lister: `<drone_id>.log` files only (skips `.monitor.*` sidecars). */
export declare function defaultListInboxLogs(cubeInboxDir: string): OrphanInboxEntry[];
//# sourceMappingURL=gc-orphan-inboxes.d.ts.map