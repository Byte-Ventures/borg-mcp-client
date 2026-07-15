import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAgentKickoffPrompt,
  buildKickoffWakePathClause,
  recordCodexWakeTarget,
  socketPathFromRemoteArgs,
  threadIdFromPassthroughArgs,
} from '../src/codex-launch';

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
      codexWakeNonce: null,
      monitorClause: 'Monitor clause. ',
    });
    const codex = buildAgentKickoffPrompt({
      cli: 'codex',
      codexWakeNonce: 'borg-wake-123',
      monitorClause: '',
    });
    const opencodePrompt = buildAgentKickoffPrompt({
      cli: 'opencode',
      codexWakeNonce: null,
      monitorClause: '',
    });

    // KEPT: core + recovery + the (caller-built) wake-path/monitor clause.
    expect(claude).toContain('/loop Call borg_regen');
    expect(claude).toContain('Monitor clause.');
    expect(claude).toContain('MCP server disconnected'); // MCP-disconnect recovery fallback
    expect(claude).toContain('ToolSearch');
    expect(codex).toContain('Wake target nonce: borg-wake-123.');
    expect(codex).toContain('MCP server disconnected');
    expect(codex).toContain('Codex Borg wakeups use remote-control'); // codexWakePathClause default
    expect(opencodePrompt).toContain('MCP server disconnected');
    expect(opencodePrompt).toContain('OpenCode wakes');

    // STRIPPED (gh#929): the playbook-duplicated read-log-triage paragraph
    // (loopFreshnessClause — the playbook owns it post-gh#914)…
    for (const out of [claude, codex, opencodePrompt]) {
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
    expect(clause).toContain('borg-inbox-monitor');
    expect(clause).toContain('--state-root');
    expect(clause).toContain(stateRoot);
    expect(clause).toContain(inboxPath);
    expect(clause).toContain('ScheduleWakeup');
    expect(clause).toContain('[9000, 12600]');
    expect(clause).toContain('[720, 1080]');
    expect(clause).not.toContain('3600');
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

  it('renders explicit Codex wake-path capability status when supplied', () => {
    const codex = buildAgentKickoffPrompt({
      cli: 'codex',
      codexWakeNonce: 'borg-wake-123',
      monitorClause: '',
      codexWakePathClause: 'Codex wake-path capability check passed: remote-control socket established for this session.',
    });

    expect(codex).toContain('Codex wake-path capability check passed');
    expect(codex).not.toContain('Codex Borg wakeups use remote-control when available');
  });

  it('extracts Codex remote socket paths and resume thread ids', () => {
    expect(socketPathFromRemoteArgs(['--remote', 'unix:///tmp/codex.sock'])).toBe('/tmp/codex.sock');
    expect(socketPathFromRemoteArgs(['--remote', 'tcp://127.0.0.1'])).toBeNull();
    expect(threadIdFromPassthroughArgs(['resume', 'thread-1'])).toBe('thread-1');
    expect(threadIdFromPassthroughArgs(['--resume', 'thread-2'])).toBe('thread-2');
  });

  it('records an explicit resumed Codex thread without polling app-server threads', async () => {
    const setCodexWakeTarget = vi.fn(async () => {});
    const findLoadedCodexThread = vi.fn(async () => 'unexpected');

    await recordCodexWakeTarget({
      deps: { setCodexWakeTarget, findLoadedCodexThread },
      cubeId: 'cube',
      droneId: 'drone',
      socketPath: '/tmp/codex.sock',
      cwd: '/repo',
      previewNeedle: 'wake',
      launchedAtSeconds: 100,
      passthroughArgs: ['resume', 'thread-123'],
    });

    expect(findLoadedCodexThread).not.toHaveBeenCalled();
    expect(setCodexWakeTarget).toHaveBeenCalledWith('cube', 'drone', {
      threadId: 'thread-123',
      socketPath: '/tmp/codex.sock',
    });
  });

  it('polls for a fresh Codex thread when no resume id is present', async () => {
    const setCodexWakeTarget = vi.fn(async () => {});
    const findLoadedCodexThread = vi.fn(async () => 'thread-new');

    await recordCodexWakeTarget({
      deps: { setCodexWakeTarget, findLoadedCodexThread },
      cubeId: 'cube',
      droneId: 'drone',
      socketPath: '/tmp/codex.sock',
      cwd: '/repo',
      previewNeedle: 'wake',
      launchedAtSeconds: 100,
      passthroughArgs: [],
    });

    expect(findLoadedCodexThread).toHaveBeenCalledWith({
      socketPath: '/tmp/codex.sock',
      cwd: '/repo',
      previewIncludes: 'wake',
      updatedAfter: 95,
    });
    expect(setCodexWakeTarget).toHaveBeenCalledWith('cube', 'drone', {
      threadId: 'thread-new',
      socketPath: '/tmp/codex.sock',
    });
  });
});
