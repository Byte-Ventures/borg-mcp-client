import { readFileSync, statSync } from 'node:fs';
import {
  HEARTBEAT_STALE_MS,
  heartbeatPathFor,
  legacyHeartbeatPathFor,
  legacyPidfilePathFor,
  pidfilePathFor,
} from './inbox-monitor.js';

export type MonitorHeartbeatState = 'fresh' | 'stale' | 'missing';

export interface LiveInboxMonitor {
  pid: number;
  heartbeat: MonitorHeartbeatState;
}

export interface SeatReattachGuardDeps {
  readPidfile: (path: string) => string | null;
  readHeartbeatMtimeMs: (path: string) => number | null;
  isAlive: (pid: number) => boolean;
  now: number;
  heartbeatStaleMs?: number;
}

function parseMonitorPid(raw: string | null): number | null {
  if (raw === null) return null;
  const match = /^([1-9]\d*)(?::[^:\s]+)?$/.exec(raw.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * Read-only preflight for reusing a worktree seat. A live PID always blocks:
 * a stale heartbeat may mean the holder is wedged, but only an explicit
 * `--force` decision may launch a second session onto that seat.
 */
export function inspectLiveInboxMonitor(
  inboxPath: string,
  monitorStateRoot: string,
  deps: SeatReattachGuardDeps = defaultSeatReattachGuardDeps(),
): LiveInboxMonitor | null {
  const candidates = [
    {
      pidfile: pidfilePathFor(inboxPath, monitorStateRoot),
      heartbeat: heartbeatPathFor(inboxPath, monitorStateRoot),
    },
    {
      pidfile: legacyPidfilePathFor(inboxPath),
      heartbeat: legacyHeartbeatPathFor(inboxPath),
    },
  ];
  const staleMs = deps.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
  for (const candidate of candidates) {
    const pid = parseMonitorPid(deps.readPidfile(candidate.pidfile));
    if (pid === null || !deps.isAlive(pid)) continue;
    const heartbeatMtime = deps.readHeartbeatMtimeMs(candidate.heartbeat);
    return {
      pid,
      heartbeat: heartbeatMtime === null
        ? 'missing'
        : deps.now - heartbeatMtime < staleMs
          ? 'fresh'
          : 'stale',
    };
  }
  return null;
}

export function formatSeatReattachRefusal(
  holder: LiveInboxMonitor,
  forcedCommand: string,
): string {
  const heartbeat =
    holder.heartbeat === 'fresh'
      ? ''
      : ` Its heartbeat is ${holder.heartbeat}, so the process may be wedged.`;
  return (
    `This worktree's Borg seat already has a live session (inbox monitor pid ${holder.pid}).${heartbeat}\n` +
    'No agent was launched. Stop the existing session or use a fresh worktree with `borg assimilate --worktree <name>`. ' +
    `If the live monitor is wedged, override once with \`${forcedCommand}\`.\n`
  );
}

export function defaultSeatReattachGuardDeps(
  now: number = Date.now(),
): SeatReattachGuardDeps {
  return {
    readPidfile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    readHeartbeatMtimeMs: (path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return null;
      }
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error: any) {
        return error?.code === 'EPERM';
      }
    },
    now,
  };
}
