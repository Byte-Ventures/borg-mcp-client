import { describe, expect, it, vi } from 'vitest';
import {
  formatSeatReattachRefusal,
  inspectLiveInboxMonitor,
  type SeatReattachGuardDeps,
} from '../src/seat-reattach-guard';
import {
  heartbeatPathFor,
  legacyHeartbeatPathFor,
  legacyPidfilePathFor,
  pidfilePathFor,
} from '../src/inbox-monitor';

function deps(overrides: Partial<SeatReattachGuardDeps> = {}): SeatReattachGuardDeps {
  return {
    readPidfile: vi.fn(() => null),
    readHeartbeatMtimeMs: vi.fn(() => null),
    isAlive: vi.fn(() => false),
    now: 10_000,
    heartbeatStaleMs: 1_000,
    ...overrides,
  };
}

describe('inspectLiveInboxMonitor (#56)', () => {
  const inbox = '/config/inboxes/cube/drone.log';
  const root = '/work/repo/.borgmcp/inbox-monitor';

  it('returns the modern live holder and probes its fresh heartbeat', () => {
    const readPidfile = vi.fn((path: string) =>
      path === pidfilePathFor(inbox, root) ? '4242:nonce-1\n' : null);
    const readHeartbeatMtimeMs = vi.fn((path: string) =>
      path === heartbeatPathFor(inbox, root) ? 9_500 : null);
    expect(inspectLiveInboxMonitor(inbox, root, deps({
      readPidfile,
      readHeartbeatMtimeMs,
      isAlive: vi.fn((pid) => pid === 4242),
    }))).toEqual({ pid: 4242, heartbeat: 'fresh' });
    expect(readHeartbeatMtimeMs).toHaveBeenCalledWith(heartbeatPathFor(inbox, root));
  });

  it('retains migration safety for a live legacy holder and reports a stale heartbeat', () => {
    expect(inspectLiveInboxMonitor(inbox, root, deps({
      readPidfile: vi.fn((path) => path === legacyPidfilePathFor(inbox) ? '4343' : null),
      readHeartbeatMtimeMs: vi.fn((path) => path === legacyHeartbeatPathFor(inbox) ? 1_000 : null),
      isAlive: vi.fn((pid) => pid === 4343),
    }))).toEqual({ pid: 4343, heartbeat: 'stale' });
  });

  it('ignores malformed and dead pidfiles instead of inventing a holder', () => {
    expect(inspectLiveInboxMonitor(inbox, root, deps({
      readPidfile: vi.fn((path) =>
        path === pidfilePathFor(inbox, root) ? '4242junk' : '4343:nonce'),
      isAlive: vi.fn(() => false),
    }))).toBeNull();
  });
});

describe('formatSeatReattachRefusal (#56)', () => {
  it('names the holder pid and bounded force escape without claiming it is wedged', () => {
    const message = formatSeatReattachRefusal(
      { pid: 4242, heartbeat: 'fresh' },
      'borg --force',
    );
    expect(message).toContain('pid 4242');
    expect(message).toContain('`borg --force`');
    expect(message).not.toContain('may be wedged');
  });

  it('states stale-heartbeat uncertainty without treating the live pid as dead', () => {
    const message = formatSeatReattachRefusal(
      { pid: 4242, heartbeat: 'stale' },
      'borg assimilate --here --force',
    );
    expect(message).toContain('heartbeat is stale');
    expect(message).toContain('process may be wedged');
    expect(message).toContain('pid 4242');
  });
});
