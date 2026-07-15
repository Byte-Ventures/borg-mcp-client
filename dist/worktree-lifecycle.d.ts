/**
 * gh#33 — worktree lifecycle as product behavior.
 *
 * Pure git-decision helpers behind an injected `runSync` seam (matching
 * the `AssimilateDeps.runSync` shape), so every branch is unit-testable
 * without a live repo. This module DECIDES + emits git command sequences;
 * it never launches agents and never touches the cube API.
 *
 * Design spec: docs/superpowers/specs/2026-05-29-worktree-lifecycle-design.md
 * Q-resolutions baked in (SPEC-APPROVED 3a80412d):
 *   Q1 branch naming  — `wt-<suffix>` prefix-stripped, full-basename fallback.
 *   Q2 idle-sync      — ff-only, clean-gated; never merge/rebase; never over dirty.
 *   Q3 post-merge     — auto-return to wt-<basename>; ANNOUNCE the prunable
 *                       merged branch, prune only when explicitly requested.
 *   Q4 uniform        — no primary-worktree carve-out; main is never a working branch.
 */
/** Injected subprocess runner — matches AssimilateDeps.runSync. */
export type RunSync = (cmd: string, args: string[], cwd?: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
};
/**
 * Per-worktree branch name (Q1). Strips the repo basename prefix from the
 * worktree dir basename for readability (`borg-mcp-codex-builder` ->
 * `wt-codex-builder`); falls back to the full dir basename when there is
 * no shared prefix (`myrepo-feature` under repo `otherrepo` ->
 * `wt-myrepo-feature`).
 */
export declare function perWorktreeBranchName(worktreeBasename: string, repoBasename: string): string;
/**
 * gh#556 Part 1 — the home for NEW drone worktrees: `<homeDir>/.borg/worktrees`.
 * (`~/.borg` is the established borg home — it already holds the encrypted
 * credentials file, see config.ts.)
 */
export declare function worktreesHome(homeDir: string): string;
/**
 * gh#556 Part 1 — where a NEW drone worktree lives:
 * `<homeDir>/.borg/worktrees/<repoBase>/<suffix>` (collision variant `<suffix>-<n>`
 * for n>=2; the caller loops n until the path is free).
 *
 * Pure (homeDir injected) so the path scheme + collision dedup + containment are
 * unit-testable without touching $HOME or spawning git.
 *
 * Path-safety / no-traversal: `suffix` is validated upstream BEFORE it reaches here —
 * `--worktree` via validateName (NAME_RE excludes `.`/`/`) or the role default via
 * roleSlug (strips everything but `[a-z0-9-]`); `repoBase` is a single `basename(...)`
 * component. So the result is always CONTAINED under `worktreesHome(homeDir)`.
 * As defense-in-depth this throws on an EMPTY suffix — an empty leaf would let
 * `join` collapse the path up to the repo-level dir (the degenerate-path bug); the
 * caller also guards empty before calling, fail-loud.
 */
export declare function computeWorktreePath(homeDir: string, repoBase: string, suffix: string, n?: number): string;
/** True iff the working tree is clean (`git status --porcelain` empty). */
export declare function isCleanTree(runSync: RunSync, cwd: string): boolean;
export interface DirtyClassification {
    staged: string[];
    unstaged: string[];
    untracked: string[];
    /** Subset that are local-only config (e.g. `.claude/...`) — likely safe to set aside. */
    localConfig: string[];
}
/**
 * Classify a dirty tree into staged / unstaged / untracked buckets, and
 * flag local-config files separately. The STAGED bucket is load-bearing:
 * the live UNBLOCK case (b15894be) had a *staged* leftover diff that
 * blocked `pull --ff-only`, which an unstaged-only check would miss.
 */
export declare function classifyDirty(runSync: RunSync, cwd: string): DirtyClassification;
/** True iff `branch` is an ancestor of `ref` — i.e. a clean fast-forward target. */
export declare function isFastForward(runSync: RunSync, cwd: string, branch: string, ref: string): boolean;
/** True iff `branch`'s tip is an ancestor of `ref` — i.e. fully merged into it. */
export declare function isMerged(runSync: RunSync, cwd: string, branch: string, ref: string): boolean;
export interface SyncResult {
    action: 'fast-forwarded' | 'already-current' | 'skipped-dirty' | 'skipped-diverged';
    message?: string;
}
/**
 * Idle-sync the current per-worktree branch to `ref` (Q2). NEVER discards
 * work: dirty -> skipped-dirty (no mutation). Only fast-forwards (no
 * merge/rebase): diverged -> skipped-diverged. The caller fetches first.
 *
 * `already-current` when the branch tip already equals `ref` (the common
 * no-op case on every launch).
 */
export declare function syncWorktree(runSync: RunSync, cwd: string, branch: string, ref: string): SyncResult;
export interface AdoptResult {
    action: 'adopted' | 'blocked-unmerged' | 'blocked-target-unmerged' | 'skipped-dirty';
    message?: string;
}
/** True iff a local branch named `branch` already exists. */
export declare function localBranchExists(runSync: RunSync, cwd: string, branch: string): boolean;
/**
 * Migration (Q4/Q5/§4.5): bring a detached/stale worktree onto
 * `wt-<basename>` at `ref`. Idempotent: re-running on an already-adopted
 * clean worktree is a lossless reset to `ref`. Never discards:
 *   - dirty work tree            -> skipped-dirty (surface)
 *   - current HEAD unmerged      -> blocked-unmerged (surface)
 *   - TARGET `branch` exists with commits not on `ref` -> blocked-target-
 *     unmerged (surface). This is load-bearing: the switch uses `-C`
 *     (force-create/reset), which would ORPHAN commits on a pre-existing
 *     `wt-` branch. The HEAD-merged check alone misses this when the
 *     target branch != HEAD (e.g. on `main` while a prior `wt-x` holds
 *     committed-but-unmerged work). gh#33 CR-v2 blocker 078d1630.
 */
export declare function adoptWorktree(runSync: RunSync, cwd: string, branch: string, ref: string): AdoptResult;
export interface CleanupResult {
    action: 'pruned' | 'announced' | 'not-merged';
    /** The feature branch this result concerns (for the announce message). */
    branch?: string;
    message?: string;
}
/**
 * Post-merge cleanup (Q3): when `feature` is fully merged into `ref`,
 * either ANNOUNCE it as prunable (default) or actually prune it with the
 * safe `git branch -d` (which itself refuses to delete an unmerged
 * branch — defense in depth against a stale local ref). Unmerged ->
 * not-merged (never touched).
 */
export declare function cleanupMerged(runSync: RunSync, cwd: string, feature: string, ref: string, opts?: {
    prune: boolean;
}): CleanupResult;
//# sourceMappingURL=worktree-lifecycle.d.ts.map