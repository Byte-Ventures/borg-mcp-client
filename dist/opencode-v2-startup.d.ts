/** Native migrations are protected by an in-process semaphore, not a file lock.
 * All Borg V2 hosts share one database. Serialize their complete bootstrap so
 * migration journals and cold config watchers cannot race across launchers.
 * A data-free SQLite mutex releases automatically on process death, including
 * SIGKILL. It never opens or changes the native OpenCode database.
 * Release before returning the running TUI; ordinary sessions stay concurrent.
 */
export declare function withOpenCodeV2Startup<T>(operation: () => Promise<T>, options?: {
    root?: string;
    waitMs?: number;
    onQueued?: () => void;
}): Promise<T>;
//# sourceMappingURL=opencode-v2-startup.d.ts.map