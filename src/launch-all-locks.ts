// gh#556 Part 2 — per-worktree launch lock markers (spec §6).
//
// Timestamp-based markers (the agent PID is not synchronously available when
// `borg assimilate --here` is dispatched via tmux send-keys). A marker <5min old
// means the seat appears live → skip unless --force. Markers are never deleted by
// launch-all itself; the next invocation sweeps mtime-stale (>5min) markers.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { LaunchAllDeps } from './launch-all-deps.js';

export const LOCK_STALE_MS = 5 * 60 * 1000;

/** SHA-1 hex of the worktree abs path → fixed-length collision-safe filename. */
export function worktreeLockName(absPath: string): string {
  return createHash('sha1').update(absPath, 'utf8').digest('hex');
}

export function locksDir(homeDir: string, cubeId: string): string {
  return join(homeDir, '.config', 'borgmcp', 'locks', cubeId);
}

export function lockPath(homeDir: string, cubeId: string, absPath: string): string {
  return join(locksDir(homeDir, cubeId), worktreeLockName(absPath) + '.pid');
}

export interface LockMarker {
  launchedAt: string;
  droneLabel: string;
  worktreeDir: string;
}

/** Write the launch marker (mkdir -p the cube's locks dir first). Mode 0o600. */
export function writeLockMarker(
  deps: LaunchAllDeps,
  cubeId: string,
  droneLabel: string,
  worktreeDir: string,
  launchedAtISO: string
): void {
  deps.mkdirp(locksDir(deps.homedir(), cubeId));
  const marker: LockMarker = { launchedAt: launchedAtISO, droneLabel, worktreeDir };
  deps.writeFile(lockPath(deps.homedir(), cubeId, worktreeDir), JSON.stringify(marker), 0o600);
}

/** Delete mtime-stale (>5min) `.pid` markers in locks/<cubeId>/ (crash cleanup). */
export function sweepStaleLocks(deps: LaunchAllDeps, cubeId: string, nowMs: number): void {
  const dir = locksDir(deps.homedir(), cubeId);
  for (const name of deps.listDir(dir)) {
    if (!name.endsWith('.pid')) continue;
    const p = join(dir, name);
    const mtime = deps.statMtime(p);
    if (mtime !== null && nowMs - mtime > LOCK_STALE_MS) deps.unlinkOpt(p);
  }
}

/** True iff a fresh (<=5min by its launchedAt content) marker exists for the seat. */
export function isLockLive(
  deps: LaunchAllDeps,
  cubeId: string,
  worktreeDir: string,
  nowMs: number
): { live: boolean; launchedAt?: string } {
  const raw = deps.readFileOpt(lockPath(deps.homedir(), cubeId, worktreeDir));
  if (raw === null) return { live: false };
  try {
    const marker = JSON.parse(raw) as LockMarker;
    const t = Date.parse(marker.launchedAt);
    if (!Number.isFinite(t)) return { live: false };
    return { live: nowMs - t <= LOCK_STALE_MS, launchedAt: marker.launchedAt };
  } catch {
    return { live: false };
  }
}
