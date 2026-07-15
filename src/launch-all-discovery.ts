// gh#556 Part 2 — drone-worktree discovery for `borg launch-all`.
//
// Scheme-agnostic: enumerates `git worktree list --porcelain` (the authoritative
// source covering BOTH old sibling paths and new ~/.borg/worktrees/<repo>/<name>
// paths from Part 1) and cross-references ~/.config/borgmcp/cubes.json, keeping
// only worktrees whose saved identity has cubeId === target.

import type { LaunchAllDeps, RunSyncFn } from './launch-all-deps.js';

export interface DroneCandidate {
  worktreeDir: string;
  cubeId: string;
  droneId: string;
  droneLabel: string;
  sessionToken: string;
  apiUrl: string;
  serverTrustIdentity?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * --only TIER-1 (local, no server call): exact case-insensitive droneLabel match,
 * OR droneLabel prefix match (`--only drone` matches `drone-1`, `drone-2`, ...).
 * Tier-2 (role-name) matching is best-effort in the orchestrator (spec §8.4).
 */
export function matchesOnlyLabel(droneLabel: string, only: string): boolean {
  const l = droneLabel.toLowerCase();
  const o = only.toLowerCase();
  return l === o || l.startsWith(o);
}

/**
 * Enumerate the LINKED worktree paths from `git worktree list --porcelain`,
 * dropping the main worktree (always block[0]). Throws a user-readable error if
 * the command fails (not inside a git repo).
 */
export function enumerateLinkedWorktrees(runSync: RunSyncFn): string[] {
  let raw: string;
  try {
    raw = runSync('git', ['worktree', 'list', '--porcelain']);
  } catch (e) {
    throw new Error(
      `launch-all: git worktree list failed — must be run from inside a git repository\n` +
        `  (inner: ${e instanceof Error ? e.message : String(e)})`
    );
  }
  const blocks = raw.trim().split(/\n\n+/);
  // blocks[0] is the main worktree — always drop it.
  return blocks
    .slice(1)
    .map((block) => {
      const m = block.match(/^worktree (.+)$/m);
      return m ? m[1].trim() : null;
    })
    .filter((p): p is string => p !== null);
}

export interface DiscoverOpts {
  targetCubeId: string;
  /** --only filter (tier-1 label match applied here). */
  only?: string;
}

/**
 * Full discovery pipeline (spec §3.5): enumerate → cubes.json lookup → filter
 * (dir-present / has-entry / cubeId-match / UUID-valid / --only) → candidates in
 * stable porcelain order.
 */
export async function discoverDroneCandidates(
  opts: DiscoverOpts,
  deps: LaunchAllDeps
): Promise<DroneCandidate[]> {
  const worktreePaths = enumerateLinkedWorktrees((cmd, args) => deps.runSync(cmd, args));
  const identities = await deps.readAllProjectIdentities();
  const byPath = new Map(identities.map((e) => [e.projectPath, e.cube]));

  const candidates: DroneCandidate[] = [];
  for (const worktreeDir of worktreePaths) {
    // 1. directory not present on disk (orphaned worktree)
    if (!deps.pathExists(worktreeDir)) {
      deps.stderr(
        `skipping ${worktreeDir}: directory not found (orphaned worktree — run \`git worktree prune\`)\n`
      );
      continue;
    }
    // 2. no cubes.json entry → not a drone worktree; skip silently
    const cube = byPath.get(worktreeDir);
    if (!cube) continue;
    // 3. cubeId mismatch → different cube; skip silently
    if (cube.cubeId !== opts.targetCubeId) continue;
    // 4. malformed entry (cubeId/droneId not UUID) → warn + skip
    if (!isUuid(cube.cubeId) || !isUuid(cube.droneId)) {
      deps.stderr(
        `skipping ${worktreeDir}: cubes.json entry has malformed cubeId/droneId — re-assimilate to fix\n`
      );
      continue;
    }
    // 5. --only filter (tier-1 label) → skip silently (counted in the filter report)
    if (opts.only !== undefined && !matchesOnlyLabel(cube.droneLabel, opts.only)) continue;

    candidates.push({
      worktreeDir,
      cubeId: cube.cubeId,
      droneId: cube.droneId,
      droneLabel: cube.droneLabel,
      sessionToken: cube.sessionToken,
      apiUrl: cube.apiUrl,
      ...(cube.serverTrustIdentity === undefined
        ? {}
        : { serverTrustIdentity: cube.serverTrustIdentity }),
    });
  }
  return candidates;
}
