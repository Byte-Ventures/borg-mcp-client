/**
 * `borg cleanup` — reap orphaned worktrees for evicted drones (gh#882).
 *
 * An evicted drone (manual `borg_evict-drone`, watchdog
 * `autoEvictPresumedDead`, or gh#877 graceful self-shutdown) leaves its
 * worktree dir (`~/.borg/worktrees/<repo>/<name>`) + its `wt-<suffix>`
 * branch on disk. Nothing reclaims them. This command finds and SAFELY
 * removes worktrees orphaned by eviction — never destroying live,
 * dirty, unmerged, or precious-local-state work.
 *
 * Pure composition over `worktree-lifecycle.ts` + the gh#877 per-seat
 * `410 DRONE_EVICTED` discrimination (via the seat-probe seam). All git +
 * network + filesystem effects are behind injected deps so every branch is
 * unit-testable without a live repo, network, or $HOME.
 *
 * SEC gate (gh#882, S1–S5 — design entries 98e45fbf / acd76794):
 *   S1  Destructive prune authority = server 410 DRONE_EVICTED on the
 *       worktree's OWN saved-seat token, ONLY.
 *   S2  KEEP classes (any one → never prune, surface): dirty; unmerged;
 *       non-regenerable gitignored-local.
 *   S3  Report-only until gh#877 is DEPLOYED. The destructive path keys on
 *       the 410 CODE — pre-deploy the server returns 401 → probe resolves
 *       'indeterminate' → report-only → safe. No flag / deploy coupling;
 *       --prune auto-unlocks the day 410 ships.
 *   S4  (a) gitignored-aware clean-gate, DEFAULT-DENY: block on ANY
 *       gitignored-local present UNLESS it matches a curated REGENERABLE
 *       allowlist (NOT a secret denylist — that fails open). Layered here,
 *       NOT in the shared isCleanTree/classifyDirty (those feed
 *       assimilate/sync — widening them perturbs that path).
 *       (b) fetch origin/main BEFORE the isMerged gate.
 *   S5  Auto-prune strictly under canonicalized (realpath) worktreesHome —
 *       reject symlink-escape / `..`. Report MAY widen to legacy siblings
 *       outside worktreesHome (label "legacy — manual review"); report ≠ delete.
 */
import { type RunSync } from './worktree-lifecycle.js';
import { type ActiveCube } from './cubes.js';
import { type SeatStatus } from './seat-probe.js';
export type { SeatStatus };
/** Per-worktree classification outcome. PRUNABLE is the ONLY delete class. */
export type CleanupReason = 'PRUNABLE' | 'SURVIVES-dirty' | 'SURVIVES-clobber' | 'SURVIVES-unmerged' | 'SURVIVES-detached' | 'SURVIVES-live' | 'SURVIVES-self' | 'UNKNOWN-indeterminate' | 'UNKNOWN-no-seat' | 'LEGACY-manual-review';
export interface CleanupRow {
    worktreePath: string;
    wtBranch: string | null;
    reason: CleanupReason;
    /** Extra human detail (e.g. the blocking file, or the probe outcome). */
    detail?: string;
    /** Set after a --prune attempt on a PRUNABLE row. */
    prune?: 'removed' | 'remove-failed' | 'branch-delete-failed';
}
export interface CleanupDeps {
    /** Synchronous subprocess runner — `git ...`. */
    runSync?: RunSync;
    /** Resolved $HOME (worktreesHome anchor). Injected for tests. */
    homeDir?: () => string;
    /** cwd of the invocation (a git repo sharing origin). Injected for tests. */
    cwd?: () => string;
    /** Enumerate borg-managed seats from the central cubes.json. */
    listSeats?: () => Promise<Array<{
        projectPath: string;
        cube: ActiveCube;
    }>>;
    /** Probe ONE seat's eviction status using ITS OWN token (gh#877). */
    probeSeat?: (sessionToken: string, apiUrl: string, serverTrustIdentity?: string) => Promise<SeatStatus>;
    /** realpath resolver — injected so tests can model symlink escape. */
    realpath?: (p: string) => string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
}
export interface CleanupOptions {
    /** Act on PRUNABLE rows. Default false = dry-run / report only. */
    prune: boolean;
}
/** True iff a single gitignored path is a known-regenerable artifact. */
export declare function isRegenerableIgnored(ignoredPath: string): boolean;
/**
 * Return the gitignored-local paths in `cwd` that are NOT regenerable — i.e.
 * the precious-local-state files (`.env`, `.env.test`, `.dev.vars`, secrets,
 * `data/`, …) that a prune would destroy forever. Non-empty → BLOCK (S4a).
 *
 * `git status --porcelain --ignored` emits ignored entries with a `!!` status
 * prefix; git collapses an ignored directory to a single `!! dir/` entry, so
 * segment-matching the reported path against the allowlist is sufficient.
 */
export declare function clobberClassIgnored(runSync: RunSync, cwd: string): string[];
/**
 * True iff `child`'s canonicalized real path is STRICTLY under `parent`'s
 * canonicalized real path — rejecting `..` traversal AND symlink escape (a
 * symlinked worktree whose realpath is outside worktreesHome is NOT a prune
 * candidate). Returns false (never under) if either path can't be resolved.
 */
export declare function isStrictlyUnder(realpath: (p: string) => string, parent: string, child: string): boolean;
/** Parse `git worktree list --porcelain` → absolute worktree paths (in order). */
export declare function parseWorktreeList(porcelain: string): string[];
/**
 * Parse `git worktree list --porcelain` into `{path, branch}` entries (in
 * order; primary first). `branch` is the ACTUAL checked-out branch name (from
 * the `branch refs/heads/<name>` line) or null for a detached HEAD (no branch
 * line). This is load-bearing (gh#882 CR blocker dcdd7fca): a drone cuts
 * `fix/…`/`feat/…` off `wt-<suffix>` INSIDE the worktree, so the checked-out
 * HEAD is commonly a feature branch with unpushed commits while `wt-<suffix>`
 * stays at the merged base. The merged-gate + `git branch -d` MUST key on the
 * actual HEAD branch, not the derived `wt-<suffix>`, or unmerged feature work
 * is misclassified PRUNABLE.
 */
export declare function parseWorktreeEntries(porcelain: string): Array<{
    path: string;
    branch: string | null;
}>;
/**
 * Build the cleanup report (read-only except the single up-front
 * `git fetch origin`). Exported separately from the prune action so tests +
 * the dry-run path share it.
 */
export declare function buildCleanupReport(deps: Required<CleanupDeps>): Promise<{
    rows: CleanupRow[];
    error?: string;
}>;
/**
 * `borg cleanup [--prune]` entry point. Returns the process exit code.
 * Dry-run (default): print the report, delete nothing. `--prune`: additionally
 * remove PRUNABLE worktrees via `git worktree remove` (NO --force) +
 * `git branch -d` (NO -D) — git's own refusals are the final backstop.
 */
export declare function runCleanup(deps?: CleanupDeps, opts?: CleanupOptions): Promise<number>;
export type ParseResult = {
    ok: true;
    options: CleanupOptions;
} | {
    ok: false;
    error: string;
};
/** Parse args after `borg cleanup`. Supports `--prune`; rejects anything else. */
export declare function parseCleanupArgs(rawArgs: string[]): ParseResult;
//# sourceMappingURL=cleanup-cmd.d.ts.map