/**
 * Tests for `borg cleanup` (gh#882) — reap orphaned worktrees for evicted
 * drones. All git/network/fs effects are dep-injected so every branch runs
 * without a live repo, network, or $HOME.
 *
 * Coverage maps to the SEC S1–S5 gate + the QA acceptance matrix:
 *   - S1/S2 combinatorial: prune = clean AND merged AND 410-evicted; any one
 *     KEEP-class → survive.
 *   - S3 transient/pre-deploy: 401/network/indeterminate → never pruned.
 *   - S4a T-GITIGNORED-DEFAULTDENY (unknown precious ignored → blocked) +
 *     T-GITIGNORED-REGENERABLE (only allowlisted artifacts → prunes).
 *   - S4b T-FETCH-FIRST-MERGED (fetch precedes the isMerged probe).
 *   - S5 T-PATH-ANCHOR (realpath strictly under worktreesHome; escape → never).
 *   - dry-run-shows-not-acts; --prune uses no --force / no -D; self/primary/
 *     no-seat exclusion.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseCleanupArgs,
  isRegenerableIgnored,
  clobberClassIgnored,
  isStrictlyUnder,
  parseWorktreeList,
  buildCleanupReport,
  runCleanup,
  type CleanupDeps,
  type SeatStatus,
} from '../src/cleanup-cmd';
import type { RunSync } from '../src/worktree-lifecycle';
import type { ActiveCube } from '../src/cubes';

const HOME = '/home/u';
const WT_HOME = '/home/u/.borg/worktrees';
const PRIMARY = '/repo';

const seat = (projectPath: string, n: string): { projectPath: string; cube: ActiveCube } => ({
  projectPath,
  cube: { cubeId: `cube-${n}`, droneId: `drone-${n}`, sessionToken: `tok-${n}`, apiUrl: 'https://api.test' },
});

/** A recording runSync. `responder(cmd,args,cwd)` returns the result; every call is logged. */
function recordingRun(
  responder: (cmd: string, args: string[], cwd?: string) => { status: number | null; stdout: string; stderr: string }
): { run: RunSync; calls: Array<{ args: string[]; cwd?: string }> } {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const run: RunSync = (cmd, args, cwd) => {
    calls.push({ args, cwd });
    return responder(cmd, args, cwd);
  };
  return { run, calls };
}

const ok = (stdout = '') => ({ status: 0 as number | null, stdout, stderr: '' });
const fail = (stderr = 'boom') => ({ status: 1 as number | null, stdout: '', stderr });

interface WtSpec {
  path: string;
  dirty?: string;        // `git status --porcelain` output
  ignored?: string;      // `git status --porcelain --ignored` output
  merged?: boolean;      // isMerged verdict (default true)
  branch?: string;       // checked-out HEAD branch (default `wt-<basename>`); null = detached
  detached?: boolean;    // true → emit no `branch` line (detached HEAD)
}

/** Default checked-out branch a worktree dir would carry (`wt-<basename>`). */
function defaultBranch(path: string): string {
  return `wt-${path.split('/').filter(Boolean).pop()}`;
}

/**
 * Build a responder modeling the primary `/repo` + a set of worktrees.
 * Top-level git calls run with cwd=PRIMARY; per-worktree status/merge-base
 * run with cwd=<worktree path>. Each worktree emits its ACTUAL checked-out
 * branch (the gh#882 CR blocker: the gate must read this, not derive it).
 */
