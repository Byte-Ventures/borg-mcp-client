/**
 * `borg cleanup` — reap orphaned worktrees for evicted drones (gh#882).
 *
 * An evicted drone (manual `borg_evict-drone`, watchdog
 * `autoEvictPresumedDead`, or gh#877 graceful self-shutdown) leaves its
 * worktree dir (`~/.borg/worktrees/<repo>/<name>`) + its `wt-<suffix>`
 * branch on disk. Nothing reclaims them. This command finds and SAFELY
 * removes worktrees orphaned by eviction — never destroying live, frozen,
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
 *   S2  KEEP classes (any one → never prune, surface): 423 DRONE_FROZEN
 *       (reversible); dirty; unmerged; non-regenerable gitignored-local.
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

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import {
  classifyDirty,
  isMerged,
  localBranchExists,
  perWorktreeBranchName,
  worktreesHome,
  type RunSync,
} from './worktree-lifecycle.js';
import {
  readAllProjectIdentities,
  type ActiveCube,
} from './cubes.js';
import { defaultProbeSeat, type SeatStatus } from './seat-probe.js';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

// SeatStatus + defaultProbeSeat were moved to seat-probe.ts so `borg launch-all`
// can reuse the probe without importing cleanup-cmd's chalk/report graph.
// Re-exported here so existing `import { SeatStatus } from './cleanup-cmd.js'`
// call sites + tests keep working unchanged.
export type { SeatStatus };

/** Per-worktree classification outcome. PRUNABLE is the ONLY delete class. */
export type CleanupReason =
  | 'PRUNABLE'
  | 'SURVIVES-dirty'
  | 'SURVIVES-clobber'
  | 'SURVIVES-unmerged'
  | 'SURVIVES-detached'
  | 'SURVIVES-frozen'
  | 'SURVIVES-live'
  | 'SURVIVES-self'
  | 'UNKNOWN-indeterminate'
  | 'UNKNOWN-no-seat'
  | 'LEGACY-manual-review';

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
  listSeats?: () => Promise<Array<{ projectPath: string; cube: ActiveCube }>>;
  /** Probe ONE seat's eviction status using ITS OWN token (gh#877). */
  probeSeat?: (sessionToken: string, apiUrl: string) => Promise<SeatStatus>;
  /** realpath resolver — injected so tests can model symlink escape. */
  realpath?: (p: string) => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface CleanupOptions {
  /** Act on PRUNABLE rows. Default false = dry-run / report only. */
  prune: boolean;
}

const DEFAULT_REF = 'origin/main';

// ------------------------------------------------------------------
// S4a — gitignored-aware clean gate (DEFAULT-DENY via regenerable allowlist)
// ------------------------------------------------------------------

/**
 * Regenerable build/scratch artifacts that are SAFE to delete with the
 * worktree (present in nearly every worktree; never precious). DEFAULT-DENY:
 * an ignored path is "regenerable" ONLY if it matches this allowlist;
 * EVERYTHING else (unknown ignored path) is assumed PRECIOUS and blocks the
 * prune. A secret-denylist would fail OPEN on an unanticipated precious file
 * (`data/`, `.dev.vars`, `credentials.json`, a private key) — so we allowlist
 * the bounded disposable set instead (SEC S4a / B24 9e79b0b1).
 */
const REGENERABLE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.wrangler',
  '.playwright-mcp',
  // gh#882 follow-up: `.claude/` is Claude Code's PER-WORKTREE scaffolding
  // (session state, scheduled-task locks, and a `settings.local.json` of
  // worktree-local permission grants). It is present in EVERY borg worktree, so
  // without this entry the S4a default-deny gate flagged it precious and `borg
  // cleanup` could NEVER prune ANY worktree (0 prunable, N kept). It is a
  // DELIBERATE, narrow carve-out: the gate only ever runs on an already-EVICTED,
  // clean, merged worktree (410 DRONE_EVICTED stays the SOLE delete authority —
  // S1), and `.claude/` is recreated on the next assimilate; its only
  // arguably-precious fragment (`settings.local.json`) is worktree-local, never
  // carries to the parent, and dies with the dead seat. git collapses an ignored
  // dir to a single `!! .claude/` porcelain line, so segment-matching `.claude`
  // here covers root + nested `<sub>/.claude/` and is the only expressible
  // granularity. A truly-precious sibling (`data/`, `credentials.json`,
  // `.env.test`, `.dev.vars`) emits its OWN `!!` line, still fails this
  // allowlist, and still → SURVIVES-clobber (T-GITIGNORED-DEFAULTDENY intact).
  // RESIDUAL RISK (accepted): any file hand-placed DIRECTLY under `.claude/` in an
  // evicted worktree is sacrificial and silently removed — `git worktree remove`
  // without `--force` does NOT refuse on ignored content, and a gitignore negation
  // (`!.claude/keep`) is inert once the parent is excluded, so the allowlist
  // decision here is the SOLE guard. Today `.claude/` is exclusively Claude Code
  // scaffolding; this comment makes the assumption auditable.
  '.claude',
]);
const REGENERABLE_FILES = new Set(['.DS_Store', 'worker-configuration.d.ts']);
const REGENERABLE_SUFFIXES = ['.log', '.tsbuildinfo', '.tmp'];

