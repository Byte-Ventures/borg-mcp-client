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

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import chalk from 'chalk';
import {
  adoptWorktree,
  syncWorktree,
  cleanupMerged,
  isMerged,
  perWorktreeBranchName,
  type RunSync,
} from './worktree-lifecycle.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

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

const defaultDeps: Required<SyncDeps> = {
  runSync: (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
    return {
      status: r.status,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
    };
  },
  cwd: () => process.cwd(),
  stderr: (line) => process.stderr.write(line),
  stdout: (line) => process.stdout.write(line),
};

const DEFAULT_BRANCH = 'origin/main';

// ------------------------------------------------------------------
// wt- branch resolution
// ------------------------------------------------------------------

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
export function resolveWtBranch(
  runSync: RunSync,
  cwd: string,
  currentBranch: string
): string {
  if (currentBranch.startsWith('wt-')) return currentBranch;
  const top = runSync('git', ['rev-parse', '--show-toplevel'], cwd);
  const thisDir = top.status === 0 ? top.stdout.trim() : cwd;
  const wtList = runSync('git', ['worktree', 'list', '--porcelain'], cwd);
  let mainDir = thisDir;
  if (wtList.status === 0) {
    const firstWorktreeLine = wtList.stdout
      .split('\n')
      .find((l) => l.startsWith('worktree '));
    if (firstWorktreeLine) mainDir = firstWorktreeLine.slice('worktree '.length).trim();
  }
  return perWorktreeBranchName(basename(thisDir), basename(mainDir));
}

// ------------------------------------------------------------------
// State detection
// ------------------------------------------------------------------

export type SyncState =
  | { kind: 'dirty'; files: string[] }
  | { kind: 'on-wt'; branch: string; wtBranch: string }
  | { kind: 'on-main'; branch: string; wtBranch: string }
  | { kind: 'feature-mid-sprint'; branch: string; wtBranch: string; commits: number }
  | { kind: 'feature-merged'; branch: string; wtBranch: string }
  | { kind: 'error'; reason: string };

/**
 * Detect the worktree's lifecycle state. Read-only except for the
 * `git fetch origin --prune` needed to measure against the latest tip.
 */
export function detectState(deps: Required<SyncDeps>): SyncState {
  const { runSync, cwd } = deps;
  const cwdValue = cwd();

  // (1) git repo?
  if (runSync('git', ['rev-parse', '--show-toplevel'], cwdValue).status !== 0) {
    return { kind: 'error', reason: `not in a git repository (cwd: ${cwdValue})` };
  }

  // (2) dirty FIRST — never act on uncommitted changes.
  const status = runSync('git', ['status', '--porcelain'], cwdValue);
  if (status.status !== 0) {
    return { kind: 'error', reason: `git status failed: ${status.stderr.trim()}` };
  }
  const dirty = status.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (dirty.length > 0) return { kind: 'dirty', files: dirty };

  // (3) current branch.
  const branchProbe = runSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwdValue);
  if (branchProbe.status !== 0) {
    return { kind: 'error', reason: `cannot resolve current branch: ${branchProbe.stderr.trim()}` };
  }
  const branch = branchProbe.stdout.trim();
  if (branch === 'HEAD') {
    return { kind: 'error', reason: 'detached HEAD; run `borg assimilate` to adopt a wt- branch first' };
  }

  // (4) fetch — fatal on failure (can't reason about lifecycle offline).
  const fetch = runSync('git', ['fetch', 'origin', '--prune'], cwdValue);
  if (fetch.status !== 0) {
    return { kind: 'error', reason: `git fetch origin failed: ${fetch.stderr.trim()}` };
  }

  const wtBranch = resolveWtBranch(runSync, cwdValue, branch);

  // (5) on the per-worktree wt- branch.
  if (branch.startsWith('wt-')) {
    return { kind: 'on-wt', branch, wtBranch: branch };
  }

  // (6) on main/master — Q4: never a working branch; adopt wt-.
  if (branch === 'main' || branch === 'master') {
    return { kind: 'on-main', branch, wtBranch };
  }

  // (7) feature branch — merged vs mid-sprint.
  // ASSUMPTION (gh#33 CR NIT 0e19637a): merged-detection keys off commit
  // ancestry (`isMerged` = HEAD is an ancestor of origin/main), which
  // holds for merge-commit / fast-forward integration. A squash- or
  // rebase-merged PR leaves the feature tip a NON-ancestor → it would
  // classify here as mid-sprint, not merged. That degrades safely
  // (merge-back of origin/main, no discard), and this cube integrates
  // via merge commits, so it is not triggered. If squash-merge is ever
  // adopted, switch this to PR-merged-state detection.
  if (isMerged(runSync, cwdValue, 'HEAD', DEFAULT_BRANCH)) {
    return { kind: 'feature-merged', branch, wtBranch };
  }
  // not merged → mid-sprint. Count how far origin/main advanced past the
  // merge-base so the message can report it (0 → no-op).
  const mergeBase = runSync('git', ['merge-base', 'HEAD', DEFAULT_BRANCH], cwdValue);
  const base = mergeBase.status === 0 ? mergeBase.stdout.trim() : '';
  const count = runSync('git', ['rev-list', '--count', `${base}..${DEFAULT_BRANCH}`], cwdValue);
  const commits = parseInt(count.stdout.trim(), 10) || 0;
  return { kind: 'feature-mid-sprint', branch, wtBranch, commits };
}