function makeResponder(worktrees: WtSpec[]) {
  const porcelain =
    `worktree ${PRIMARY}\nHEAD aaa\nbranch refs/heads/main\n\n` +
    worktrees
      .map((w) => {
        const branchLine = w.detached
          ? ''
          : `branch refs/heads/${w.branch ?? defaultBranch(w.path)}\n`;
        return `worktree ${w.path}\nHEAD bbb\n${branchLine}`;
      })
      .join('\n');
  const byPath = new Map(worktrees.map((w) => [w.path, w]));
  return (cmd: string, args: string[], cwd?: string) => {
    if (args.includes('--show-toplevel')) return ok(PRIMARY);
    if (args[0] === 'fetch') return ok('');
    if (args[0] === 'worktree' && args[1] === 'list') return ok(porcelain);
    if (args[0] === 'worktree' && args[1] === 'remove') return ok('');
    if (args[0] === 'branch') return ok('');
    const w = cwd ? byPath.get(cwd) : undefined;
    // git status --porcelain (classifyDirty) — NO --ignored
    if (args[0] === 'status' && args.includes('--porcelain') && !args.includes('--ignored')) {
      return ok(w?.dirty ?? '');
    }
    // git status --porcelain --ignored (clobber gate)
    if (args[0] === 'status' && args.includes('--ignored')) {
      return ok(w?.ignored ?? '');
    }
    // git merge-base --is-ancestor wtBranch origin/main (isMerged)
    if (args[0] === 'merge-base' && args.includes('--is-ancestor')) {
      return (w?.merged ?? true) ? ok() : fail();
    }
    return ok();
  };
}

function makeDeps(
  worktrees: WtSpec[],
  seats: Array<{ projectPath: string; cube: ActiveCube }>,
  probe: (token: string) => SeatStatus,
  extra: Partial<CleanupDeps> = {}
): { deps: CleanupDeps; calls: Array<{ args: string[]; cwd?: string }>; out: string[]; err: string[] } {
  const { run, calls } = recordingRun(makeResponder(worktrees));
  const out: string[] = [];
  const err: string[] = [];
  const deps: CleanupDeps = {
    runSync: run,
    homeDir: () => HOME,
    cwd: () => PRIMARY,
    listSeats: async () => seats,
    probeSeat: async (token) => probe(token),
    realpath: (p) => p, // identity (no symlinks) unless a test overrides
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...extra,
  };
  return { deps, calls, out, err };
}

// ---------------- parseCleanupArgs ----------------

describe('parseCleanupArgs', () => {
  it('defaults prune=false (dry-run)', () => {
    expect(parseCleanupArgs([])).toEqual({ ok: true, options: { prune: false } });
  });
  it('--prune sets prune=true', () => {
    expect(parseCleanupArgs(['--prune'])).toEqual({ ok: true, options: { prune: true } });
  });
  it('rejects unknown args', () => {
    const r = parseCleanupArgs(['--force']);
    expect(r.ok).toBe(false);
  });
});

// ---------------- S4a allowlist unit ----------------

describe('isRegenerableIgnored (S4a default-deny allowlist)', () => {
  it('allowlists regenerable artifacts', () => {
    for (const p of ['node_modules/', 'dist/', 'client/dist/', 'build/', '.next/', 'coverage/', '.wrangler/', '.playwright-mcp/', 'foo.log', 'x.tsbuildinfo', 'scratch.tmp', '.DS_Store', 'worker-configuration.d.ts',
      // gh#882 follow-up: `.claude/` (Claude Code per-worktree scaffolding) at
      // root + nested — segment-match covers both. Without this `borg cleanup`
      // could never prune ANY borg worktree (0 prunable / N kept).
      '.claude/', 'client/.claude/', 'landing-page/.claude/']) {
      expect(isRegenerableIgnored(p), p).toBe(true);
    }
  });
  it('treats unknown ignored paths as PRECIOUS (not regenerable)', () => {
    // NB: a bare `settings.local.json` line is still precious — git only ever
    // emits it swallowed by the collapsed `!! .claude/` dir entry, never standalone.
    // The `.claude` allowlist entry is SEGMENT-exact: near-miss names stay precious
    // (pins against a future switch to prefix/substring matching).
    for (const p of ['.env', '.env.test', '.dev.vars', 'data/', 'credentials.json', '.service-session.password', 'secret.key', 'settings.local.json',
      'my.claude.bak', '.claude.config', '.claude-old/', 'xclaude/', 'foo/.claudex/']) {
      expect(isRegenerableIgnored(p), p).toBe(false);
    }
  });
});

