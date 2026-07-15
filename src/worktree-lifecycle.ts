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

import { join } from 'node:path';

/** Injected subprocess runner — matches AssimilateDeps.runSync. */
export type RunSync = (
  cmd: string,
  args: string[],
  cwd?: string
) => { status: number | null; stdout: string; stderr: string };

/**
 * Per-worktree branch name (Q1). Strips the repo basename prefix from the
 * worktree dir basename for readability (`borg-mcp-codex-builder` ->
 * `wt-codex-builder`); falls back to the full dir basename when there is
 * no shared prefix (`myrepo-feature` under repo `otherrepo` ->
 * `wt-myrepo-feature`).
 */
export function perWorktreeBranchName(worktreeBasename: string, repoBasename: string): string {
  const prefix = `${repoBasename}-`;
  const suffix = worktreeBasename.startsWith(prefix)
    ? worktreeBasename.slice(prefix.length)
    : worktreeBasename;
  return `wt-${suffix}`;
}

/**
 * gh#556 Part 1 — the home for NEW drone worktrees: `<homeDir>/.borg/worktrees`.
 * (`~/.borg` is the established borg home — it already holds the encrypted
 * credentials file, see config.ts.)
 */
export function worktreesHome(homeDir: string): string {
  return join(homeDir, '.borg', 'worktrees');
}

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
export function computeWorktreePath(
  homeDir: string,
  repoBase: string,
  suffix: string,
  n?: number
): string {
  if (suffix.length === 0) {
    throw new Error('computeWorktreePath: suffix must be non-empty (empty leaf would collapse the path to the repo-level dir)');
  }
  const leaf = n !== undefined && n >= 2 ? `${suffix}-${n}` : suffix;
  return join(worktreesHome(homeDir), repoBase, leaf);
}

/** True iff the working tree is clean (`git status --porcelain` empty). */
export function isCleanTree(runSync: RunSync, cwd: string): boolean {
  const r = runSync('git', ['status', '--porcelain'], cwd);
  return r.status === 0 && r.stdout.trim() === '';
}

export interface DirtyClassification {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** Subset that are local-only config (e.g. `.claude/...`) — likely safe to set aside. */
  localConfig: string[];
}

const LOCAL_CONFIG_RE = /^\.claude\//;

/**
 * Classify a dirty tree into staged / unstaged / untracked buckets, and
 * flag local-config files separately. The STAGED bucket is load-bearing:
 * the live UNBLOCK case (b15894be) had a *staged* leftover diff that
 * blocked `pull --ff-only`, which an unstaged-only check would miss.
 */
export function classifyDirty(runSync: RunSync, cwd: string): DirtyClassification {
  const r = runSync('git', ['status', '--porcelain'], cwd);
  const out: DirtyClassification = { staged: [], unstaged: [], untracked: [], localConfig: [] };
  if (r.status !== 0) return out;
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const path = line.slice(3);
    if (line.startsWith('??')) {
      out.untracked.push(path);
    } else {
      const x = line[0]; // staged (index) column
      const y = line[1]; // unstaged (work-tree) column
      if (x !== ' ' && x !== '?') out.staged.push(path);
      if (y !== ' ' && y !== '?') out.unstaged.push(path);
    }
    if (LOCAL_CONFIG_RE.test(path)) out.localConfig.push(path);
  }
  return out;
}

/** True iff `branch` is an ancestor of `ref` — i.e. a clean fast-forward target. */
export function isFastForward(runSync: RunSync, cwd: string, branch: string, ref: string): boolean {
  return runSync('git', ['merge-base', '--is-ancestor', branch, ref], cwd).status === 0;
}

/** True iff `branch`'s tip is an ancestor of `ref` — i.e. fully merged into it. */
export function isMerged(runSync: RunSync, cwd: string, branch: string, ref: string): boolean {
  return runSync('git', ['merge-base', '--is-ancestor', branch, ref], cwd).status === 0;
}

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
export function syncWorktree(runSync: RunSync, cwd: string, branch: string, ref: string): SyncResult {
  if (!isCleanTree(runSync, cwd)) {
    return {
      action: 'skipped-dirty',
      message: 'uncommitted changes present; sync skipped (nothing discarded)',
    };
  }
  if (!isFastForward(runSync, cwd, branch, ref)) {
    return {
      action: 'skipped-diverged',
      message: `${branch} has diverged from ${ref}; resolve manually (no auto-merge/rebase)`,
    };
  }
  // Already at ref? merge --ff-only is a no-op but we report it distinctly
  // so callers can stay quiet on the common case.
  const ahead = runSync('git', ['rev-list', '--count', `${branch}..${ref}`], cwd);
  if (ahead.status === 0 && ahead.stdout.trim() === '0') {
    return { action: 'already-current' };
  }
  const ff = runSync('git', ['merge', '--ff-only', ref], cwd);
  if (ff.status !== 0) {
    return { action: 'skipped-diverged', message: 'ff-only merge unexpectedly failed' };
  }
  return { action: 'fast-forwarded' };
}

export interface AdoptResult {
  action: 'adopted' | 'blocked-unmerged' | 'blocked-target-unmerged' | 'skipped-dirty';
  message?: string;
}

/** True iff a local branch named `branch` already exists. */
export function localBranchExists(runSync: RunSync, cwd: string, branch: string): boolean {
  return runSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd).status === 0;
}

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
export function adoptWorktree(runSync: RunSync, cwd: string, branch: string, ref: string): AdoptResult {
  if (!isCleanTree(runSync, cwd)) {
    return {
      action: 'skipped-dirty',
      message: 'uncommitted changes present; not switching (nothing discarded)',
    };
  }
  if (!isMerged(runSync, cwd, 'HEAD', ref)) {
    return {
      action: 'blocked-unmerged',
      message: `current HEAD has commits not on ${ref}; commit/push or set aside before adopting`,
    };
  }
  // Guard the TARGET branch ref before the `switch -C` force-reset. If
  // `branch` already exists and is NOT an ancestor of `ref`, it carries
  // committed-unmerged work that `-C` would discard — block instead.
  // (Absent, or an ancestor of `ref` = a clean reset target → proceed.)
  if (localBranchExists(runSync, cwd, branch) && !isMerged(runSync, cwd, branch, ref)) {
    return {
      action: 'blocked-target-unmerged',
      message: `branch ${branch} exists with commits not on ${ref}; resolve before adopting (a force-switch would discard them)`,
    };
  }
  runSync('git', ['switch', '-C', branch, ref], cwd);
  return { action: 'adopted' };
}

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
export function cleanupMerged(
  runSync: RunSync,
  cwd: string,
  feature: string,
  ref: string,
  opts: { prune: boolean } = { prune: false }
): CleanupResult {
  if (!isMerged(runSync, cwd, feature, ref)) {
    return { action: 'not-merged', branch: feature };
  }
  if (!opts.prune) {
    return {
      action: 'announced',
      branch: feature,
      message: `${feature} is merged into ${ref} and can be pruned: \`git branch -d ${feature}\` (or re-run with --prune)`,
    };
  }
  runSync('git', ['branch', '-d', feature], cwd);
  return { action: 'pruned', branch: feature };
}