/** True iff a single gitignored path is a known-regenerable artifact. */
export function isRegenerableIgnored(ignoredPath: string): boolean {
  const clean = ignoredPath.replace(/\/+$/, ''); // strip trailing slash
  const segments = clean.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => REGENERABLE_DIRS.has(s))) return true;
  const base = segments[segments.length - 1] ?? clean;
  if (REGENERABLE_FILES.has(base)) return true;
  if (REGENERABLE_SUFFIXES.some((suf) => base.endsWith(suf))) return true;
  return false;
}

/**
 * Return the gitignored-local paths in `cwd` that are NOT regenerable — i.e.
 * the precious-local-state files (`.env`, `.env.test`, `.dev.vars`, secrets,
 * `data/`, …) that a prune would destroy forever. Non-empty → BLOCK (S4a).
 *
 * `git status --porcelain --ignored` emits ignored entries with a `!!` status
 * prefix; git collapses an ignored directory to a single `!! dir/` entry, so
 * segment-matching the reported path against the allowlist is sufficient.
 */
export function clobberClassIgnored(runSync: RunSync, cwd: string): string[] {
  const r = runSync('git', ['status', '--porcelain', '--ignored'], cwd);
  if (r.status !== 0) {
    // Cannot determine ignored state → fail SAFE: treat as "has precious"
    // so the worktree survives rather than risking a clobber.
    return ['<git status --ignored failed — cannot verify clean>'];
  }
  const precious: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('!!')) continue;
    const path = line.slice(3).trim();
    if (path.length === 0) continue;
    if (!isRegenerableIgnored(path)) precious.push(path);
  }
  return precious;
}

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------

