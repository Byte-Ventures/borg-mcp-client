import { describe, expect, it } from 'vitest';
import {
  BORG_AGENT_KIND_ENV,
  BORG_CODEX_REMOTE_WAKE_ENV,
  BORG_OPENCODE_ENV,
  codexAgentKindConfigArgs,
  codexRemoteWakeConfigArgs,
  resolveReportableSessionAgentKind,
  resolveSessionAgentKind,
  withAgentRuntimeEnv,
} from '../src/agent-runtime';

describe('agent runtime identity', () => {
  it('treats the pinned agent CLI as authoritative over legacy transport markers', () => {
    expect(resolveSessionAgentKind({
      [BORG_AGENT_KIND_ENV]: 'claude',
      [BORG_CODEX_REMOTE_WAKE_ENV]: '1',
    } as NodeJS.ProcessEnv)).toBe('claude');
    expect(resolveSessionAgentKind({
      [BORG_AGENT_KIND_ENV]: 'opencode',
      [BORG_CODEX_REMOTE_WAKE_ENV]: '1',
    } as NodeJS.ProcessEnv)).toBe('opencode');
  });

  it('keeps legacy markers as compatibility fallbacks for already-installed clients', () => {
    expect(resolveSessionAgentKind({ [BORG_CODEX_REMOTE_WAKE_ENV]: '1' } as NodeJS.ProcessEnv)).toBe('codex');
    expect(resolveSessionAgentKind({ [BORG_OPENCODE_ENV]: '1' } as NodeJS.ProcessEnv)).toBe('opencode');
    expect(resolveSessionAgentKind({} as NodeJS.ProcessEnv)).toBe('claude');
  });

  it('does not report the legacy default-Claude guess as known runtime identity', () => {
    expect(resolveReportableSessionAgentKind({} as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveReportableSessionAgentKind({ [BORG_AGENT_KIND_ENV]: 'invalid' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveReportableSessionAgentKind({ [BORG_AGENT_KIND_ENV]: 'claude' } as NodeJS.ProcessEnv)).toBe('claude');
    expect(resolveReportableSessionAgentKind({ [BORG_CODEX_REMOTE_WAKE_ENV]: '1' } as NodeJS.ProcessEnv)).toBe('codex');
    expect(resolveReportableSessionAgentKind({ [BORG_OPENCODE_ENV]: '1' } as NodeJS.ProcessEnv)).toBe('opencode');
  });

  it('clears stale Codex and OpenCode markers before a relaunch', () => {
    const claude = withAgentRuntimeEnv({
      KEEP_ME: 'yes',
      [BORG_AGENT_KIND_ENV]: 'codex',
      [BORG_CODEX_REMOTE_WAKE_ENV]: '1',
      [BORG_OPENCODE_ENV]: '1',
    } as NodeJS.ProcessEnv, 'claude');

    expect(claude).toMatchObject({ KEEP_ME: 'yes', [BORG_AGENT_KIND_ENV]: 'claude' });
    expect(claude[BORG_CODEX_REMOTE_WAKE_ENV]).toBeUndefined();
    expect(claude[BORG_OPENCODE_ENV]).toBeUndefined();
    expect(resolveSessionAgentKind(claude)).toBe('claude');
  });

  it('pins Codex identity and remote-wake transport with separate config overrides', () => {
    expect(codexAgentKindConfigArgs()).toEqual([
      '-c',
      'mcp_servers.borg.env.BORG_AGENT_KIND="codex"',
    ]);
    expect(codexRemoteWakeConfigArgs()).toEqual([
      '-c',
      'mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"',
    ]);
    expect(codexRemoteWakeConfigArgs(false)).toEqual([
      '-c',
      'mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="0"',
    ]);
  });
});