describe('clobberClassIgnored', () => {
  it('returns only the non-regenerable (precious) ignored paths', () => {
    const run: RunSync = () => ok('!! node_modules/\n!! dist/\n!! .env.test\n!! data/\n!! debug.log\n');
    expect(clobberClassIgnored(run, '/w')).toEqual(['.env.test', 'data/']);
  });
  it('filters .claude/ OUT (gh#882 follow-up) but still keeps precious siblings', () => {
    const run: RunSync = () => ok('!! .claude/\n!! .env.test\n!! node_modules/\n');
    expect(clobberClassIgnored(run, '/w')).toEqual(['.env.test']); // .claude/ regenerable, .env.test precious
  });
  it('fails SAFE (reports a sentinel) when git status --ignored errors', () => {
    const run: RunSync = () => fail();
    expect(clobberClassIgnored(run, '/w').length).toBe(1);
  });
});

// ---------------- S5 path anchoring ----------------

describe('isStrictlyUnder (S5)', () => {
  const id = (p: string) => p;
  it('true when strictly under', () => {
    expect(isStrictlyUnder(id, WT_HOME, `${WT_HOME}/repo/dead1`)).toBe(true);
  });
  it('false for the home dir itself', () => {
    expect(isStrictlyUnder(id, WT_HOME, WT_HOME)).toBe(false);
  });
  it('false for a path outside', () => {
    expect(isStrictlyUnder(id, WT_HOME, '/somewhere/else')).toBe(false);
  });
  it('false on symlink-escape (realpath resolves outside)', () => {
    const realpath = (p: string) => (p === `${WT_HOME}/repo/escape` ? '/evil/target' : p);
    expect(isStrictlyUnder(realpath, WT_HOME, `${WT_HOME}/repo/escape`)).toBe(false);
  });
  it('false (never under) when realpath throws', () => {
    const realpath = () => { throw new Error('ENOENT'); };
    expect(isStrictlyUnder(realpath, WT_HOME, `${WT_HOME}/x`)).toBe(false);
  });
});

describe('parseWorktreeList', () => {
  it('extracts worktree paths in order (primary first)', () => {
    expect(parseWorktreeList('worktree /repo\nHEAD a\n\nworktree /repo/wt\nHEAD b\n')).toEqual(['/repo', '/repo/wt']);
  });
});

// ---------------- classification (S1/S2 combinatorial) ----------------

