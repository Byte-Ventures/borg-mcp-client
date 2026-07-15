/**
 * Tests for `borg sync` (gh#33 PR-B) — reconciled to the per-worktree
 * `wt-<suffix>` branch model. `main` is never a working branch; sync
 * keeps the wt- branch current, returns to it after a feature merges,
 * and absorbs upstream into an in-progress feature branch.
 *
 * Layered:
 *   1. parseSyncArgs — argv parsing (supports --prune)
 *   2. resolveWtBranch — DETERMINISTIC per-worktree wt- branch derivation
 *   3. detectState — lifecycle classification via stubbed runSync
 *   4. runSync — orchestrator side-effect sequence per state
 *
 * Refinement #12 bidirectional: each git-side-effect-bifurcating
 * decision is asserted in both directions (mutation vs no-mutation).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSyncArgs,
  resolveWtBranch,
  detectState,
  runSync,
  type SyncDeps,
  type SpawnSyncResult,
} from '../src/sync';
import type { RunSync } from '../src/worktree-lifecycle';

const ok = (stdout = ''): SpawnSyncResult => ({ status: 0, stdout, stderr: '' });
const err = (stderr = 'boom', status = 1): SpawnSyncResult => ({ status, stdout: '', stderr });

/** Scripted runSync keyed on the argv tail; unmatched → ok('') (clean/ancestor). */
function scripted(
  script: Array<{ match: (a: string[]) => boolean; result: SpawnSyncResult }>
): RunSync {
  return (_cmd, args) => {
    for (const e of script) if (e.match(args)) return e.result;
    return ok();
  };
}

/**
 * Standard wt- resolution stub: this worktree `/work/borg-mcp-builder2`,
 * main worktree `/work/borg-mcp` → derives `wt-builder2`. Reused by the
 * detect/orchestrator tests so the off-wt states resolve deterministically
 * (no `branch --list` — the shared-namespace trap the CR caught).
 */
const WT_RESOLUTION: Array<{ match: (a: string[]) => boolean; result: SpawnSyncResult }> = [
  { match: (a) => a.includes('--show-toplevel'), result: ok('/work/borg-mcp-builder2') },
  {
    match: (a) => a[0] === 'worktree' && a[1] === 'list',
    result: ok('worktree /work/borg-mcp\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/borg-mcp-builder2\nHEAD def\nbranch refs/heads/wt-builder2\n'),
  },
];

function makeDeps(
  script: Array<{ match: (a: string[]) => boolean; result: SpawnSyncResult }>
): Required<SyncDeps> {
  return { runSync: scripted(script), cwd: () => '/wt', stderr: () => {}, stdout: () => {} };
}

// ---------- parseSyncArgs ----------

describe('parseSyncArgs', () => {
  it('accepts zero args (prune defaults false)', () => {
    expect(parseSyncArgs([])).toEqual({ ok: true, options: { prune: false } });
  });
  it('accepts --prune', () => {
    const r = parseSyncArgs(['--prune']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.options.prune).toBe(true);
  });
  it('rejects unexpected positional', () => {
    const r = parseSyncArgs(['main']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unexpected argument: main/);
  });
  it('rejects unknown flag', () => {
    expect(parseSyncArgs(['--dry-run']).ok).toBe(false);
  });
});

// ---------- resolveWtBranch (deterministic, NOT branch --list) ----------

describe('resolveWtBranch', () => {
  it('returns the current branch when it is already wt-*', () => {
    // No git calls needed — must NOT depend on branch listing.
    const run = scripted([
      { match: () => true, result: err('should not be called', 1) },
    ]);
    expect(resolveWtBranch(run, '/wt', 'wt-codex-builder')).toBe('wt-codex-builder');
  });

  it('derives wt-<suffix> (repo-prefix stripped) in a linked worktree', () => {
    // main worktree = /work/borg-mcp ; this worktree = /work/borg-mcp-codex-builder
    const run = scripted([
      { match: (a) => a.includes('--show-toplevel'), result: ok('/work/borg-mcp-codex-builder') },
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok('worktree /work/borg-mcp\nbranch refs/heads/main\n\nworktree /work/borg-mcp-codex-builder\nbranch refs/heads/wt-codex-builder\n'),
      },
    ]);
    expect(resolveWtBranch(run, '/wt', 'main')).toBe('wt-codex-builder');
  });

  it('derives wt-<basename> (no strip) in an independent clone (single worktree)', () => {
    const run = scripted([
      { match: (a) => a.includes('--show-toplevel'), result: ok('/work/borg-mcp') },
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok('worktree /work/borg-mcp\nbranch refs/heads/main\n'),
      },
    ]);
    expect(resolveWtBranch(run, '/wt', 'main')).toBe('wt-borg-mcp');
  });

  it('is unaffected by sibling wt-* branches (no branch --list dependency)', () => {
    // Even if many wt-* branches exist (shared namespace), derivation is
    // by directory, so the result is deterministic for THIS worktree.
    const run = scripted([
      { match: (a) => a[0] === 'branch', result: ok('wt-a\nwt-b\nwt-c\n') }, // present but must be IGNORED
      { match: (a) => a.includes('--show-toplevel'), result: ok('/work/borg-mcp-codex-builder') },
      {
        match: (a) => a[0] === 'worktree' && a[1] === 'list',
        result: ok('worktree /work/borg-mcp\n\nworktree /work/borg-mcp-codex-builder\n'),
      },
    ]);
    expect(resolveWtBranch(run, '/wt', 'main')).toBe('wt-codex-builder');
  });
});

