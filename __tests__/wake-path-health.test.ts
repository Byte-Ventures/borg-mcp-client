import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderStreamStatus } from '../src/stream-status';
import {
  inspectWakePath,
  openCodeWakePathHealthy,
} from '../src/wake-path-health';
import type { OpenCodeConnectionState } from '../src/opencode-drone';
import type { StreamStatus } from '../src/log-stream';

function openCodeState(
  overrides: Partial<OpenCodeConnectionState> = {},
): OpenCodeConnectionState {
  return {
    connected: true,
    sessionId: 'session-1',
    totalEntriesInjected: 0,
    totalEntriesRetried: 0,
    deliveryStates: {
      queued: 0,
      'delivered-unconfirmed': 0,
      retried: 0,
      failed: 0,
    },
    ...overrides,
  };
}

const connectedStream: StreamStatus = {
  connected: true,
  lastWireActivityAt: '2026-07-28T19:00:00.000Z',
  lastContentEventAt: '2026-07-28T19:00:00.000Z',
  lastHeartbeatAt: '2026-07-28T19:00:00.000Z',
  lastPersistedEventId: 'entry-1',
  reconnectAttempts: 0,
  runLoopRestartCount: 0,
  ownership: { state: 'unowned' },
};

describe('runtime wake-path health', () => {
  it('keeps every issue-6 OpenCode surface aligned with HTTP injection', () => {
    const source = [
      '../src/codex-launch.ts',
      '../src/regen-format.ts',
      '../src/claude.ts',
      '../src/assimilate-cmd.ts',
    ].map((path) =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
    ).join('\n');

    expect(source).not.toMatch(/SDK-driven|context-streaming/i);
    expect(source).not.toMatch(/no remote-wake mechanisms/i);
    expect(source).not.toMatch(/check activity by calling borg_read-log periodically/i);
    expect(source).not.toMatch(/via\s+the SDK/i);
    expect(source).not.toMatch(/OpenCode (?:wakes|session|app-server).*app-server/i);
    expect(source).not.toContain('OpenCode app-server');
    expect(source).toContain('HTTP entry injection');
    expect(source).toContain("OpenCode's local HTTP API");
  });

  it('reports a forced OpenCode delivery failure through borg_stream-status', async () => {
    const failed = openCodeState({
      deliveryStates: {
        queued: 0,
        'delivered-unconfirmed': 0,
        retried: 0,
        failed: 1,
      },
    });
    const wakePath = await inspectWakePath(
      {
        agentKind: 'opencode',
        active: { cubeId: 'cube-1', droneId: 'drone-1' },
        inboxPath: '/tmp/inbox.log',
        monitorStateRoot: '/tmp/monitor',
      },
      { getOpenCodeState: () => failed },
    );

    expect(wakePath.healthy).toBe(false);
    const out = renderStreamStatus({
      status: connectedStream,
      inboxMonitorHealthy: wakePath.healthy,
      wakePath,
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'builder-1',
      cubeName: 'cube-1',
      humanAgo: () => '1s ago',
    });

    expect(out.split('\n')[0]).toBe(
      '**Stream connected (OpenCode delivery degraded).**',
    );
    expect(out).toContain('- **OpenCode queued**: 0');
    expect(out).toContain('- **OpenCode delivered-unconfirmed**: 0');
    expect(out).toContain('- **OpenCode retried**: 0');
    expect(out).toContain('- **OpenCode failed**: 1');
    expect(out).toContain('`borg_read-log unread_only=true`');
    expect(out).not.toContain('Monitor command');
  });

  it('treats pending OpenCode delivery as indeterminate and clean idle state as healthy', () => {
    expect(openCodeWakePathHealthy(openCodeState({
      deliveryStates: {
        queued: 1,
        'delivered-unconfirmed': 0,
        retried: 0,
        failed: 0,
      },
    }))).toBeNull();
    expect(openCodeWakePathHealthy(openCodeState())).toBe(true);
  });

  it('does not report a configured but unbound OpenCode target as healthy', () => {
    expect(openCodeWakePathHealthy(openCodeState({
      sessionId: null,
    }))).toBeNull();
  });

  it('uses the real Codex bridge probe instead of granting health by CLI kind', async () => {
    const probeCodex = vi.fn(async () => false);
    const wakePath = await inspectWakePath(
      {
        agentKind: 'codex',
        active: { cubeId: 'cube-1', droneId: 'drone-1' },
        inboxPath: '/tmp/inbox.log',
        monitorStateRoot: '/tmp/monitor',
      },
      { probeCodex },
    );

    expect(probeCodex).toHaveBeenCalledWith({
      cubeId: 'cube-1',
      droneId: 'drone-1',
    });
    expect(wakePath).toEqual({
      agentKind: 'codex',
      healthy: false,
      openCode: null,
    });
  });

  it('keeps Claude health on the existing Monitor probe', async () => {
    const checkClaudeMonitor = vi.fn(() => true);
    const wakePath = await inspectWakePath(
      {
        agentKind: 'claude',
        active: { cubeId: 'cube-1', droneId: 'drone-1' },
        inboxPath: '/tmp/inbox.log',
        monitorStateRoot: '/tmp/monitor',
      },
      { checkClaudeMonitor },
    );

    expect(checkClaudeMonitor).toHaveBeenCalledWith(
      '/tmp/inbox.log',
      '/tmp/monitor',
    );
    expect(wakePath.healthy).toBe(true);
  });
});
