/** Environment names consumed by the optional foreign-path reminder hooks. */
export declare const BORG_LAUNCH_WORKTREE_ENV = "BORG_LAUNCH_WORKTREE";
export declare const BORG_LAUNCH_SCRATCH_ENV = "BORG_LAUNCH_SCRATCH";
export declare const BORG_LAUNCH_CLI_ENV = "BORG_LAUNCH_CLI";
export interface LaunchAccessPaths {
    /** The repository root whose subtree is granted to the launched harness. */
    worktree: string;
    /** The disposable scratch root reserved for this seat. */
    scratch: string;
}
/**
 * Resolve the canonical per-seat scratch root.
 *
 * Drone labels are server-derived path components in the normal flow. Keep a
 * defensive fallback for malformed labels anyway: a server value must never
 * be allowed to escape the scratch parent, and the drone id gives a stable
 * collision-resistant directory name when the label is unusable.
 */
export declare function scratchRootForSeat(homeDir: string, droneLabel: string, droneId: string): string;
/** Build Codex's native launch-time additional-directory flags. */
export declare function codexLaunchDirectoryArgs(paths: LaunchAccessPaths): string[];
//# sourceMappingURL=launch-access.d.ts.map