// ---------- detectState ----------

describe('detectState', () => {
  it('classifies dirty by status --porcelain', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
        { match: (a) => a[0] === 'status', result: ok(' M src/sync.ts\n?? new.txt\n') },
      ])
    );
    expect(s.kind).toBe('dirty');
    if (s.kind === 'dirty') expect(s.files).toEqual(['M src/sync.ts', '?? new.txt']);
  });

  it('classifies on-wt when current branch is wt-*', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('wt-codex-builder') },
        { match: (a) => a[0] === 'fetch', result: ok() },
      ])
    );
    expect(s.kind).toBe('on-wt');
    if (s.kind === 'on-wt') expect(s.wtBranch).toBe('wt-codex-builder');
  });

  it('classifies on-main when current branch is main', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('main') },
        { match: (a) => a[0] === 'fetch', result: ok() },
        ...WT_RESOLUTION,
      ])
    );
    expect(s.kind).toBe('on-main');
    if (s.kind === 'on-main') expect(s.wtBranch).toBe('wt-builder2');
  });

  it('classifies feature-merged when feature branch is merged into origin/main', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('fix/foo') },
        { match: (a) => a[0] === 'fetch', result: ok() },
        ...WT_RESOLUTION,
        { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() }, // merged
      ])
    );
    expect(s.kind).toBe('feature-merged');
    if (s.kind === 'feature-merged') expect(s.branch).toBe('fix/foo');
  });

  it('classifies feature-mid-sprint when not merged + origin advanced', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('feat/x') },
        { match: (a) => a[0] === 'fetch', result: ok() },
        ...WT_RESOLUTION,
        { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: err('', 1) }, // NOT merged
        { match: (a) => a[0] === 'merge-base', result: ok('base-sha') },
        { match: (a) => a[0] === 'rev-list' && a.includes('--count'), result: ok('3\n') },
      ])
    );
    expect(s.kind).toBe('feature-mid-sprint');
    if (s.kind === 'feature-mid-sprint') expect(s.commits).toBe(3);
  });

  it('errors when not a git repo', () => {
    const s = detectState(makeDeps([{ match: (a) => a.includes('--show-toplevel'), result: err('no', 128) }]));
    expect(s.kind).toBe('error');
  });

  it('errors when fetch fails (offline)', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('wt-x') },
        { match: (a) => a[0] === 'fetch', result: err('host', 128) },
      ])
    );
    expect(s.kind).toBe('error');
  });

  it('refuses detached HEAD', () => {
    const s = detectState(
      makeDeps([
        { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
        { match: (a) => a[0] === 'status', result: ok('') },
        { match: (a) => a.includes('--abbrev-ref'), result: ok('HEAD') },
      ])
    );
    expect(s.kind).toBe('error');
    if (s.kind === 'error') expect(s.reason).toMatch(/detached HEAD/);
  });
});

// ---------- runSync orchestrator ----------

function orchestrator(script: Array<{ match: (a: string[]) => boolean; result: SpawnSyncResult }>) {
  const calls: string[][] = [];
  const errLines: string[] = [];
  const outLines: string[] = [];
  const deps: SyncDeps = {
    runSync: (_cmd, args) => {
      calls.push(args);
      for (const e of script) if (e.match(args)) return e.result;
      return ok();
    },
    cwd: () => '/wt',
    stderr: (l) => errLines.push(l),
    stdout: (l) => outLines.push(l),
  };
  return { deps, calls, errLines, outLines };
}

