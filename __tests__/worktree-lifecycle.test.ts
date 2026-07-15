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
  isFastForward,
  isMerged,
  syncWorktree,
  adoptWorktree,
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

describe('isFastForward / isMerged', () => {
  it('isFastForward true when branch is an ancestor of ref', () => {
    const { run } = scriptedRun({ 'merge-base --is-ancestor wt-x origin/main': { status: 0 } });
    expect(isFastForward(run, '/wt', 'wt-x', 'origin/main')).toBe(true);
  });
  it('isFastForward false when diverged (is-ancestor non-zero)', () => {
    const { run } = scriptedRun({ 'merge-base --is-ancestor wt-x origin/main': { status: 1 } });
    expect(isFastForward(run, '/wt', 'wt-x', 'origin/main')).toBe(false);
  });
  it('isMerged true when feature tip is an ancestor of origin/main', () => {
    const { run } = scriptedRun({ 'merge-base --is-ancestor fix/foo origin/main': { status: 0 } });
    expect(isMerged(run, '/wt', 'fix/foo', 'origin/main')).toBe(true);
  });
});

describe('syncWorktree (Q2 — ff-only, clean-gated)', () => {
  it('fast-forwards when clean + behind (ff-possible + ahead)', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor wt-x origin/main': { status: 0 },
      'rev-list --count wt-x..origin/main': { status: 0, stdout: '3' },
    });
    const res = syncWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('fast-forwarded');
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/main']);
  });

  it('reports already-current (no merge) when branch tip equals ref', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor wt-x origin/main': { status: 0 },
      'rev-list --count wt-x..origin/main': { status: 0, stdout: '0' },
    });
    const res = syncWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('already-current');
    expect(calls).not.toContainEqual(['merge', '--ff-only', 'origin/main']);
  });

  it('skips + surfaces when dirty — NO git mutation, never reset/checkout', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: ' M src/x.ts\n' },
    });
    const res = syncWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('skipped-dirty');
    expect(calls).not.toContainEqual(['merge', '--ff-only', 'origin/main']);
    expect(calls.some((a) => a[0] === 'reset')).toBe(false);
    expect(calls.some((a) => a[0] === 'checkout' && a[1] === '--')).toBe(false);
  });

  it('skips + warns when diverged (clean but not ff)', () => {
    const { run } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor wt-x origin/main': { status: 1 },
    });
    expect(syncWorktree(run, '/wt', 'wt-x', 'origin/main').action).toBe('skipped-diverged');
  });
});

describe('adoptWorktree (migration §4.5)', () => {
  it('BLOCKS when current HEAD has unmerged work (no switch, no discard)', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor HEAD origin/main': { status: 1 },
    });
    const res = adoptWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('blocked-unmerged');
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
  });
  it('adopts wt-branch when clean + HEAD merged + target absent (creates fresh)', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor HEAD origin/main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/wt-x': { status: 1 }, // target ABSENT
    });
    const res = adoptWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('adopted');
    expect(calls).toContainEqual(['switch', '-C', 'wt-x', 'origin/main']);
  });
  it('adopts (lossless reset) when target wt- exists but is merged into ref', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor HEAD origin/main': { status: 0 },
      'rev-parse --verify --quiet refs/heads/wt-x': { status: 0 }, // target EXISTS
      'merge-base --is-ancestor wt-x origin/main': { status: 0 },   // ...and is merged → safe reset
    });
    const res = adoptWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('adopted');
    expect(calls).toContainEqual(['switch', '-C', 'wt-x', 'origin/main']);
  });
  // gh#33 CR-v2 blocker 078d1630: the target wt- branch's committed-unmerged
  // work must not be force-reset away by `switch -C`.
  it('BLOCKS (no force-switch) when target wt- exists with unmerged commits', () => {
    const { run, calls } = scriptedRun({
      'status --porcelain': { status: 0, stdout: '' },
      'merge-base --is-ancestor HEAD origin/main': { status: 0 },   // HEAD (e.g. main) merged
      'rev-parse --verify --quiet refs/heads/wt-x': { status: 0 },  // target EXISTS
      'merge-base --is-ancestor wt-x origin/main': { status: 1 },   // ...with unmerged commits
    });
    const res = adoptWorktree(run, '/wt', 'wt-x', 'origin/main');
    expect(res.action).toBe('blocked-target-unmerged');
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
  });
  it('skips + surfaces when dirty (no switch)', () => {
    const { run, calls } = scriptedRun({ 'status --porcelain': { status: 0, stdout: ' M x\n' } });
    expect(adoptWorktree(run, '/wt', 'wt-x', 'origin/main').action).toBe('skipped-dirty');
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
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

describe('wt-branch UNAFFECTED by the relocation + spawn↔sync round-trip (gh#556 Part 1)', () => {
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
    // sync.ts re-derives via perWorktreeBranchName(basename(thisDir), basename(mainDir)).
    const leaf = wtPath.split('/').pop()!;
    expect(perWorktreeBranchName(leaf, repo)).toBe(`wt-${suffix}`); // matches the spawn branch
  });
});