describe('buildCleanupReport classification', () => {
  const dead1 = `${WT_HOME}/repo/dead1`;

  function reasonFor(spec: Partial<WtSpec>, status: SeatStatus) {
    const wt: WtSpec = { path: dead1, merged: true, ...spec };
    const { deps } = makeDeps([wt], [seat(dead1, '1')], () => status);
    return buildCleanupReport({ ...(deps as Required<CleanupDeps>) } as any).then((r) => r.rows.find((x) => x.worktreePath === dead1)?.reason);
  }

  it('PRUNABLE only when clean AND merged AND 410-evicted', async () => {
    expect(await reasonFor({}, 'evicted')).toBe('PRUNABLE');
  });
  it('SURVIVES-dirty when the tree has tracked changes (even if 410-evicted)', async () => {
    expect(await reasonFor({ dirty: ' M src/x.ts\n' }, 'evicted')).toBe('SURVIVES-dirty');
  });
  it('SURVIVES-clobber on an unknown precious gitignored file (T-GITIGNORED-DEFAULTDENY)', async () => {
    expect(await reasonFor({ ignored: '!! node_modules/\n!! .env.test\n' }, 'evicted')).toBe('SURVIVES-clobber');
  });
  it('PRUNES with only regenerable ignored artifacts (T-GITIGNORED-REGENERABLE control)', async () => {
    expect(await reasonFor({ ignored: '!! node_modules/\n!! dist/\n!! build.log\n' }, 'evicted')).toBe('PRUNABLE');
  });
  it('PRUNES an evicted worktree whose ONLY gitignored content is .claude/ (gh#882 — gate no longer inert)', async () => {
    expect(await reasonFor({ ignored: '!! .claude/\n' }, 'evicted')).toBe('PRUNABLE');
  });
  it('SURVIVES-clobber when .claude/ AND a truly-precious sibling are present (default-deny preserved)', async () => {
    expect(
      await reasonFor({ ignored: '!! .claude/\n!! credentials.json\n!! data/\n!! .env.test\n' }, 'evicted')
    ).toBe('SURVIVES-clobber');
  });
  it('SURVIVES-unmerged when the wt-branch is not merged (even if 410-evicted)', async () => {
    expect(await reasonFor({ merged: false }, 'evicted')).toBe('SURVIVES-unmerged');
  });

  // gh#882 CR BLOCKER regression-pin (dcdd7fca): the gate MUST check the
  // worktree's ACTUAL checked-out HEAD branch, not the derived `wt-<suffix>`.
  // A drone cuts feat/… off wt-<suffix> inside the worktree; the feature branch
  // carries unpushed commits while wt-<suffix> stays at the merged base. The
  // OLD code checked wt-<suffix> (merged) → PRUNABLE → unmerged feature work
  // wrongly deleted. With the fix, the actual `feat/x` (unmerged) → SURVIVES.
  it('checks the ACTUAL HEAD branch, not derived wt-<suffix>: feat/x unmerged → SURVIVES-unmerged', async () => {
    const wt = `${WT_HOME}/repo/dead1`;
    // branch=feat/x is unmerged; the DERIVED wt-dead1 would (wrongly) be merged.
    const { run, calls } = recordingRun(
      makeResponder([{ path: wt, branch: 'feat/x', merged: false }])
    );
    const out: string[] = [];
    const { rows } = await buildCleanupReport({
      runSync: run, homeDir: () => HOME, cwd: () => PRIMARY,
      listSeats: async () => [seat(wt, '1')], probeSeat: async () => 'evicted',
      realpath: (p) => p, stdout: (l) => out.push(l), stderr: () => {},
    } as any);
    expect(rows.find((r) => r.worktreePath === wt)?.reason).toBe('SURVIVES-unmerged');
    // PROOF the gate used the actual branch, not the derived wt-dead1:
    const mergeCall = calls.find((c) => c.args[0] === 'merge-base' && c.cwd === wt);
    expect(mergeCall?.args).toContain('feat/x');
    expect(mergeCall?.args).not.toContain('wt-dead1');
  });

  it('SURVIVES-detached for a detached-HEAD worktree (cannot verify merged)', async () => {
    const wt = `${WT_HOME}/repo/dead1`;
    const { deps } = makeDeps([{ path: wt, detached: true }], [seat(wt, '1')], () => 'evicted');
    const { rows } = await buildCleanupReport({ ...(deps as any) });
    expect(rows.find((r) => r.worktreePath === wt)?.reason).toBe('SURVIVES-detached');
  });
  it('SURVIVES-rejected on a pin-matched 401 (revoked/taken over) — recoverable, NEVER pruned', async () => {
    expect(await reasonFor({}, 'rejected')).toBe('SURVIVES-rejected');
  });
  it('SURVIVES-live when the seat resolves', async () => {
    expect(await reasonFor({}, 'live')).toBe('SURVIVES-live');
  });
  it('UNKNOWN-indeterminate on transient/401/pre-deploy (S3 — never delete)', async () => {
    expect(await reasonFor({}, 'indeterminate')).toBe('UNKNOWN-indeterminate');
  });

  it('UNKNOWN-no-seat for a worktreesHome dir without a saved seat', async () => {
    const wt = `${WT_HOME}/repo/noseat`;
    const { deps } = makeDeps([{ path: wt }], [], () => 'evicted');
    const { rows } = await buildCleanupReport({ ...(deps as any) });
    expect(rows.find((r) => r.worktreePath === wt)?.reason).toBe('UNKNOWN-no-seat');
  });

  it('LEGACY-manual-review for a seat outside worktreesHome (never pruned)', async () => {
    const legacy = '/old/sibling/borg-mcp-x';
    const { deps } = makeDeps([{ path: legacy }], [seat(legacy, 'L')], () => 'evicted');
    const { rows } = await buildCleanupReport({ ...(deps as any) });
    expect(rows.find((r) => r.worktreePath === legacy)?.reason).toBe('LEGACY-manual-review');
  });

  it('excludes the PRIMARY worktree from candidates entirely', async () => {
    const { deps } = makeDeps([], [], () => 'evicted');
    const { rows } = await buildCleanupReport({ ...(deps as any) });
    expect(rows.find((r) => r.worktreePath === PRIMARY)).toBeUndefined();
  });

  it('marks the current worktree SURVIVES-self (cwd === a listed worktree)', async () => {
    const self = `${WT_HOME}/repo/self`;
    const { deps } = makeDeps([{ path: self }], [seat(self, 'S')], () => 'evicted', { cwd: () => self });
    const { rows } = await buildCleanupReport({ ...(deps as any) });
    expect(rows.find((r) => r.worktreePath === self)?.reason).toBe('SURVIVES-self');
  });
});

