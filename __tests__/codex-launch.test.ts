import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAgentKickoffPrompt,
  buildKickoffWakePathClause,
  buildCodexLaunchArgs,
} from '../src/codex-launch';
import { OPENCODE_WAKE_PATH_GUIDANCE } from '../src/opencode-wake-copy';

describe('codex launch helpers', () => {
  it('keeps the Claude launcher source aligned with adaptive recovery guidance', () => {
    const source = readFileSync(new URL('../src/claude.ts', import.meta.url), 'utf8');
    expect(source).toContain('adaptive ScheduleWakeup recovery deadline');
    expect(source).toContain('3h ±30m');
    expect(source).toContain('15m ±3m');
    expect(source).not.toContain('60-min ScheduleWakeup heartbeat');
  });

  it('builds the compacted kickoff prompt with runtime-specific clauses (gh#929)', () => {
    const claude = buildAgentKickoffPrompt({
      cli: 'claude',
      monitorClause: 'Monitor clause. ',
    });
    const codex = buildAgentKickoffPrompt({
      cli: 'codex',
      monitorClause: '',
    });
    const opencodePrompt = buildAgentKickoffPrompt({
      cli: 'opencode',
      monitorClause: '',
    });

    // KEPT: core + recovery + the (caller-built) wake-path/monitor clause.
    expect(claude).toContain('Call borg_regen');
    expect(claude).not.toContain('/loop');
    expect(claude).toContain('Monitor clause.');
    expect(claude).toContain('MCP server disconnected'); // MCP-disconnect recovery fallback
    expect(claude).toContain('ToolSearch');
    expect(codex).toContain('MCP server disconnected');
    expect(codex).toContain('Borg-owned remote-control socket');
    expect(opencodePrompt).toContain('MCP server disconnected');
    expect(opencodePrompt).toContain(OPENCODE_WAKE_PATH_GUIDANCE);
    expect(opencodePrompt).toContain('OpenCode wakes');
    expect(opencodePrompt).toContain('durable inbox');
    expect(opencodePrompt).toContain('delivered-unconfirmed');
    expect(opencodePrompt).toContain('borg_read-log unread_only=true');
    expect(opencodePrompt).not.toContain('check activity by calling borg_read-log periodically');

    // STRIPPED (gh#929): the playbook-duplicated read-log-triage paragraph
    // (loopFreshnessClause — the playbook owns it post-gh#914)…
    for (const out of [claude, codex, opencodePrompt]) {
      expect(out).toContain('one recovery attempt');
      expect(out).toContain('escalate to the operator');
      expect(out).toContain('Never start, stop, restart, update, or recover the Borg server');
      expect(out).not.toContain('On every Monitor wake and every ScheduleWakeup heartbeat, triage');
      expect(out).not.toContain('DRAIN');
      expect(out).not.toContain('Do NOT triage with a manual since cursor');
      expect(out).not.toContain('periodically every 4-5 wakes');
      // …and the role-specific anti-passive-Standing clause (belongs in role-text).
      expect(out).not.toContain('Coordinator/Queen seats: before posting bare');
    }
    // The trailing claude wake-path-check/heartbeat line is folded into the
    // shared wake-path arming (now carried by monitorClause), not duplicated here.
    expect(claude).not.toContain('Wake-path capability check: if borg_regen shows a wake-path warning');
  });

  it('buildKickoffWakePathClause reuses the shared wakePathArming + keeps NEVER-TaskStop (claude)', () => {
    const inboxPath = '/home/u/.config/borgmcp/inboxes/cube-uuid/drone-uuid.log';
    const stateRoot = '/home/u/repo/.borgmcp/inbox-monitor';
    const clause = buildKickoffWakePathClause('claude', inboxPath, stateRoot);
    // shared wake-path arming (same core the SessionStart hook uses)
    expect(clause).toContain('inbox-monitor');
    expect(clause).toContain('--state-root');
    expect(clause).toContain(stateRoot);
    expect(clause).toContain(inboxPath);
    expect(clause).toContain('borg_read-log unread_only=true');
    expect(clause).toContain(
      're-arm the Monitor when its exit notification wakes you, and whenever you notice no Monitor is armed.',
    );
    expect(clause).not.toContain('/loop');
    expect(clause).not.toContain('ScheduleWakeup');
    // NEVER-TaskStop safety reminder preserved (not dropped in the compaction)
    expect(clause).toMatch(/never\s+TaskStop/i);
    expect(clause).toContain('410');
  });

  it('buildKickoffWakePathClause is empty for codex (app-server wake, no tail-Monitor to arm)', () => {
    expect(buildKickoffWakePathClause('codex', '/x/y.log')).toBe('');
  });

  it('buildKickoffWakePathClause is empty when there is no inbox path (no active cube)', () => {
    expect(buildKickoffWakePathClause('claude', null)).toBe('');
  });

  it('assembles every Codex launch with the Borg-owned remote socket', () => {
    const remote = {
      ready: true as const,
      args: ['--remote', 'unix:///tmp/codex.sock'],
      env: { BORG_CODEX_REMOTE_WAKE: '1' },
      server: { pid: 123, socketPath: '/tmp/codex.sock', cleanup: () => {} },
    };
    const bare = buildCodexLaunchArgs({
      remote,
      cwd: '/repo',
      kickoff: 'kickoff',
      approvalArgs: ['--ask-for-approval', 'never'],
      seatExpectationArgs: ['-c', 'mcp_servers.borg.env.BORG_LAUNCH_EXPECTED_SEAT="seat"'],
      passthroughArgs: ['resume', 'thread-123'],
    });
    const assimilated = buildCodexLaunchArgs({
      remote,
      cwd: '/repo',
      kickoff: 'kickoff',
      accessArgs: ['--add-dir', '/repo/.git'],
    });

    for (const result of [bare, assimilated]) {
      expect(result.ready).toBe(true);
      if (!result.ready) throw new Error(result.reason);
      expect(result.args.filter((arg) => arg === '--remote')).toHaveLength(1);
      expect(result.args).toEqual(expect.arrayContaining([
        '-c', 'mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"',
        '--remote', 'unix:///tmp/codex.sock',
      ]));
    }
  });

  it.each([
    ['--remote', 'unix:///tmp/caller.sock'],
    ['--remote=unix:///tmp/caller.sock'],
  ])('refuses a caller-provided Codex remote argument', (...passthroughArgs) => {
    const result = buildCodexLaunchArgs({
      remote: {
        ready: true,
        args: ['--remote', 'unix:///tmp/borg.sock'],
        env: { BORG_CODEX_REMOTE_WAKE: '1' },
        server: { pid: 123, socketPath: '/tmp/borg.sock', cleanup: () => {} },
      },
      cwd: '/repo',
      kickoff: 'kickoff',
      passthroughArgs,
    });

    expect(result).toEqual({
      ready: false,
      reason: 'Borg owns Codex remote control; remove the passthrough --remote option and retry.',
    });
  });
});