// ------------------------------------------------------------------
// Orchestrator
// ------------------------------------------------------------------

export async function runSync(deps: SyncDeps = {}, opts: SyncOptions = { prune: false }): Promise<number> {
  const merged = { ...defaultDeps, ...deps };
  const { runSync: run, cwd, stderr, stdout } = merged;
  const state = detectState(merged);

  if (state.kind === 'error') {
    stderr(chalk.red(`◼ borg sync: ${state.reason}\n`));
    return 1;
  }

  if (state.kind === 'dirty') {
    stderr(chalk.yellow(`◼ Working tree has uncommitted changes.\n`));
    for (const line of state.files.slice(0, 5)) stderr(chalk.gray(`  ${line}\n`));
    if (state.files.length > 5) stderr(chalk.gray(`  ... and ${state.files.length - 5} more\n`));
    stderr(chalk.yellow(`◼ Commit, stash, or restore before running \`borg sync\`. Nothing was changed.\n`));
    return 1;
  }

  // on-wt: fast-forward the per-worktree branch to origin/main (ff-only,
  // clean-gated, never merge/rebase). Delegates to syncWorktree.
  if (state.kind === 'on-wt') {
    const res = syncWorktree(run, cwd(), state.wtBranch, DEFAULT_BRANCH);
    if (res.action === 'fast-forwarded') {
      stdout(chalk.blue(`◼ On \`${state.wtBranch}\`; fast-forwarded to ${DEFAULT_BRANCH}.\n`));
      return 0;
    }
    if (res.action === 'already-current') {
      stdout(chalk.blue(`◼ On \`${state.wtBranch}\`; up to date with ${DEFAULT_BRANCH}.\n`));
      return 0;
    }
    // skipped-diverged: the wt- branch has local commits not on origin/main.
    stderr(chalk.yellow(`◼ ${res.message ?? 'sync skipped'}.\n`));
    return 1;
  }

  // on-main: adopt the wt- branch (Q4 — move off main). adoptWorktree
  // applies the dirty / unmerged-HEAD / unmerged-target guards.
  if (state.kind === 'on-main') {
    return adoptAndReport(state.wtBranch, run, cwd, stdout, stderr);
  }

  // feature-mid-sprint: absorb origin/main into the feature branch (no
  // rebase). Leaves the drone on the feature branch to keep working.
  if (state.kind === 'feature-mid-sprint') {
    if (state.commits === 0) {
      stdout(chalk.blue(`◼ On \`${state.branch}\` (feature branch); up to date with ${DEFAULT_BRANCH}.\n`));
      stdout(chalk.gray(`◼ Continue your sprint, or post REVIEW-READY when complete.\n`));
      return 0;
    }
    const merge = run('git', ['merge', '--no-edit', DEFAULT_BRANCH], cwd());
    if (merge.status !== 0) {
      stderr(chalk.red(`◼ borg sync: git merge ${DEFAULT_BRANCH} failed (likely conflict). Resolve manually:\n${merge.stderr.trim()}\n`));
      return 1;
    }
    stdout(chalk.blue(`◼ On \`${state.branch}\`; merged ${state.commits} commit${state.commits === 1 ? '' : 's'} from ${DEFAULT_BRANCH} (no rebase).\n`));
    stdout(chalk.gray(`◼ Re-run tests; continue your sprint.\n`));
    return 0;
  }

  // feature-merged: the PR merged. Return to the wt- branch (adopt) and
  // announce the prunable feature branch (prune only with --prune, Q3).
  if (state.kind === 'feature-merged') {
    const feature = state.branch;
    const code = adoptAndReport(state.wtBranch, run, cwd, stdout, stderr, {
      adoptedPrefix: `◼ \`${feature}\` is merged into ${DEFAULT_BRANCH};`,
    });
    if (code !== 0) return code; // adoption blocked (dirty/unmerged target) — don't prune
    // Now on the wt- branch — safe to prune/announce the merged feature.
    const cleanup = cleanupMerged(run, cwd(), feature, DEFAULT_BRANCH, { prune: opts.prune });
    if (cleanup.action === 'pruned') {
      stdout(chalk.blue(`◼ Pruned merged branch \`${feature}\`.\n`));
    } else if (cleanup.action === 'announced') {
      stdout(chalk.gray(`◼ ${cleanup.message}\n`));
    }
    return 0;
  }

  // Exhaustiveness.
  const _exhaustive: never = state;
  stderr(chalk.red(`◼ borg sync: unhandled state\n`));
  return 1;
}