// ---------------- S4b fetch-first ----------------

describe('T-FETCH-FIRST-MERGED (S4b)', () => {
  it('runs git fetch BEFORE any merge-base --is-ancestor probe', async () => {
    const dead1 = `${WT_HOME}/repo/dead1`;
    const { deps, calls } = makeDeps([{ path: dead1, merged: true }], [seat(dead1, '1')], () => 'evicted');
    await buildCleanupReport({ ...(deps as any) });
    const fetchIdx = calls.findIndex((c) => c.args[0] === 'fetch');
    const mergeIdx = calls.findIndex((c) => c.args[0] === 'merge-base');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(mergeIdx).toBeGreaterThan(fetchIdx);
  });

  it('aborts (exit 1) without classifying when fetch fails', async () => {
    const dead1 = `${WT_HOME}/repo/dead1`;
    const responder = (cmd: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return ok(PRIMARY);
      if (args[0] === 'fetch') return fail('offline');
      return ok();
    };
    const { run } = recordingRun(responder);
    const code = await runCleanup({
      runSync: run, homeDir: () => HOME, cwd: () => PRIMARY,
      listSeats: async () => [seat(dead1, '1')], probeSeat: async () => 'evicted',
      realpath: (p) => p, stdout: () => {}, stderr: () => {},
    }, { prune: true });
    expect(code).toBe(1);
  });
});

// ---------------- dry-run vs --prune (acts only on PRUNABLE) ----------------

