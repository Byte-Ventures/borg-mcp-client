import { describe, it, expect } from 'vitest';
import {
  selectOrphanInboxes,
  isInboxLive,
  gcOrphanInboxesForCube,
  defaultListInboxLogs,
  ORPHAN_INBOX_STALE_MS,
  type InboxLivenessDeps,
  type OrphanInboxEntry,
} from '../src/gc-orphan-inboxes';
import {
  pidfilePathFor,
  heartbeatPathFor,
  legacyPidfilePathFor,
  HEARTBEAT_STALE_MS,
} from '../src/inbox-monitor';

const NOW = 1_000_000_000_000;
const STALE = ORPHAN_INBOX_STALE_MS;
const old = (ms = STALE + 1) => NOW - ms; // an mtime that is `ms` old

// liveness deps with every signal NEGATIVE; override one per test
const deadDeps = (over: Partial<InboxLivenessDeps> = {}): InboxLivenessDeps => ({
  pgrepTailMatch: () => false,
  readHeartbeatMtimeMs: () => null,
  readPidfilePid: () => null,
  isAlive: () => false,
  now: NOW,
  ...over,
});

describe('gh#793 isInboxLive — the HARD live-safety gate (each signal independently)', () => {
  const p = '/inboxes/cube/d.log';

  it('LIVE via a raw pgrep tail-match alone', () => {
    expect(isInboxLive(p, deadDeps({ pgrepTailMatch: () => true }))).toBe(true);
  });

  it('LIVE via a fresh heartbeat alone (within HEARTBEAT_STALE_MS)', () => {
    const fresh = NOW - (HEARTBEAT_STALE_MS - 1);
    expect(isInboxLive(p, deadDeps({ readHeartbeatMtimeMs: () => fresh }))).toBe(true);
  });

  it('LIVE via a live pidfile alone (kill-0)', () => {
    expect(isInboxLive(p, deadDeps({ readPidfilePid: () => 4242, isAlive: () => true }))).toBe(true);
  });

  it('NOT live when every signal is negative', () => {
    expect(isInboxLive(p, deadDeps())).toBe(false);
  });

  it('a STALE heartbeat is not a live signal (present but past the threshold)', () => {
    const staleHb = NOW - (HEARTBEAT_STALE_MS + 1);
    expect(isInboxLive(p, deadDeps({ readHeartbeatMtimeMs: () => staleHb }))).toBe(false);
  });

  it('a DEAD pidfile is not a live signal (pid present but kill-0 false)', () => {
    expect(isInboxLive(p, deadDeps({ readPidfilePid: () => 4242, isAlive: () => false }))).toBe(false);
  });

  it('treats a live legacy PID as a veto while the current worktree root is active', () => {
    const root = '/work/repo/.borgmcp/inbox-monitor';
    const seen: string[] = [];
    const live = isInboxLive(p, deadDeps({
      readPidfilePid: (pidfilePath) => {
        seen.push(pidfilePath);
        return pidfilePath === legacyPidfilePathFor(p) ? 4242 : null;
      },
      isAlive: (pid) => pid === 4242,
    }), root);
    expect(live).toBe(true);
    expect(seen).toContain(pidfilePathFor(p, root));
    expect(seen).toContain(legacyPidfilePathFor(p));
  });
});

describe('gh#793 selectOrphanInboxes — staleness belt + roster bonus', () => {
  const entry = (over: Partial<OrphanInboxEntry> = {}): OrphanInboxEntry => ({
    droneId: 'd1',
    inboxPath: '/inboxes/cube/d1.log',
    mtimeMs: old(),
    ...over,
  });
  const args = (over: Partial<Parameters<typeof selectOrphanInboxes>[0]> = {}) => ({
    entries: [entry()],
    isLive: () => false,
    droneState: () => 'absent' as const,
    now: NOW,
    staleMs: STALE,
    ...over,
  });

  it('a LIVE inbox is NEVER selected — even when stale + evicted (the inviolable gate)', () => {
    expect(
      selectOrphanInboxes(args({ isLive: () => true, droneState: () => 'evicted' as const }))
    ).toEqual([]);
  });

  it('evicted + no-holder + stale → selected', () => {
    expect(selectOrphanInboxes(args({ droneState: () => 'evicted' as const }))).toHaveLength(1);
  });

  it('absent (no roster) + no-holder + stale → selected (local-only signal)', () => {
    expect(selectOrphanInboxes(args({ droneState: () => 'absent' as const }))).toHaveLength(1);
  });

  it('no-holder but RECENT (just-evicted, mtime fresh) → NOT selected (staleness belt)', () => {
    expect(selectOrphanInboxes(args({ entries: [entry({ mtimeMs: old(1000) })] }))).toEqual([]);
  });

  it('a PRESENT roster member is NEVER selected, even when stale (roster bonus protects)', () => {
    expect(selectOrphanInboxes(args({ droneState: () => 'present' as const }))).toEqual([]);
  });

  it('mtime exactly at the threshold is stale-enough (>=)', () => {
    expect(selectOrphanInboxes(args({ entries: [entry({ mtimeMs: NOW - STALE })] }))).toHaveLength(1);
  });
});

