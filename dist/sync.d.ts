/**
 * `borg sync` — worktree lifecycle management subcommand (gh#33).
 *
 * Reconciled to the per-worktree `wt-<suffix>` branch model (PR-B,
 * ruling ea643b33). Replaces the previous main-centric semantics
 * ("idle = on main"; "post-merge = checkout main") — under the approved
 * gh#33 model `main` is NEVER a working branch in any worktree; it is
 * purely the integration target. Every worktree works on a named
 * `wt-<suffix>` branch and `borg sync` keeps it current with
 * origin/main, returns to it after a feature branch merges, and absorbs
 * upstream into an in-progress feature branch — never touching `main`
 * as a checkout.
 *
 * All git mutation/decision logic is delegated to
 * `src/worktree-lifecycle.ts` (the seam PR-A added:
 * `adoptWorktree`, `syncWorktree`, `cleanupMerged`, `isMerged`,
 * `localBranchExists`) so the never-discard guards (dirty / unmerged
 * HEAD / unmerged target wt- branch) and the args-array subprocess
 * shape are shared, not duplicated.
 *
 * Lifecycle states:
 *   1. dirty             — uncommitted changes; refuse (never discard).
 *   2. on-wt             — on the per-worktree `wt-<suffix>` branch;
 *                          fast-forward it to origin/main (ff-only).
 *   3. on-main           — on `main`/`master` (or detached at a merged
 *                          point); adopt the `wt-<suffix>` branch
 *                          (Q4: main is never a working branch).
 *   4. feature-mid-sprint — on a feature branch not yet merged; absorb
 *                          origin/main into it via `git merge --no-edit`
 *                          (no rebase — cube workflow rule (a)) when
 *                          origin/main advanced; else no-op.
 *   5. feature-merged    — on a feature branch fully merged into
 *                          origin/main; return to `wt-<suffix>` and
 *                          ANNOUNCE the prunable feature branch (prune
 *                          only with `--prune`, Q3).
 *
 * Anti-features (intentional, unchanged):
 *   - No auto-stash / auto-commit / auto-discard on dirty tree.
 *   - No force-push, no rebase, no --force-with-lease.
 *   - No remote-branch deletion (Coordinator owns merge actions).
 *   - Local feature-branch deletion only on explicit `--prune` (Q3).
 */
import { type RunSync } from './worktree-lifecycle.js';
export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
}
export interface SyncDeps {
    /** Synchronous spawn — used for `git ...` invocations. */
    runSync?: RunSync;
    /** Inject for tests; defaults to `process.cwd()`. */
    cwd?: () => string;
    /** stderr sink — overridable for tests. */
    stderr?: (line: string) => void;
    /** stdout sink — overridable for tests. */
    stdout?: (line: string) => void;
}
export interface SyncOptions {
    /** Q3: prune a merged feature branch instead of only announcing it. */
    prune: boolean;
}
/**
 * Resolve the per-worktree `wt-` branch for the current checkout,
 * DETERMINISTICALLY per worktree.
 *
 *   - current branch is already `wt-*` → that is the branch.
 *   - otherwise → derive `wt-<suffix>` from THIS worktree's directory
 *     basename minus the main worktree's (repo) basename prefix — the
 *     same `perWorktreeBranchName` derivation the spawn path uses, so
 *     the name matches what `borg assimilate --worktree` created.
 *
 * This must NOT list `git branch --list wt-*`: in linked worktrees the
 * local branch namespace is SHARED across all siblings (gh#33 CR-v2
 * blocker 32bc45da), so every drone's `wt-` branch is visible and a
 * "single match" heuristic is never satisfied in a real multi-drone
 * cube. The directory-derivation is unique per worktree and never
 * ambiguous. The first `worktree <path>` line of
 * `git worktree list --porcelain` is the main worktree (the repo dir);
 * its basename is the prefix to strip. For an independent clone the
 * main worktree IS this worktree, so the prefix == basename and the
 * result is `wt-<basename>` (no strip) — consistent with PR-A's
 * in-place adoption.
 */
export declare function resolveWtBranch(runSync: RunSync, cwd: string, currentBranch: string): string;
export type SyncState = {
    kind: 'dirty';
    files: string[];
} | {
    kind: 'on-wt';
    branch: string;
    wtBranch: string;
} | {
    kind: 'on-main';
    branch: string;
    wtBranch: string;
} | {
    kind: 'feature-mid-sprint';
    branch: string;
    wtBranch: string;
    commits: number;
} | {
    kind: 'feature-merged';
    branch: string;
    wtBranch: string;
} | {
    kind: 'error';
    reason: string;
};
/**
 * Detect the worktree's lifecycle state. Read-only except for the
 * `git fetch origin --prune` needed to measure against the latest tip.
 */
export declare function detectState(deps: Required<SyncDeps>): SyncState;
export declare function runSync(deps?: SyncDeps, opts?: SyncOptions): Promise<number>;
export type ParseResult = {
    ok: true;
    options: SyncOptions;
} | {
    ok: false;
    error: string;
};
/**
 * Parse args after `borg sync`. Supports `--prune` (Q3: delete a merged
 * feature branch after returning to the wt- branch). Rejects anything
 * else to keep room for future flags.
 */
export declare function parseSyncArgs(rawArgs: string[]): ParseResult;
//# sourceMappingURL=sync.d.ts.map