const defaultDeps: Required<CleanupDeps> = {
  runSync: (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  homeDir: () => homedir(),
  cwd: () => process.cwd(),
  listSeats: () => readAllProjectIdentities(),
  probeSeat: defaultProbeSeat,
  realpath: (p) => realpathSync(p),
  stdout: (line) => process.stdout.write(line),
  stderr: (line) => process.stderr.write(line),
};

// (defaultProbeSeat now lives in seat-probe.ts — imported above.)

// ------------------------------------------------------------------
// Path anchoring (S5)
// ------------------------------------------------------------------

/**
 * True iff `child`'s canonicalized real path is STRICTLY under `parent`'s
 * canonicalized real path — rejecting `..` traversal AND symlink escape (a
 * symlinked worktree whose realpath is outside worktreesHome is NOT a prune
 * candidate). Returns false (never under) if either path can't be resolved.
 */
export function isStrictlyUnder(
  realpath: (p: string) => string,
  parent: string,
  child: string
): boolean {
  let rp: string;
  let rc: string;
  try {
    rp = realpath(parent);
    rc = realpath(child);
  } catch {
    return false;
  }
  if (rc === rp) return false; // the home dir itself is not "under" itself
  const prefix = rp.endsWith(sep) ? rp : rp + sep;
  return rc.startsWith(prefix);
}

// ------------------------------------------------------------------
// Enumeration
// ------------------------------------------------------------------

/** Parse `git worktree list --porcelain` → absolute worktree paths (in order). */
export function parseWorktreeList(porcelain: string): string[] {
  return parseWorktreeEntries(porcelain).map((e) => e.path);
}

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
export function parseWorktreeEntries(
  porcelain: string
): Array<{ path: string; branch: string | null }> {
  const entries: Array<{ path: string; branch: string | null }> = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null };
    } else if (line.startsWith('branch ') && cur) {
      // `branch refs/heads/<name>` → <name>. A detached worktree emits
      // `detached` (or no branch line) → branch stays null.
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

// ------------------------------------------------------------------
// Classification (per worktree)
// ------------------------------------------------------------------

/**
 * Classify ONE borg-managed worktree (cheap-first gate order; the FIRST
 * KEEP-class short-circuits — a transient probe failure on a dirty/unmerged
 * tree never even reaches the network). Only `PRUNABLE` authorizes a delete.
 */
async function classifyWorktree(
  deps: Required<CleanupDeps>,
  worktreePath: string,
  actualBranch: string | null,
  seat: ActiveCube
): Promise<{ reason: CleanupReason; detail?: string }> {
  const { runSync } = deps;

  // (1) dirty — tracked staged/unstaged/untracked. KEEP.
  const dirty = classifyDirty(runSync, worktreePath);
  const dirtyCount =
    dirty.staged.length + dirty.unstaged.length + dirty.untracked.length;
  if (dirtyCount > 0) {
    return { reason: 'SURVIVES-dirty', detail: `${dirtyCount} uncommitted file(s)` };
  }

  // (2) S4a — gitignored precious-local present (the clobber class). KEEP.
  const precious = clobberClassIgnored(runSync, worktreePath);
  if (precious.length > 0) {
    return {
      reason: 'SURVIVES-clobber',
      detail: `gitignored local state: ${precious.slice(0, 3).join(', ')}${precious.length > 3 ? ` (+${precious.length - 3})` : ''}`,
    };
  }

  // (3) detached HEAD — no branch to verify merged-state against. Cannot
  // prove the work is safely on origin/main → KEEP (gh#882 CR blocker).
  if (actualBranch === null) {
    return { reason: 'SURVIVES-detached', detail: 'detached HEAD — cannot verify merged' };
  }

  // (4) unmerged — the worktree's ACTUAL checked-out branch has commits not on
  // origin/main (fetch already ran ONCE globally — S4b). This MUST key on the
  // real HEAD branch, not the derived `wt-<suffix>`: a drone cuts feature
  // branches off wt-<suffix> inside the worktree, so checking wt-<suffix>
  // (which stays at the merged base) would miss unpushed feature work and
  // misclassify it PRUNABLE (gh#882 CR blocker dcdd7fca). KEEP.
  if (!isMerged(runSync, worktreePath, actualBranch, DEFAULT_REF)) {
    return { reason: 'SURVIVES-unmerged', detail: `${actualBranch} not merged into ${DEFAULT_REF}` };
  }

  // (5) ONLY now probe eviction with the worktree's OWN seat token (S1).
  const status = await deps.probeSeat(seat.sessionToken, seat.apiUrl);
  switch (status) {
    case 'evicted':
      return { reason: 'PRUNABLE', detail: '410 DRONE_EVICTED (clean + merged)' };
    case 'frozen':
      return { reason: 'SURVIVES-frozen', detail: '423 DRONE_FROZEN (reversible)' };
    case 'live':
      return { reason: 'SURVIVES-live', detail: 'seat resolves (drone alive)' };
    case 'indeterminate':
    default:
      return {
        reason: 'UNKNOWN-indeterminate',
        detail: 'probe returned 401/network/transient (or gh#877 not yet deployed) — not deleting',
      };
  }
}

// ------------------------------------------------------------------
// Orchestrator
// ------------------------------------------------------------------

/**
 * Build the cleanup report (read-only except the single up-front
 * `git fetch origin`). Exported separately from the prune action so tests +
 * the dry-run path share it.
 */
export async function buildCleanupReport(
  deps: Required<CleanupDeps>
): Promise<{ rows: CleanupRow[]; error?: string }> {
  const { runSync, realpath } = deps;
  const cwd = deps.cwd();

  if (runSync('git', ['rev-parse', '--show-toplevel'], cwd).status !== 0) {
    return { rows: [], error: `not in a git repository (cwd: ${cwd})` };
  }

  // S4b — fetch origin ONCE up front so every per-worktree isMerged gate runs
  // against a fresh origin/main (the ref is shared across linked worktrees).
  // Fatal: a stale origin/main makes an unpushed wt-branch look merged.
  const fetch = runSync('git', ['fetch', 'origin', '--prune'], cwd);
  if (fetch.status !== 0) {
    return { rows: [], error: `git fetch origin failed: ${fetch.stderr.trim()}` };
  }

  const wtList = runSync('git', ['worktree', 'list', '--porcelain'], cwd);
  if (wtList.status !== 0) {
    return { rows: [], error: `git worktree list failed: ${wtList.stderr.trim()}` };
  }
  const wtEntries = parseWorktreeEntries(wtList.stdout);
  const branchByPath = new Map(wtEntries.map((e) => [e.path, e.branch]));
  const allWorktrees = wtEntries.map((e) => e.path);
  const mainDir = allWorktrees[0]; // porcelain lists the primary worktree first
  const home = deps.homeDir();
  const wtHome = worktreesHome(home);

  // Self + primary are never orphan candidates.
  const selfReal = safeRealpath(realpath, cwd);
  const mainReal = mainDir ? safeRealpath(realpath, mainDir) : null;

  // Seat lookup keyed by realpath(projectPath) so symlinked/relative entries
  // still match the enumerated worktree path.
  const seats = await deps.listSeats();
  const seatByReal = new Map<string, ActiveCube>();
  for (const { projectPath, cube } of seats) {
    const real = safeRealpath(realpath, projectPath);
    if (real) seatByReal.set(real, cube);
  }

  const rows: CleanupRow[] = [];
  for (const wt of allWorktrees) {
    const real = safeRealpath(realpath, wt);
    if (!real) continue; // gone from disk — git will report it as prunable itself
    if (mainReal && real === mainReal) continue; // primary worktree — never a candidate
    const seat = seatByReal.get(real);
    const under = isStrictlyUnder(realpath, wtHome, wt);

    // Self (the running worktree): surface but never prune (can't remove the
    // current worktree; the seat probe would also report it live).
    if (real === selfReal) {
      rows.push({ worktreePath: wt, wtBranch: null, reason: 'SURVIVES-self', detail: 'current worktree' });
      continue;
    }

    if (!under) {
      // Outside worktreesHome. A seat'd worktree here is a legacy pre-gh#556
      // sibling → REPORT for manual review, never auto-prune (S5). No seat →
      // an arbitrary user worktree we never touch or list.
      if (seat) {
        rows.push({ worktreePath: wt, wtBranch: null, reason: 'LEGACY-manual-review', detail: 'borg seat outside worktreesHome (pre-gh#556 sibling)' });
      }
      continue;
    }

    // Under worktreesHome but no saved seat → not eviction-orphaned
    // (pre-assimilate or hand-made). Report, never auto-prune.
    if (!seat) {
      rows.push({ worktreePath: wt, wtBranch: null, reason: 'UNKNOWN-no-seat', detail: 'no cubes.json seat — manual review' });
      continue;
    }

    // Use the worktree's ACTUAL checked-out HEAD branch (from porcelain) for
    // BOTH the merged-gate and the eventual `git branch -d` — NOT the derived
    // `wt-<suffix>` (gh#882 CR blocker dcdd7fca). null = detached HEAD → KEEP.
    const actualBranch = branchByPath.get(wt) ?? null;
    const { reason, detail } = await classifyWorktree(deps, wt, actualBranch, seat);
    rows.push({ worktreePath: wt, wtBranch: actualBranch, reason, detail });
  }

  return { rows };
}

function safeRealpath(realpath: (p: string) => string, p: string): string | null {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/**
 * `borg cleanup [--prune]` entry point. Returns the process exit code.
 * Dry-run (default): print the report, delete nothing. `--prune`: additionally
 * remove PRUNABLE worktrees via `git worktree remove` (NO --force) +
 * `git branch -d` (NO -D) — git's own refusals are the final backstop.
 */
export async function runCleanup(
  deps: CleanupDeps = {},
  opts: CleanupOptions = { prune: false }
): Promise<number> {
  const merged: Required<CleanupDeps> = { ...defaultDeps, ...deps };
  const { stdout, stderr, runSync } = merged;

  const { rows, error } = await buildCleanupReport(merged);
  if (error) {
    stderr(chalk.red(`◼ borg cleanup: ${error}\n`));
    return 1;
  }

  const prunable = rows.filter((r) => r.reason === 'PRUNABLE');
  const survivors = rows.filter((r) => r.reason !== 'PRUNABLE');

  // --- Report (always) ---
  if (rows.length === 0) {
    stdout(chalk.blue('◼ borg cleanup: no borg-managed worktrees found.\n'));
    return 0;
  }
  stdout(chalk.bold('◼ borg cleanup report:\n'));
  for (const r of rows) {
    const tag = r.reason === 'PRUNABLE' ? chalk.yellow(r.reason) : chalk.gray(r.reason);
    stdout(`  ${tag}  ${r.worktreePath}${r.detail ? chalk.gray(`  — ${r.detail}`) : ''}\n`);
  }
  stdout(chalk.gray(`◼ ${prunable.length} prunable, ${survivors.length} kept.\n`));

  if (!opts.prune) {
    if (prunable.length > 0) {
      stdout(chalk.gray('◼ Dry-run — nothing deleted. Re-run with `--prune` to remove the PRUNABLE worktree(s).\n'));
    }
    return 0;
  }

  // --- Prune (PRUNABLE only) ---
  if (prunable.length === 0) {
    stdout(chalk.blue('◼ Nothing to prune.\n'));
    return 0;
  }
  let removed = 0;
  let failed = 0;
  for (const r of prunable) {
    // git worktree remove WITHOUT --force (refuses a dirty/locked worktree —
    // backstop even past our gates).
    const rm = runSync('git', ['worktree', 'remove', r.worktreePath], merged.cwd());
    if (rm.status !== 0) {
      r.prune = 'remove-failed';
      failed++;
      stderr(chalk.red(`  ✗ worktree remove ${r.worktreePath}: ${rm.stderr.trim()}\n`));
      continue;
    }
    // git branch -d (NOT -D) — refuses an unmerged branch (backstop).
    if (r.wtBranch) {
      const bd = runSync('git', ['branch', '-d', r.wtBranch], merged.cwd());
      if (bd.status !== 0) {
        r.prune = 'branch-delete-failed';
        stderr(chalk.yellow(`  ⚠ removed worktree but \`git branch -d ${r.wtBranch}\` refused: ${bd.stderr.trim()}\n`));
        removed++;
        continue;
      }
    }
    // gh#884: r.wtBranch is the worktree's ACTUAL checked-out HEAD (often a
    // feature branch the drone cut). The DERIVED per-worktree base branch
    // `wt-<suffix>` — created by `borg assimilate`, the base feature branches
    // were cut from — is a SEPARATE ref left dangling once the worktree is
    // gone. Prune it too when it still exists and is merged into origin/main
    // (skip when it IS r.wtBranch, already deleted above). `git branch -d`
    // (NOT -D) backstops the merged + not-checked-out guards.
    let baseNote = '';
    const derivedWtBranch = perWorktreeBranchName(
      basename(r.worktreePath),
      basename(dirname(r.worktreePath))
    );
    if (
      derivedWtBranch !== r.wtBranch &&
      localBranchExists(runSync, merged.cwd(), derivedWtBranch) &&
      isMerged(runSync, merged.cwd(), derivedWtBranch, DEFAULT_REF)
    ) {
      const bdBase = runSync('git', ['branch', '-d', derivedWtBranch], merged.cwd());
      if (bdBase.status === 0) {
        baseNote = ` + base ${derivedWtBranch}`;
      } else {
        stderr(chalk.yellow(`  ⚠ left dangling base branch ${derivedWtBranch}: \`git branch -d\` refused: ${bdBase.stderr.trim()}\n`));
      }
    }
    r.prune = 'removed';
    removed++;
    stdout(chalk.blue(`  ✓ pruned ${r.worktreePath}${r.wtBranch ? ` + branch ${r.wtBranch}` : ''}${baseNote}\n`));
  }
  stdout(chalk.gray(`◼ Pruned ${removed} worktree(s)${failed > 0 ? `, ${failed} failed` : ''}.\n`));
  return failed > 0 ? 1 : 0;
}

// ------------------------------------------------------------------
// CLI surface
// ------------------------------------------------------------------

export type ParseResult =
  | { ok: true; options: CleanupOptions }
  | { ok: false; error: string };

/** Parse args after `borg cleanup`. Supports `--prune`; rejects anything else. */
export function parseCleanupArgs(rawArgs: string[]): ParseResult {
  let prune = false;
  for (const arg of rawArgs) {
    if (arg === '--prune') {
      prune = true;
    } else {
      return { ok: false, error: `unexpected argument: ${arg}. Usage: borg cleanup [--prune]` };
    }
  }
  return { ok: true, options: { prune } };
}