describe('gh#793 gcOrphanInboxesForCube — triplet deletion + self-exclusion', () => {
  const dir = '/inboxes/cube';
  const logPath = (d: string) => `${dir}/${d}.log`;

  it('deletes the orphan triplet (.log + .monitor.pid + .monitor.heartbeat)', () => {
    const unlinked: string[] = [];
    const removed = gcOrphanInboxesForCube({
      cubeInboxDir: dir,
      selfDroneId: 'self',
      deps: {
        listInboxLogs: () => [{ droneId: 'dead', inboxPath: logPath('dead'), mtimeMs: old() }],
        isLive: () => false,
        droneState: () => 'absent',
        unlink: (p) => unlinked.push(p),
        now: NOW,
        staleMs: STALE,
      },
    });
    expect(unlinked).toEqual([logPath('dead'), pidfilePathFor(logPath('dead')), heartbeatPathFor(logPath('dead'))]);
    expect(removed).toHaveLength(3);
  });

  it('leaves stale legacy sidecars for explicit cleanup while reaping worktree-root state', () => {
    const unlinked: string[] = [];
    const root = '/work/repo/.borgmcp/inbox-monitor';
    gcOrphanInboxesForCube({
      cubeInboxDir: dir,
      selfDroneId: 'self',
      monitorStateRoot: root,
      deps: {
        listInboxLogs: () => [{ droneId: 'dead', inboxPath: logPath('dead'), mtimeMs: old() }],
        isLive: () => false,
        droneState: () => 'absent',
        unlink: (p) => unlinked.push(p),
        now: NOW,
        staleMs: STALE,
      },
    });
    expect(unlinked).toEqual([
      logPath('dead'),
      pidfilePathFor(logPath('dead'), root),
      heartbeatPathFor(logPath('dead'), root),
    ]);
  });

  it('NEVER unlinks the just-assimilated drone (self-exclusion) nor a live holder', () => {
    const unlinked: string[] = [];
    gcOrphanInboxesForCube({
      cubeInboxDir: dir,
      selfDroneId: 'self',
      deps: {
        listInboxLogs: () => [
          { droneId: 'self', inboxPath: logPath('self'), mtimeMs: old() }, // me — excluded
          { droneId: 'live', inboxPath: logPath('live'), mtimeMs: old() }, // live holder — vetoed
          { droneId: 'dead', inboxPath: logPath('dead'), mtimeMs: old() }, // genuine orphan
        ],
        isLive: (p) => p === logPath('live'),
        droneState: () => 'absent',
        unlink: (p) => unlinked.push(p),
        now: NOW,
        staleMs: STALE,
      },
    });
    expect(unlinked).not.toContain(logPath('self'));
    expect(unlinked).not.toContain(logPath('live'));
    expect(unlinked).toContain(logPath('dead'));
  });

  it('a per-file unlink error never aborts the sweep (best-effort)', () => {
    const seen: string[] = [];
    expect(() =>
      gcOrphanInboxesForCube({
        cubeInboxDir: dir,
        selfDroneId: 'self',
        deps: {
          listInboxLogs: () => [{ droneId: 'dead', inboxPath: logPath('dead'), mtimeMs: old() }],
          isLive: () => false,
          droneState: () => 'absent',
          unlink: (p) => {
            seen.push(p);
            if (p.endsWith('.monitor.pid')) throw new Error('EACCES'); // sidecar fails
          },
          now: NOW,
          staleMs: STALE,
        },
      })
    ).not.toThrow();
    // sweep continued past the failing sidecar to the heartbeat
    expect(seen).toContain(heartbeatPathFor(logPath('dead')));
  });
});

describe('gh#793 defaultListInboxLogs — skips sidecars, tolerates absent dir', () => {
  it('returns [] for a non-existent cube dir (no throw)', () => {
    expect(defaultListInboxLogs('/no/such/dir/at/all')).toEqual([]);
  });
});
