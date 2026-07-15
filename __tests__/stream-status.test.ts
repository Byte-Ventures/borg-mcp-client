/**
 * Tests for the `borg_stream-status` renderer per drone-4's 18:30:51
 * UX contract. Pure-function tests; no MCP server, no live SSE — just
 * (status, inboxMonitorHealthy, paths) → markdown.
 *
 * The 5-state contract:
 *   1. Stream not started.
 *   2. Stream connected, awaiting first content event.
 *   3. Stream connected, last content <X> ago.
 *   4. Stream disconnected (reconnect attempt N).
 *   5. Stream connected (no inbox-Monitor — wake path broken).
 *
 * Precedence: disconnected (4) > no-inbox-Monitor (5). State 5 only
 * fires when wire is healthy but the file-watch isn't.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  renderStreamStatus,
  formatWakePathPrefix,
  shouldShowWakePathWarning,
  isHeartbeatStale,
} from '../src/stream-status';
import type { StreamStatus } from '../src/log-stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMonitorStateDir,
  heartbeatPathFor,
  legacyHeartbeatPathFor,
  HEARTBEAT_STALE_MS,
} from '../src/inbox-monitor';

function freshStatus(overrides: Partial<StreamStatus> = {}): StreamStatus {
  return {
    connected: false,
    lastWireActivityAt: null,
    lastContentEventAt: null,
    lastHeartbeatAt: null,
    lastPersistedEventId: null,
    reconnectAttempts: 0,
    runLoopRestartCount: 0,
    ownership: { state: 'unowned' },
    ...overrides,
  };
}

// Deterministic humanAgo so renderer tests don't depend on Date.now().
const fakeHumanAgo = (_d: Date) => '23s ago';

describe('renderStreamStatus — 5-state top-line per drone-4 contract', () => {
  it('surfaces orphaned initialization ownership and run-loop restart diagnostics', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        runLoopRestartCount: 3,
        ownership: {
          state: 'orphaned-initialization',
          ageMs: 12_000,
          lockPath: '/tmp/stream.lock',
        },
      }),
      inboxMonitorHealthy: null,
      inboxPath: null,
      droneLabel: null,
      cubeName: null,
      humanAgo: fakeHumanAgo,
    });

    expect(out.split('\n')[0]).toBe('**Stream blocked by an orphaned initialization lock.**');
    expect(out).toContain('- **stream ownership**: orphaned-initialization');
    expect(out).toContain('- **run-loop restarts**: 3');
    expect(out).toContain('- **ownership lock path**: /tmp/stream.lock');
  });

  it('State 1: Stream not started.', () => {
    const out = renderStreamStatus({
      status: freshStatus(),
      inboxMonitorHealthy: null,
      inboxPath: null,
      droneLabel: null,
      cubeName: null,
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe('**Stream not started.**');
    expect(out).toContain('- **state**: _(stream not started)_');
    // Body still includes the timestamp fields with `_(none)_` markers.
    expect(out).toContain('_(none yet)_');
  });

  it('State 2: Stream connected, awaiting first content event.', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastHeartbeatAt: '2026-05-11T12:00:00.000Z',
        // lastContentEventAt is null — wire alive, content quiet.
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'drone-1',
      cubeName: 'cube-1',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream connected, awaiting first content event.**'
    );
    expect(out).toContain('- **last content event**: _(none yet)_');
  });

  it('State 3: Stream connected, last content <X> ago.', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastContentEventAt: '2026-05-11T12:00:00.000Z',
        lastHeartbeatAt: '2026-05-11T12:00:00.000Z',
        lastPersistedEventId: 'some-uuid',
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'drone-1',
      cubeName: 'cube-1',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream connected, last content 23s ago.**'
    );
    expect(out).toContain('- **last persisted event id**: some-uuid');
  });

  it('State 4: Stream disconnected (reconnect attempt N).', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        connected: false,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        reconnectAttempts: 3,
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'drone-1',
      cubeName: 'cube-1',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream disconnected (reconnect attempt 3).**'
    );
  });

  it('State 5: Stream connected (no inbox-Monitor — wake path broken).', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastContentEventAt: '2026-05-11T12:00:00.000Z',
      }),
      inboxMonitorHealthy: false,
      inboxPath:
        '/Users/x/.config/borgmcp/inboxes/cube-uuid/drone-uuid.log',
      monitorStateRoot: '/work/repo/.borgmcp/inbox-monitor',
      droneLabel: 'drone-4',
      cubeName: 'borg-mcp',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream connected (no inbox-Monitor — wake path broken).**'
    );
    // Body line per drone-4 contract.
    expect(out).toContain(
      '- **inbox-monitor**: _(no watcher detected — wake path broken)_'
    );
    // Self-arm Monitor command — matches the assimilate-response shape
    // so Claude can run it verbatim.
    expect(out).toContain('> Monitor command: `borg-inbox-monitor --state-root');
    expect(out).toContain('/work/repo/.borgmcp/inbox-monitor');
    expect(out).toContain('/Users/x/.config/borgmcp/inboxes/cube-uuid/drone-uuid.log');
    expect(out).toContain('## Real-time wake-up');
  });

  it('reports when another local process owns the stream', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        ownership: {
          state: 'owned-by-other-process',
          pid: 1234,
          cwd: '/work/borg-mcp-codex',
          ageMs: 1500,
        },
      }),
      inboxMonitorHealthy: false,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'drone-4',
      cubeName: 'borg-mcp',
      humanAgo: fakeHumanAgo,
    });

    expect(out.split('\n')[0]).toBe(
      '**Stream owned by another Borg MCP process.**'
    );
    expect(out).toContain('- **stream owner pid**: 1234');
    expect(out).toContain('- **stream owner cwd**: /work/borg-mcp-codex');
    expect(out).not.toContain('Monitor command');
  });
});

describe('renderStreamStatus — precedence rules', () => {
  it('disconnected wins over no-inbox-Monitor (wire-down is upstream cause)', () => {
    // Both disconnected AND inboxMonitorHealthy=false. Per drone-4
    // contract precedence: prefer State 4 because the wire-disconnect
    // resolves automatically; State 5 only matters when the wire is
    // healthy.
    const out = renderStreamStatus({
      status: freshStatus({
        connected: false,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        reconnectAttempts: 2,
      }),
      inboxMonitorHealthy: false,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'd',
      cubeName: 'c',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream disconnected (reconnect attempt 2).**'
    );
    // State-5 body line should NOT appear when wire is down — the
    // upstream cause owns the surface.
    expect(out).not.toContain('inbox-monitor');
    expect(out).not.toContain('Real-time wake-up');
  });

  it('null inboxMonitorHealthy (cannot determine) stays silent — does NOT fire State 5', () => {
    // When pgrep is unavailable or returned an unknown status, the
    // renderer must NOT surface an uncertain failure as a verdict.
    // It falls back to whichever positive state applies based on
    // wire/content state alone.
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastContentEventAt: '2026-05-11T12:00:00.000Z',
      }),
      inboxMonitorHealthy: null,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'd',
      cubeName: 'c',
      humanAgo: fakeHumanAgo,
    });
    // State 3 — last-content ago, NOT State 5.
    expect(out.split('\n')[0]).toBe(
      '**Stream connected, last content 23s ago.**'
    );
    expect(out).not.toContain('wake path broken');
  });

  it('State 2 takes precedence over State 3 when lastContentEventAt is null but wire is alive', () => {
    // wire alive, no content yet — heartbeats arriving but cube is
    // quiet. Top-line should not surface a misleading "last content"
    // timestamp (there is none).
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastHeartbeatAt: '2026-05-11T12:00:00.000Z',
        lastContentEventAt: null,
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'd',
      cubeName: 'c',
      humanAgo: fakeHumanAgo,
    });
    expect(out.split('\n')[0]).toBe(
      '**Stream connected, awaiting first content event.**'
    );
  });
});

describe('renderStreamStatus — body shape (drone-4 diagnostic-completeness contract)', () => {
  it('emits all three timestamp lines (content, heartbeat, wire) even when they coincide', () => {
    // drone-4: looks redundant in the common case; required because
    // the asymmetric "content quiet, heartbeats alive" case is exactly
    // the diagnostic-target scenario.
    const ts = '2026-05-11T12:00:00.000Z';
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        lastWireActivityAt: ts,
        lastContentEventAt: ts,
        lastHeartbeatAt: ts,
        lastPersistedEventId: 'uuid-1',
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'd',
      cubeName: 'c',
      humanAgo: fakeHumanAgo,
    });
    expect(out).toMatch(/^- \*\*last content event\*\*: 2026-/m);
    expect(out).toMatch(/^- \*\*last heartbeat at\*\*: 2026-/m);
    expect(out).toMatch(/^- \*\*last wire activity\*\*: 2026-/m);
    expect(out).toContain('- **last persisted event id**: uuid-1');
    expect(out).toContain('- **reconnect attempts**: 0');
  });

  it('uses `_(none yet)_` for last content event when null, `_(none)_` for heartbeat/wire when null', () => {
    const out = renderStreamStatus({
      status: freshStatus({
        connected: true,
        // Note: must populate lastWireActivityAt to escape State 1.
        lastWireActivityAt: '2026-05-11T12:00:00.000Z',
        lastContentEventAt: null,
        lastHeartbeatAt: null,
      }),
      inboxMonitorHealthy: true,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'd',
      cubeName: 'c',
      humanAgo: fakeHumanAgo,
    });
    expect(out).toContain('- **last content event**: _(none yet)_');
    expect(out).toContain('- **last heartbeat at**: _(none)_');
  });
});

describe('formatWakePathPrefix (gh#43 — regen self-heal)', () => {
  it('renders a fail-loud arm-Monitor header with the explicit worktree command', () => {
    const out = formatWakePathPrefix({
      inboxPath: '/tmp/inbox/cube-a/drone-x.log',
      monitorStateRoot: '/work/repo/.borgmcp/inbox-monitor',
      droneLabel: 'drone-1',
      cubeName: 'borg-mcp',
    });
    expect(out).toContain('Wake path broken');
    expect(out).toContain('arm Monitor NOW');
    expect(out).toContain('`borg-inbox-monitor --state-root');
    expect(out).toContain('/work/repo/.borgmcp/inbox-monitor');
    expect(out).toContain('/tmp/inbox/cube-a/drone-x.log');
    expect(out).toContain('borg inbox for drone-1 on cube borg-mcp');
    // Ends with a separator + trailing newline so the prefix concatenates
    // cleanly with the regen markdown that follows.
    expect(out).toMatch(/---\n$/);
  });

  it('returns empty string when any context field is null (no active cube case)', () => {
    expect(
      formatWakePathPrefix({
        inboxPath: null,
        droneLabel: 'd',
        cubeName: 'c',
      })
    ).toBe('');
    expect(
      formatWakePathPrefix({
        inboxPath: '/tmp/x.log',
        droneLabel: null,
        cubeName: 'c',
      })
    ).toBe('');
    expect(
      formatWakePathPrefix({
        inboxPath: '/tmp/x.log',
        droneLabel: 'd',
        cubeName: null,
      })
    ).toBe('');
  });
});

describe('shouldShowWakePathWarning (gh#51 — gate extraction for testability)', () => {
  // The gate is the (connected × healthy) cross-product. Strict `=== false`
  // is the load-bearing precedence rule: null (indeterminate) stays silent,
  // disconnected wins over no-Monitor (wire-down is the upstream cause).
  // Tests pin that precedence so future refactors break loudly if the
  // semantic drifts.

  const connected: StreamStatus = {
    connected: true,
    lastContentEventAt: null,
    lastWireActivityAt: null,
    lastHeartbeatAt: null,
    lastPersistedEventId: null,
    reconnectAttempts: 0,
  };
  const disconnected: StreamStatus = { ...connected, connected: false };

  it('returns true when connected AND inboxMonitorHealthy === false (warning fires)', () => {
    expect(shouldShowWakePathWarning(connected, false)).toBe(true);
  });

  it('returns false when inboxMonitorHealthy === true (wake path OK; no warning)', () => {
    expect(shouldShowWakePathWarning(connected, true)).toBe(false);
  });

  it('returns false when inboxMonitorHealthy === null (indeterminate stays silent)', () => {
    expect(shouldShowWakePathWarning(connected, null)).toBe(false);
  });

  it('returns false when disconnected, regardless of healthy state (wire-down precedence)', () => {
    expect(shouldShowWakePathWarning(disconnected, false)).toBe(false);
    expect(shouldShowWakePathWarning(disconnected, true)).toBe(false);
    expect(shouldShowWakePathWarning(disconnected, null)).toBe(false);
  });
});

describe('isHeartbeatStale — gh#822 SLI presence→health upgrade', () => {
  let dir: string;
  const inbox = () => join(dir, 'drone.log');
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'borg-hb-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

  it('ABSENT heartbeat → NOT stale (presence fallback: old/just-armed monitor, never false-flag)', () => {
    expect(isHeartbeatStale(inbox())).toBe(false);
  });

  it('FRESH heartbeat → NOT stale (holder ticking → healthy)', () => {
    const hb = heartbeatPathFor(inbox());
    writeFileSync(hb, String(Date.now()));
    expect(isHeartbeatStale(inbox())).toBe(false);
  });

  it('STALE heartbeat (mtime past the threshold) → stale (wedged holder → wake path broken)', () => {
    const hb = heartbeatPathFor(inbox());
    writeFileSync(hb, 'old');
    const old = (Date.now() - (HEARTBEAT_STALE_MS + 60_000)) / 1000; // seconds
    utimesSync(hb, old, old);
    expect(isHeartbeatStale(inbox())).toBe(true);
  });

  it('reads the heartbeat from the explicit worktree-local runtime root', () => {
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    const root = join(worktree, '.borgmcp', 'inbox-monitor');
    ensureMonitorStateDir(root);
    const hb = heartbeatPathFor(inbox(), root);
    writeFileSync(hb, 'old');
    const old = (Date.now() - (HEARTBEAT_STALE_MS + 60_000)) / 1000;
    utimesSync(hb, old, old);
    expect(isHeartbeatStale(inbox(), root)).toBe(true);
    expect(isHeartbeatStale(inbox())).toBe(false);
  });

  it('keeps a fresh legacy heartbeat visible during migration even if new state is stale', () => {
    const worktree = join(dir, 'worktree');
    mkdirSync(worktree);
    const root = join(worktree, '.borgmcp', 'inbox-monitor');
    ensureMonitorStateDir(root);
    const current = heartbeatPathFor(inbox(), root);
    writeFileSync(current, 'old-current');
    const old = (Date.now() - (HEARTBEAT_STALE_MS + 60_000)) / 1000;
    utimesSync(current, old, old);
    writeFileSync(legacyHeartbeatPathFor(inbox()), 'fresh-legacy');
    expect(isHeartbeatStale(inbox(), root)).toBe(false);
  });
});
