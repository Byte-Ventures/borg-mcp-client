/** Native migrations are protected by an in-process semaphore, not a file lock.
 * All Borg V2 hosts share one database. Serialize their complete bootstrap so
 * migration journals and cold config watchers cannot race across launchers.
 * A data-free SQLite mutex releases automatically on process death, including
 * SIGKILL. It never opens or changes the native OpenCode database.
 * The startup supervisor owns this lock and the native child, so a launcher
 * crash cannot release exclusion before the supervisor reaps that child.
 */
export declare function withOpenCodeV2Startup<T>(operation: () => Promise<T>, options?: {
    root?: string;
    waitMs?: number;
    onQueued?: () => void;
    signal?: AbortSignal;
}): Promise<T>;
//# sourceMappingURL=opencode-v2-startup.d.ts.map