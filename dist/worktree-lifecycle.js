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
 *   Q3 post-merge     — auto-return to wt-<basename>; ANNOUNCE the prunable
 *                       merged branch, prune only when explicitly requested.
 *   Q4 uniform        — no primary-worktree carve-out; main is never a working branch.
 */
import { join } from 'node:path';
/**
 * Per-worktree branch name (Q1). Strips the repo basename prefix from the
 * worktree dir basename for readability (`borg-mcp-codex-builder` ->
 * `wt-codex-builder`); falls back to the full dir basename when there is
 * no shared prefix (`myrepo-feature` under repo `otherrepo` ->
 * `wt-myrepo-feature`).
 */
export function perWorktreeBranchName(worktreeBasename, repoBasename) {
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
export function worktreesHome(homeDir) {
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
export function computeWorktreePath(homeDir, repoBase, suffix, n) {
    if (suffix.length === 0) {
        throw new Error('computeWorktreePath: suffix must be non-empty (empty leaf would collapse the path to the repo-level dir)');
    }
    const leaf = n !== undefined && n >= 2 ? `${suffix}-${n}` : suffix;
    return join(worktreesHome(homeDir), repoBase, leaf);
}
/** True iff the working tree is clean (`git status --porcelain` empty). */
export function isCleanTree(runSync, cwd) {
    const r = runSync('git', ['status', '--porcelain'], cwd);
    return r.status === 0 && r.stdout.trim() === '';
}
const LOCAL_CONFIG_RE = /^\.claude\//;
/**
 * Classify a dirty tree into staged / unstaged / untracked buckets, and
 * flag local-config files separately. The STAGED bucket is load-bearing:
 * the live UNBLOCK case (b15894be) had a *staged* leftover diff that
 * blocked `pull --ff-only`, which an unstaged-only check would miss.
 */
export function classifyDirty(runSync, cwd) {
    const r = runSync('git', ['status', '--porcelain'], cwd);
    const out = { staged: [], unstaged: [], untracked: [], localConfig: [] };
    if (r.status !== 0)
        return out;
    for (const line of r.stdout.split('\n')) {
        if (!line.trim())
            continue;
        const path = line.slice(3);
        if (line.startsWith('??')) {
            out.untracked.push(path);
        }
        else {
            const x = line[0]; // staged (index) column
            const y = line[1]; // unstaged (work-tree) column
            if (x !== ' ' && x !== '?')
                out.staged.push(path);
            if (y !== ' ' && y !== '?')
                out.unstaged.push(path);
        }
        if (LOCAL_CONFIG_RE.test(path))
            out.localConfig.push(path);
    }
    return out;
}
/** True iff `branch`'s tip is an ancestor of `ref` — i.e. fully merged into it. */
export function isMerged(runSync, cwd, branch, ref) {
    return runSync('git', ['merge-base', '--is-ancestor', branch, ref], cwd).status === 0;
}
/** True iff a local branch named `branch` already exists. */
export function localBranchExists(runSync, cwd, branch) {
    return runSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], cwd).status === 0;
}
/**
 * Post-merge cleanup (Q3): when `feature` is fully merged into `ref`,
 * either ANNOUNCE it as prunable (default) or actually prune it with the
 * safe `git branch -d` (which itself refuses to delete an unmerged
 * branch — defense in depth against a stale local ref). Unmerged ->
 * not-merged (never touched).
 */
export function cleanupMerged(runSync, cwd, feature, ref, opts = { prune: false }) {
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
//# sourceMappingURL=worktree-lifecycle.js.map