describe('runCleanup prune behavior', () => {
  const dead1 = `${WT_HOME}/repo/dead1`;   // evicted → PRUNABLE
  const live2 = `${WT_HOME}/repo/live2`;   // live → SURVIVES-live

  function scenario(prune: boolean) {
    const probe = (token: string): SeatStatus => (token === 'tok-1' ? 'evicted' : 'live');
    const { deps, calls, out } = makeDeps(
      [{ path: dead1, merged: true }, { path: live2, merged: true }],
      [seat(dead1, '1'), seat(live2, '2')],
      probe
    );
    return { deps, calls, out, run: () => runCleanup(deps, { prune }) };
  }

  it('dry-run (default) deletes NOTHING — no worktree remove call', async () => {
    const { calls, run } = scenario(false);
    const code = await run();
    expect(code).toBe(0);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
  });

  it('--prune removes ONLY the PRUNABLE worktree, with no --force and no -D', async () => {
    const { calls, run } = scenario(true);
    const code = await run();
    expect(code).toBe(0);
    const removes = calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    // exactly one remove — the evicted one, never the live one
    expect(removes).toHaveLength(1);
    expect(removes[0].args).toContain(dead1);
    expect(removes[0].args).not.toContain(live2);
    // no --force on worktree remove
    expect(removes[0].args).not.toContain('--force');
    // branch deletion uses -d (safe), never -D
    const branchDeletes = calls.filter((c) => c.args[0] === 'branch');
    expect(branchDeletes.every((c) => c.args.includes('-d') && !c.args.includes('-D'))).toBe(true);
    expect(branchDeletes.some((c) => c.args.includes('wt-dead1'))).toBe(true);
  });

  it('EXECUTING --prune over a REJECTED-only fleet removes ZERO rows (rejected is recoverable, never deleted)', async () => {
    // Part (E): a pin-matched 401 (revoked/taken over) is SURVIVES-rejected, not
    // PRUNABLE. Even under --prune, no worktree remove / branch delete fires — the
    // seat is recoverable via `borg reset-local-seat` + re-enroll, never destroyed.
    const rejected1 = `${WT_HOME}/repo/rejected1`;
    const { deps, calls, out } = makeDeps(
      [{ path: rejected1, merged: true }],
      [seat(rejected1, '1')],
      () => 'rejected' as SeatStatus,
    );
    const code = await runCleanup(deps, { prune: true });
    expect(code).toBe(0);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(false);
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(false);
    expect(out.join('')).toMatch(/SURVIVES-rejected/);
    expect(out.join('')).toMatch(/Nothing to prune/i);
  });

  it('--prune also deletes the dangling derived wt-<suffix> base branch when HEAD was a feature branch (gh#884)', async () => {
    const dead = `${WT_HOME}/repo/dead1`;
    const probe = (token: string): SeatStatus => (token === 'tok-1' ? 'evicted' : 'live');
    // The worktree's ACTUAL checked-out HEAD is a feature branch, so its derived
    // base branch wt-dead1 is a SEPARATE ref that would dangle after prune.
    const { deps, calls } = makeDeps(
      [{ path: dead, merged: true, branch: 'fix/some-feature' }],
      [seat(dead, '1')],
      probe,
    );
    const code = await runCleanup(deps, { prune: true });
    expect(code).toBe(0);
    const branchDeletes = calls.filter((c) => c.args[0] === 'branch' && c.args.includes('-d'));
    // the actual feature branch is deleted...
    expect(branchDeletes.some((c) => c.args.includes('fix/some-feature'))).toBe(true);
    // ...AND the dangling derived base branch wt-dead1 is pruned too.
    expect(branchDeletes.some((c) => c.args.includes('wt-dead1'))).toBe(true);
    // never the destructive -D.
    expect(branchDeletes.every((c) => !c.args.includes('-D'))).toBe(true);
  });

  it('--prune does NOT double-delete when HEAD already IS the derived wt-<suffix> base (gh#884)', async () => {
    const dead = `${WT_HOME}/repo/dead1`;
    const probe = (token: string): SeatStatus => (token === 'tok-1' ? 'evicted' : 'live');
    // HEAD == wt-dead1 (drone never cut a feature branch) → derived === actual,
    // so only ONE `git branch -d wt-dead1` fires (guard skips the redundant one).
    const { deps, calls } = makeDeps(
      [{ path: dead, merged: true }], // default branch = wt-dead1
      [seat(dead, '1')],
      probe,
    );
    const code = await runCleanup(deps, { prune: true });
    expect(code).toBe(0);
    const wtDead1Deletes = calls.filter(
      (c) => c.args[0] === 'branch' && c.args.includes('-d') && c.args.includes('wt-dead1'),
    );
    expect(wtDead1Deletes).toHaveLength(1);
  });
});
