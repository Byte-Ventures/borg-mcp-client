/**
 * gh#851 — codex Borg sessions launch DORMANT because BORG_SESSION never
 * reaches the app-server-spawned borg-mcp MCP child.
 *
 * In codex remote-wake mode, `borg` spawns its OWN `codex app-server`
 * (defaultCodexRemoteDeps().spawnAppServer), and THAT app-server — not the
 * `codex --remote` TUI — spawns the borg-mcp MCP child. The wrapper appends
 * `codexBorgSessionConfigArgs()` + BORG_SESSION env to the TUI launch
 * (claude.ts / assimilate-cmd.ts), but the app-server spawn got NEITHER, so
 * the MCP child's pinned [mcp_servers.borg.env] lacked BORG_SESSION and the
 * gh#673 launch-gate marked it dormant.
 *
 * The existing codex-remote.test.ts injects a FAKE spawnAppServer, so the
 * real production factory (the buggy path) had no coverage. These tests pin
 * the real factory's spawn args by mocking node:child_process.
 *
 * Load-bearing assertion = the `-c mcp_servers.borg.env.BORG_SESSION="1"`
 * config override IS in the app-server args (codex MCP children read only the
 * pinned env, injected via the app-server's -c — same V2b mechanism, at the
 * app-server boundary). The env BORG_SESSION=1 is a defensive belt.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { spawnMock, spawnHarness } = vi.hoisted(() => {
  let stderrListener: ((chunk: string) => void) | undefined;
  let closeListener: ((code: number | null, signal: string | null) => void) | undefined;
  let errorListener: ((error: Error) => void) | undefined;
  const stderr: any = {};
  stderr.setEncoding = vi.fn();
  stderr.on = vi.fn((event: string, listener: (chunk: string) => void) => {
    if (event === 'data') stderrListener = listener;
    return stderr;
  });
  const child: any = { pid: 4242, kill: vi.fn(), stderr };
  child.once = vi.fn((event: string, listener: (...args: any[]) => void) => {
    if (event === 'close') closeListener = listener;
    if (event === 'error') errorListener = listener;
    return child;
  });
  return {
    spawnMock: vi.fn(() => child),
    spawnHarness: {
      emitStderr: (chunk: string) => stderrListener?.(chunk),
      emitClose: (code: number | null, signal: string | null) => closeListener?.(code, signal),
      emitError: (error: Error) => errorListener?.(error),
      reset: () => {
        stderrListener = undefined;
        closeListener = undefined;
        errorListener = undefined;
      },
      stderr,
    },
  };
});
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { defaultCodexRemoteDeps } from '../src/codex-remote';
import { codexBorgSessionConfigArgs } from '../src/launch-gate';
import { codexAgentKindConfigArgs, codexRemoteWakeConfigArgs } from '../src/agent-runtime';

const SOCK = '/run/borgmcp/codex-remote/abc.sock';

describe('defaultCodexRemoteDeps().spawnAppServer carries activation, CLI identity, and wake transport markers', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    spawnHarness.reset();
  });

  it('pins the load-bearing activation, Codex CLI identity, and remote-wake transport config into app-server args', () => {
    defaultCodexRemoteDeps().spawnAppServer(SOCK);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe('codex');
    expect(args[0]).toBe('app-server');

    // These -c pairs reach the Codex-spawned MCP child's pinned env. The
    // session gate, CLI identity, and optional transport are deliberately not
    // conflated.
    for (const [cfgFlag, cfgVal] of [
      codexBorgSessionConfigArgs(),
      codexAgentKindConfigArgs(),
      codexRemoteWakeConfigArgs(),
    ]) {
      const idx = args.findIndex((arg, index) => arg === cfgFlag && args[index + 1] === cfgVal);
      expect(idx).toBeGreaterThanOrEqual(0);
    }

    // Still listens on the requested socket (no regression to the wake wire).
    expect(args).toContain('--listen');
    expect(args).toContain(`unix://${SOCK}`);
  });

  it('sets matching env markers over inherited env and pipes stderr without enabling a shell', () => {
    defaultCodexRemoteDeps().spawnAppServer(SOCK);

    const opts = spawnMock.mock.calls[0][2] as { env?: NodeJS.ProcessEnv; stdio?: string[]; shell?: boolean };
    expect(opts.env?.BORG_SESSION).toBe('1');
    expect(opts.env?.BORG_AGENT_KIND).toBe('codex');
    expect(opts.env?.BORG_CODEX_REMOTE_WAKE).toBe('1');
    // Inherited env preserved (spread of process.env), not replaced wholesale —
    // spot-check a stable inherited key rather than the whole env (avoids a
    // self-conflict on BORG_SESSION, which the fix intentionally overrides).
    if (process.env.PATH !== undefined) expect(opts.env?.PATH).toBe(process.env.PATH);
    // No shell; stdout stays detached while stderr is available for diagnostics.
    expect(opts.shell).toBe(false);
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe']);
    expect(spawnHarness.stderr.setEncoding).toHaveBeenCalledWith('utf8');
  });

  it('captures bounded stderr and app-server exit state for readiness diagnostics', () => {
    const handle = defaultCodexRemoteDeps().spawnAppServer(SOCK);
    spawnHarness.emitStderr('discarded-prefix-');
    spawnHarness.emitStderr('x'.repeat(20_000));
    spawnHarness.emitStderr('-fatal detail\n');
    spawnHarness.emitClose(70, null);

    const diagnostics = handle.diagnostics?.();
    expect(diagnostics).toMatchObject({ exited: true, exitCode: 70, signal: null });
    expect(diagnostics?.stderr.length).toBeLessThanOrEqual(16_384);
    expect(diagnostics?.stderr).toContain('fatal detail');
    expect(diagnostics?.stderr).not.toContain('discarded-prefix');
  });

  it('exposes only sanitized stderr while preserving harmless diagnostics', () => {
    const handle = defaultCodexRemoteDeps().spawnAppServer(SOCK);
    spawnHarness.emitStderr(
      'Authorization: Bearer bearer-secret ' +
        'https://alice:url-secret@example.test/start?access_token=query-secret ' +
        'token=token-secret secret:secret-value password="password-value" ' +
        '/home/alice/.config/codex/config.toml harmless diagnostic remains\n'
    );

    const diagnostics = handle.diagnostics?.();

    expect(diagnostics?.stderr).toContain('harmless diagnostic remains');
    expect(diagnostics?.stderr).toContain('<REDACTED>');
    expect(diagnostics?.stderr).toContain('<REDACTED_PATH>');
    for (const secret of [
      'bearer-secret',
      'alice:url-secret',
      'query-secret',
      'token-secret',
      'secret-value',
      'password-value',
      '/home/alice',
    ]) {
      expect(diagnostics?.stderr).not.toContain(secret);
    }
  });

  it('captures asynchronous child-process spawn errors', () => {
    const handle = defaultCodexRemoteDeps().spawnAppServer(SOCK);
    spawnHarness.emitError(
      new Error('spawn codex ENOENT token=error-secret at /Users/alice/bin/codex')
    );

    const diagnostics = handle.diagnostics?.();
    expect(diagnostics).toMatchObject({
      exited: true,
      exitCode: null,
      signal: null,
    });
    expect(diagnostics?.error).toContain('spawn codex ENOENT');
    expect(diagnostics?.error).toContain('<REDACTED>');
    expect(diagnostics?.error).toContain('<REDACTED_PATH>');
    expect(diagnostics?.error).not.toContain('error-secret');
    expect(diagnostics?.error).not.toContain('/Users/alice');
  });
});
