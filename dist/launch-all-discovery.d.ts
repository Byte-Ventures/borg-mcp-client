import type { LaunchAllDeps, RunSyncFn } from './launch-all-deps.js';
export interface DroneCandidate {
    worktreeDir: string;
    cubeId: string;
    droneId: string;
    droneLabel: string;
    sessionToken: string;
    apiUrl: string;
    serverTrustIdentity?: string;
}
/**
 * --only TIER-1 (local, no server call): exact case-insensitive droneLabel match,
 * OR droneLabel prefix match (`--only drone` matches `drone-1`, `drone-2`, ...).
 * Tier-2 (role-name) matching is best-effort in the orchestrator (spec §8.4).
 */
export declare function matchesOnlyLabel(droneLabel: string, only: string): boolean;
/**
 * Enumerate the LINKED worktree paths from `git worktree list --porcelain`,
 * dropping the main worktree (always block[0]). Throws a user-readable error if
 * the command fails (not inside a git repo).
 */
export declare function enumerateLinkedWorktrees(runSync: RunSyncFn): string[];
export interface DiscoverOpts {
    targetCubeId: string;
    /** --only filter (tier-1 label match applied here). */
    only?: string;
}
/**
 * Full discovery pipeline (spec §3.5): enumerate → cubes.json lookup → filter
 * (dir-present / has-entry / cubeId-match / UUID-valid / --only) → candidates in
 * stable porcelain order.
 */
export declare function discoverDroneCandidates(opts: DiscoverOpts, deps: LaunchAllDeps): Promise<DroneCandidate[]>;
//# sourceMappingURL=launch-all-discovery.d.ts.map