/**
 * Shared adopt-the-wt-branch path for the on-main + feature-merged
 * states. Surfaces the never-discard outcomes; returns the process exit
 * code (0 adopted, 1 blocked/ambiguous).
 */
function adoptAndReport(
  wtBranch: string,
  run: RunSync,
  cwd: () => string,
  stdout: (l: string) => void,
  stderr: (l: string) => void,
  opts: { adoptedPrefix?: string } = {}
): number {
  const res = adoptWorktree(run, cwd(), wtBranch, DEFAULT_BRANCH);
  if (res.action === 'adopted') {
    if (opts.adoptedPrefix) {
      stdout(chalk.blue(`${opts.adoptedPrefix} switched to \`${wtBranch}\` at ${DEFAULT_BRANCH}.\n`));
    } else {
      stdout(chalk.blue(`◼ On \`${wtBranch}\` at ${DEFAULT_BRANCH}.\n`));
    }
    return 0;
  }
  // skipped-dirty handled upstream (dirty state), but defensively surface.
  stderr(chalk.yellow(`◼ borg sync: ${res.message ?? 'not adopted'}. Nothing was changed.\n`));
  return 1;
}

// ------------------------------------------------------------------
// CLI surface
// ------------------------------------------------------------------

export type ParseResult = { ok: true; options: SyncOptions } | { ok: false; error: string };

/**
 * Parse args after `borg sync`. Supports `--prune` (Q3: delete a merged
 * feature branch after returning to the wt- branch). Rejects anything
 * else to keep room for future flags.
 */
export function parseSyncArgs(rawArgs: string[]): ParseResult {
  let prune = false;
  for (const arg of rawArgs) {
    if (arg === '--prune') {
      prune = true;
    } else {
      return {
        ok: false,
        error: `unexpected argument: ${arg}. Usage: borg sync [--prune]`,
      };
    }
  }
  return { ok: true, options: { prune } };
}