describe('runSync orchestrator (wt- model)', () => {
  it('dirty → refuse, NO mutation', async () => {
    const { deps, calls, errLines } = orchestrator([
      { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
      { match: (a) => a[0] === 'status', result: ok(' M foo\n') },
    ]);
    const code = await runSync(deps);
    expect(code).toBe(1);
    expect(calls.some((c) => ['merge', 'switch', 'reset', 'checkout', 'pull'].includes(c[0]))).toBe(false);
    expect(errLines.join('')).toMatch(/uncommitted changes/);
  });

  it('on-wt + behind → merge --ff-only (never onto main)', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('wt-x') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() },
      { match: (a) => a[0] === 'rev-list' && a.includes('--count'), result: ok('2') },
    ]);
    const code = await runSync(deps);
    expect(code).toBe(0);
    expect(calls).toContainEqual(['merge', '--ff-only', 'origin/main']);
    expect(calls.some((c) => c[0] === 'checkout' && c.includes('main'))).toBe(false);
  });

  it('on-wt + current → no-op (no merge)', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a.includes('--show-toplevel'), result: ok('/repo') },
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('wt-x') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() },
      { match: (a) => a[0] === 'rev-list' && a.includes('--count'), result: ok('0') },
    ]);
    expect(await runSync(deps)).toBe(0);
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });

  it('on-main → adopts the wt- branch (switch -C wt- origin/main), never stays on main', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('main') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      ...WT_RESOLUTION,
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() },
      { match: (a) => a[0] === 'rev-parse' && a.includes('--verify'), result: ok('sha') },
    ]);
    const code = await runSync(deps);
    expect(code).toBe(0);
    expect(calls).toContainEqual(['switch', '-C', 'wt-builder2', 'origin/main']);
    expect(calls.some((c) => c[0] === 'checkout' && c.includes('main'))).toBe(false);
  });

  it('feature-merged (default) → adopts wt- + ANNOUNCES prune (no branch -d)', async () => {
    const { deps, calls, outLines } = orchestrator([
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('fix/foo') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      ...WT_RESOLUTION,
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() },
      { match: (a) => a[0] === 'rev-parse' && a.includes('--verify'), result: ok('sha') },
    ]);
    const code = await runSync(deps);
    expect(code).toBe(0);
    expect(calls).toContainEqual(['switch', '-C', 'wt-builder2', 'origin/main']);
    expect(calls.some((c) => c[0] === 'branch' && c.includes('-d'))).toBe(false);
    expect(outLines.join('')).toMatch(/can be pruned|fix\/foo/);
  });

  it('feature-merged + --prune → adopts wt- then prunes with safe branch -d', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('fix/foo') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      ...WT_RESOLUTION,
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: ok() },
      { match: (a) => a[0] === 'rev-parse' && a.includes('--verify'), result: ok('sha') },
    ]);
    const code = await runSync(deps, { prune: true });
    expect(code).toBe(0);
    expect(calls).toContainEqual(['switch', '-C', 'wt-builder2', 'origin/main']);
    expect(calls).toContainEqual(['branch', '-d', 'fix/foo']);
  });

  it('feature-mid-sprint + advanced → git merge --no-edit origin/main (NO rebase/force/checkout-main)', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('feat/x') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      ...WT_RESOLUTION,
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: err('', 1) },
      { match: (a) => a[0] === 'merge-base', result: ok('base') },
      { match: (a) => a[0] === 'rev-list' && a.includes('--count'), result: ok('5') },
    ]);
    const code = await runSync(deps);
    expect(code).toBe(0);
    expect(calls).toContainEqual(['merge', '--no-edit', 'origin/main']);
    expect(calls.some((c) => c[0] === 'rebase')).toBe(false);
    expect(calls.some((c) => c.some((s) => s.includes('--force')))).toBe(false);
    expect(calls.some((c) => c[0] === 'checkout' && c.includes('main'))).toBe(false);
  });

  it('feature-mid-sprint + no advance → no-op (no merge)', async () => {
    const { deps, calls } = orchestrator([
      { match: (a) => a[0] === 'status', result: ok('') },
      { match: (a) => a.includes('--abbrev-ref'), result: ok('feat/x') },
      { match: (a) => a[0] === 'fetch', result: ok() },
      ...WT_RESOLUTION,
      { match: (a) => a[0] === 'merge-base' && a.includes('--is-ancestor'), result: err('', 1) },
      { match: (a) => a[0] === 'merge-base', result: ok('base') },
      { match: (a) => a[0] === 'rev-list' && a.includes('--count'), result: ok('0') },
    ]);
    expect(await runSync(deps)).toBe(0);
    expect(calls.some((c) => c[0] === 'merge')).toBe(false);
  });
});
