/**
 * Unit tests for the gh#33 worktree-lifecycle decision helpers.
 *
 * Every helper takes an injected `runSync`, so these tests assert the
 * exact git invocations + simulate their exit codes/output without a
 * live repo. Refinement #12 bidirectional: each git-side-effect-
 * bifurcating decision is tested in both directions.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  perWorktreeBranchName,
  computeWorktreePath,
  worktreesHome,
  isCleanTree,
  classifyDirty,
  isMerged,
  cleanupMerged,
  type RunSync,
} from '../src/worktree-lifecycle';
import { validateName } from '../src/name-validator';
import { roleSlug } from '../src/role-resolver';

/** runSync that returns a single scripted porcelain string for status. */
function fakeStatus(porcelain: string): RunSync {
  return (_cmd, args) =>
    args.join(' ') === 'status --porcelain'
      ? { status: 0, stdout: porcelain, stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
}

/**
 * Records git invocations and returns scripted results keyed by the
 * space-joined args. Unmatched keys default to {status:0, stdout:''}.
 */
function scriptedRun(results: Record<string, { status: number; stdout?: string }>) {
  const calls: string[][] = [];
  const run: RunSync = (_cmd, args) => {
    calls.push(args);
    const r = results[args.join(' ')] ?? { status: 0, stdout: '' };
    return { status: r.status, stdout: r.stdout ?? '', stderr: '' };
  };
  return { run, calls };
}

describe('perWorktreeBranchName (Q1)', () => {
  it('strips the repo prefix when the worktree dir shares it', () => {
    expect(perWorktreeBranchName('borg-mcp-codex-builder', 'borg-mcp')).toBe('wt-codex-builder');
  });
  it('falls back to the full basename when no shared prefix', () => {
    expect(perWorktreeBranchName('myrepo-feature', 'otherrepo')).toBe('wt-myrepo-feature');
  });
  it('uses full basename when dir equals repo (in-place / --here, Q6)', () => {
    expect(perWorktreeBranchName('borg-mcp', 'borg-mcp')).toBe('wt-borg-mcp');
  });
});

describe('isCleanTree', () => {
  it('true when git status --porcelain is empty', () => {
    expect(isCleanTree(fakeStatus(''), '/wt')).toBe(true);
  });
  it('false when there is any change', () => {
    expect(isCleanTree(fakeStatus(' M file.ts\n'), '/wt')).toBe(false);
  });
});

describe('classifyDirty', () => {
  it('separates staged, unstaged, and untracked', () => {
    const porcelain = 'M  staged.ts\n M unstaged.ts\n?? untracked.ts\n';
    const c = classifyDirty(fakeStatus(porcelain), '/wt');
    expect(c.staged).toEqual(['staged.ts']);
    expect(c.unstaged).toEqual(['unstaged.ts']);
    expect(c.untracked).toEqual(['untracked.ts']);
  });
  it('detects a STAGED-only change (the live UNBLOCK b15894be gap)', () => {
    // `M ` = staged modification, clean work tree. An unstaged-only check
    // would miss this — it was the exact state that blocked pull --ff-only.
    const c = classifyDirty(fakeStatus('M  landing-page/src/pages/index.astro\n'), '/wt');
    expect(c.staged).toContain('landing-page/src/pages/index.astro');
    expect(c.unstaged).toEqual([]);
  });
  it('flags local-config files (.claude/...) separately', () => {
    const c = classifyDirty(fakeStatus(' M .claude/settings.local.json\n M src/real.ts\n'), '/wt');
    expect(c.localConfig).toContain('.claude/settings.local.json');
    expect(c.localConfig).not.toContain('src/real.ts');
  });
});

describe('isMerged', () => {
  it('isMerged true when feature tip is an ancestor of origin/main', () => {
    const { run } = scriptedRun({ 'merge-base --is-ancestor fix/foo origin/main': { status: 0 } });
    expect(isMerged(run, '/wt', 'fix/foo', 'origin/main')).toBe(true);
  });
});

describe('cleanupMerged (Q3 — announce by default, prune on request)', () => {
  it('ANNOUNCES a merged branch by default (no deletion)', () => {
    const { run, calls } = scriptedRun({
      'merge-base --is-ancestor fix/foo origin/main': { status: 0 },
    });
    const res = cleanupMerged(run, '/wt', 'fix/foo', 'origin/main');
    expect(res.action).toBe('announced');
    expect(res.branch).toBe('fix/foo');
    expect(calls.some((a) => a[0] === 'branch' && a[1] === '-d')).toBe(false);
  });
  it('prunes with safe -d when prune:true', () => {
    const { run, calls } = scriptedRun({
      'merge-base --is-ancestor fix/foo origin/main': { status: 0 },
    });
    const res = cleanupMerged(run, '/wt', 'fix/foo', 'origin/main', { prune: true });
    expect(res.action).toBe('pruned');
    expect(calls).toContainEqual(['branch', '-d', 'fix/foo']);
  });
  it('does NOT touch an unmerged branch (even with prune:true)', () => {
    const { run, calls } = scriptedRun({
      'merge-base --is-ancestor fix/foo origin/main': { status: 1 },
    });
    const res = cleanupMerged(run, '/wt', 'fix/foo', 'origin/main', { prune: true });
    expect(res.action).toBe('not-merged');
    expect(calls.some((a) => a[0] === 'branch' && a[1] === '-d')).toBe(false);
  });
});

// gh#556 Part 1 — relocate NEW drone worktrees to ~/.borg/worktrees/<repo>/<name>.
describe('computeWorktreePath (gh#556 Part 1 — path scheme + collision + containment)', () => {
  const HOME = '/home/test';

  it('computes ~/.borg/worktrees/<repo>/<suffix>', () => {
    expect(computeWorktreePath(HOME, 'myrepo', 'builder')).toBe('/home/test/.borg/worktrees/myrepo/builder');
  });

  it('collision dedup appends -<n> to the LEAF (n>=2)', () => {
    expect(computeWorktreePath(HOME, 'myrepo', 'builder', 2)).toBe('/home/test/.borg/worktrees/myrepo/builder-2');
    expect(computeWorktreePath(HOME, 'myrepo', 'review-1', 3)).toBe('/home/test/.borg/worktrees/myrepo/review-1-3');
  });

  it('worktreesHome is <home>/.borg/worktrees', () => {
    expect(worktreesHome(HOME)).toBe('/home/test/.borg/worktrees');
  });

  it('CONTAINMENT: a valid suffix always resolves UNDER ~/.borg/worktrees (no traversal escape)', () => {
    const base = resolve(worktreesHome(HOME));
    for (const suffix of ['builder', 'review-1', 'codex_build', 'a', 'x'.repeat(48)]) {
      const p = resolve(computeWorktreePath(HOME, 'myrepo', suffix));
      expect(p.startsWith(base + '/')).toBe(true);
      expect(p.split('/').includes('..')).toBe(false);
    }
  });

  it('EMPTY-SUFFIX GUARD: throws on an empty leaf (would collapse the path to the repo-level dir)', () => {
    expect(() => computeWorktreePath(HOME, 'myrepo', '')).toThrow(/non-empty/);
  });
});

describe('NO-TRAVERSAL — both <suffix> sources are provably safe (gh#556 Part 1)', () => {
  it('--worktree source: validateName REJECTS dot/slash/traversal before the path is built', () => {
    expect(validateName('..').ok).toBe(false);
    expect(validateName('../evil').ok).toBe(false);
    expect(validateName('a/b').ok).toBe(false);
    expect(validateName('a.b').ok).toBe(false);
    // a legitimate name still passes
    expect(validateName('review-1').ok).toBe(true);
  });

  it('role-default source: roleSlug STRIPS dots/slashes → a malicious role name yields a safe leaf', () => {
    expect(roleSlug('../evil')).toBe('evil'); // dots + slash stripped
    expect(roleSlug('..')).toBe('');          // all-special → empty (caught by the empty-suffix guard)
    // the stripped leaf is then containment-safe
    expect(resolve(computeWorktreePath('/home/test', 'myrepo', roleSlug('../evil'))))
      .toBe('/home/test/.borg/worktrees/myrepo/evil');
  });
});

describe('wt-branch UNAFFECTED by the relocation + spawn↔lifecycle round-trip (gh#556 Part 1)', () => {
  it('new basename <suffix> maps to wt-<suffix> (== old <repo>-<suffix> basename)', () => {
    // OLD scheme: basename was `${repo}-${suffix}` → strip prefix → wt-<suffix>.
    expect(perWorktreeBranchName('myrepo-builder', 'myrepo')).toBe('wt-builder');
    // NEW scheme: basename is just `<suffix>` → no prefix → wt-<suffix> (same result).
    expect(perWorktreeBranchName('builder', 'myrepo')).toBe('wt-builder');
  });

  it('round-trip: a worktree at ~/.borg/worktrees/<repo>/<suffix> is re-derived to its spawn branch', () => {
    const repo = 'myrepo';
    const suffix = 'review-1';
    const wtPath = computeWorktreePath('/home/test', repo, suffix);
    // The lifecycle branch derivation uses the same basename rule as the spawn path.
    const leaf = wtPath.split('/').pop()!;
    expect(perWorktreeBranchName(leaf, repo)).toBe(`wt-${suffix}`); // matches the spawn branch
  });
});
