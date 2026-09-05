/**
 * gh#528 — borg-owned per-launch DIRECT Codex app-server wake path.
 *
 * prepareCodexRemoteLaunch is async + lifecycle-owning: it spawns
 * `codex app-server --listen unix://<0700-socket>`, probes readiness via a real
 * protocol round-trip (injected here), and returns `--remote` args + an owned
 * handle (cleanup on TUI exit), or a typed refusal. Tests use injected fakes
 * for spawn/probe/sleep + a real temp runtime dir.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  prepareCodexRemoteLaunch,
  resolveCodexLaunchCwd,
  withCodexCwdArg,
  checkCodexBridgeHealthy,
} from '../src/codex-remote';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tmpDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'borg-codex-remote-'));
  tempDirectories.push(directory);
  return directory;
}

/** Minimal deps with a fast (no real wait) clock and a deterministic socket id. */
function baseDeps(over: Partial<Parameters<typeof prepareCodexRemoteLaunch>[0]> = {}) {
  const kill = vi.fn();
  const spawnAppServer = vi.fn((_socketPath: string) => ({ pid: 4242, kill }));
  let now = 0;
  let socketNumber = 0;
  return {
    deps: {
      spawnAppServer,
      probeReady: vi.fn(async () => true),
      sleep: (ms: number) => { now += ms; return Promise.resolve(); },
      now: () => now,
      runtimeDir: tmpDir(),
      socketId: () => `sock${String.fromCharCode(65 + socketNumber++)}`,
      readyTimeoutMs: 100,
      pollIntervalMs: 10, // ⇒ 10 attempts
      isAlive: () => true,
      ...over,
    },
    kill,
    spawnAppServer,
  };
}

describe('gh#528 — prepareCodexRemoteLaunch (direct app-server)', () => {
  it('ready on first probe → --remote args, wake env, owned handle; spawns ONE fresh app-server', async () => {
    const { deps, spawnAppServer } = baseDeps();
    const out = await prepareCodexRemoteLaunch(deps);
    const sock = path.join(deps.runtimeDir!, 'sockA.sock');

    expect(out.ready).toBe(true);
    if (!out.ready) throw new Error(out.reason);
    expect(out.args).toEqual(['--remote', `unix://${sock}`]);
    expect(out.env).toEqual({ BORG_CODEX_REMOTE_WAKE: '1' });
    expect(out.server).toMatchObject({ pid: 4242, socketPath: sock });
    expect(spawnAppServer).toHaveBeenCalledTimes(1);
    expect(spawnAppServer).toHaveBeenCalledWith(sock);
    // pidfile written for stale-prune.
    expect(fs.readFileSync(path.join(deps.runtimeDir!, 'sockA.pid'), 'utf-8')).toBe('4242');
  });

  it('becomes ready after a couple retries (early-stop, child not killed)', async () => {
    const probeReady = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const { deps, kill } = baseDeps({ probeReady });
    const out = await prepareCodexRemoteLaunch(deps);
    expect(out.ready).toBe(true);
    expect(probeReady).toHaveBeenCalledTimes(3);
    expect(kill).not.toHaveBeenCalled();
  });

  it('default cold-start budget keeps probing beyond the former 30000ms cutoff', async () => {
    let attempts = 0;
    const probeReady = vi.fn(async () => ++attempts === 130);
    const { deps, kill } = baseDeps({
      probeReady,
      readyTimeoutMs: undefined,
      pollIntervalMs: 250,
    });

    const out = await prepareCodexRemoteLaunch(deps);

    expect(out.ready).toBe(true);
    expect(probeReady).toHaveBeenCalledTimes(130);
    expect(kill).not.toHaveBeenCalled();
  });

  it('retries once on a fresh socket and returns only the ready second app-server', async () => {
    const firstKill = vi.fn();
    const secondKill = vi.fn();
    const spawnAppServer = vi.fn()
      .mockImplementationOnce((socketPath: string) => {
        fs.writeFileSync(socketPath, 'bound');
        return { pid: 1001, kill: firstKill };
      })
      .mockReturnValueOnce({ pid: 1002, kill: secondKill });
    const probeReady = vi.fn(async (socketPath: string) => socketPath.endsWith('sockB.sock'));
    const { deps } = baseDeps({ spawnAppServer, probeReady, readyTimeoutMs: 20 });

    const out = await prepareCodexRemoteLaunch(deps);

    expect(out.ready).toBe(true);
    if (!out.ready) throw new Error(out.reason);
    const firstSocket = path.join(deps.runtimeDir!, 'sockA.sock');
    const secondSocket = path.join(deps.runtimeDir!, 'sockB.sock');
    expect(out.args).toEqual(['--remote', `unix://${secondSocket}`]);
    expect(out.server).toMatchObject({ pid: 1002, socketPath: secondSocket });
    expect(firstKill).toHaveBeenCalledTimes(1);
    expect(secondKill).not.toHaveBeenCalled();
    expect(fs.existsSync(firstSocket)).toBe(false);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockA.pid'))).toBe(false);
  });

  it('alive but never ready → reports a readiness timeout, kills the child, and cleans up', async () => {
    const diagnostics = vi.fn(() => ({
      exited: false,
      exitCode: null,
      signal: null,
      stderr: 'warning: initialization still pending\n',
    }));
    const { deps, kill } = baseDeps({
      spawnAppServer: vi.fn(() => ({ pid: 4242, kill, diagnostics })),
      probeReady: vi.fn(async () => false),
    });
    const out = await prepareCodexRemoteLaunch(deps);
    expect(out.ready).toBe(false);
    if (out.ready) throw new Error('expected refusal');
    expect(out.reason).toMatch(/remained running but did not become ready/i);
    expect(out.reason).toContain('within 100ms');
    expect(out.reason).not.toContain(deps.runtimeDir!);
    expect(out.stderr).toBe('warning: initialization still pending');
    expect(kill).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockA.sock'))).toBe(false);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockA.pid'))).toBe(false);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockB.pid'))).toBe(false);
  });

  it('child exit before readiness → stops polling and reports exit code + buffered stderr', async () => {
    const diagnostics = vi.fn(() => ({
      exited: true,
      exitCode: 78,
      signal: null,
      stderr: 'fatal: invalid app-server configuration\n',
    }));
    const probeReady = vi.fn(async () => false);
    const sleep = vi.fn(async () => {});
    const { deps, kill } = baseDeps({
      spawnAppServer: vi.fn(() => ({ pid: 4242, kill, diagnostics })),
      probeReady,
      sleep,
    });

    const out = await prepareCodexRemoteLaunch(deps);

    expect(out.ready).toBe(false);
    if (out.ready) throw new Error('expected refusal');
    expect(out.reason).toMatch(/exited before becoming ready/i);
    expect(out.reason).toContain('exit code 78');
    expect(out.stderr).toBe('fatal: invalid app-server configuration');
    expect(probeReady).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it('sanitizes child diagnostics before rendering them in a warning', async () => {
    const diagnostics = vi.fn(() => ({
      exited: true,
      exitCode: null,
      signal: null,
      error: 'Authorization: Bearer child-error-secret',
      stderr:
        'connect https://alice:url-secret@example.test/start?token=query-secret ' +
        'api_key=key-secret client_secret="client-secret" password=pass-secret ' +
        'config=/Users/alice/.config/codex/settings.json harmless diagnostic remains\n',
    }));
    const { deps } = baseDeps({
      spawnAppServer: vi.fn(() => ({ pid: 4242, kill: vi.fn(), diagnostics })),
      probeReady: vi.fn(async () => false),
    });

    const out = await prepareCodexRemoteLaunch(deps);

    expect(out.ready).toBe(false);
    if (out.ready) throw new Error('expected refusal');
    const rendered = `${out.reason}\n${out.stderr}`;
    expect(rendered).toContain('harmless diagnostic remains');
    expect(rendered).toContain('<REDACTED>');
    expect(rendered).toContain('<REDACTED_PATH>');
    for (const secret of [
      'child-error-secret',
      'alice:url-secret',
      'query-secret',
      'key-secret',
      'client-secret',
      'pass-secret',
      '/Users/alice',
    ]) {
      expect(rendered).not.toContain(secret);
    }
  });

  it('spawn failure → FAIL-LOUD naming `codex app-server`, no handle', async () => {
    const { deps } = baseDeps({
      spawnAppServer: vi.fn(() => {
        throw new Error('ENOENT codex');
      }),
    });
    const out = await prepareCodexRemoteLaunch(deps);
    expect(out.ready).toBe(false);
    if (out.ready) throw new Error('expected refusal');
    expect(out.reason).toMatch(/codex app-server/);
    expect(out.reason).toMatch(/available on PATH/);
  });

  it('the returned handle.cleanup() kills the child + removes socket and pidfile', async () => {
    const { deps, kill } = baseDeps();
    const out = await prepareCodexRemoteLaunch(deps);
    if (!out.ready) throw new Error(out.reason);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockA.sock'))).toBe(false); // socket only bound by the (fake) server
    out.server.cleanup();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(deps.runtimeDir!, 'sockA.pid'))).toBe(false);
  });

  it('prunes ONLY crashed (dead-pid) sockets in the owned dir, keeping live sessions', async () => {
    const dir = tmpDir();
    // A crashed prior launch (dead pid 9001) + a live concurrent session (pid 9002).
    fs.writeFileSync(path.join(dir, 'dead.pid'), '9001');
    fs.writeFileSync(path.join(dir, 'dead.sock'), '');
    fs.writeFileSync(path.join(dir, 'live.pid'), '9002');
    fs.writeFileSync(path.join(dir, 'live.sock'), '');
    const { deps } = baseDeps({ runtimeDir: dir, isAlive: (pid: number) => pid === 9002 });

    await prepareCodexRemoteLaunch(deps);

    expect(fs.existsSync(path.join(dir, 'dead.sock'))).toBe(false); // crashed → pruned
    expect(fs.existsSync(path.join(dir, 'dead.pid'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'live.sock'))).toBe(true); // live → kept
    expect(fs.existsSync(path.join(dir, 'live.pid'))).toBe(true);
  });

  it('spawns a FRESH app-server per launch (no daemon reuse) → version-refresh moot', async () => {
    const spawnAppServer = vi.fn((_s: string) => ({ pid: 1, kill: vi.fn() }));
    const dir = tmpDir();
    let n = 0;
    const mk = () => ({
      spawnAppServer,
      probeReady: vi.fn(async () => true),
      sleep: () => Promise.resolve(),
      runtimeDir: dir,
      socketId: () => `s${n++}`,
      readyTimeoutMs: 100,
      pollIntervalMs: 10,
      isAlive: () => true,
    });
    await prepareCodexRemoteLaunch(mk());
    await prepareCodexRemoteLaunch(mk());
    expect(spawnAppServer).toHaveBeenCalledTimes(2);
    expect(spawnAppServer.mock.calls[0][0]).not.toBe(spawnAppServer.mock.calls[1][0]); // distinct sockets
  });

  it('enforces 0700 on the runtime dir', async () => {
    const { deps } = baseDeps();
    await prepareCodexRemoteLaunch(deps);
    const mode = fs.statSync(deps.runtimeDir!).mode & 0o777;
    expect(mode).toBe(0o700);
  });
});

describe('withCodexCwdArg', () => {
  it('adds an explicit Codex workspace directory', () => {
    expect(withCodexCwdArg(['--remote', 'unix:///tmp/codex.sock', 'prompt'], '/work/coord')).toEqual([
      '--cd',
      '/work/coord',
      '--remote',
      'unix:///tmp/codex.sock',
      'prompt',
    ]);
  });

  it('preserves user-supplied --cd or -C overrides', () => {
    expect(withCodexCwdArg(['--cd', '/manual', 'prompt'], '/work/coord')).toEqual(['--cd', '/manual', 'prompt']);
    expect(withCodexCwdArg(['-C', '/manual', 'prompt'], '/work/coord')).toEqual(['-C', '/manual', 'prompt']);
    expect(withCodexCwdArg(['-C/manual', 'prompt'], '/work/coord')).toEqual(['-C/manual', 'prompt']);
    expect(withCodexCwdArg(['-C=/manual', 'prompt'], '/work/coord')).toEqual(['-C=/manual', 'prompt']);
  });

  it('does not mistake prompt arguments after -- for a Codex cwd option', () => {
    expect(withCodexCwdArg(['--', '--cd', '/prompt-text'], '/work/coord')).toEqual([
      '--cd', '/work/coord', '--', '--cd', '/prompt-text',
    ]);
  });

  it('resolves explicit --cd/-C forms exactly as the Codex launch does', () => {
    expect(resolveCodexLaunchCwd(['--cd', '../target'], '/work/wrapper')).toBe('/work/target');
    expect(resolveCodexLaunchCwd(['--cd=relative/project'], '/work/wrapper')).toBe('/work/wrapper/relative/project');
    expect(resolveCodexLaunchCwd(['-C', '/manual'], '/work/wrapper')).toBe('/manual');
    expect(resolveCodexLaunchCwd(['-C/manual'], '/work/wrapper')).toBe('/manual');
    expect(resolveCodexLaunchCwd(['-C=/manual'], '/work/wrapper')).toBe('/manual');
    expect(resolveCodexLaunchCwd(['--cd', '/first', '-C', '/last'], '/work/wrapper')).toBe('/last');
    expect(resolveCodexLaunchCwd(['-C/first', '--cd=/last'], '/work/wrapper')).toBe('/last');
    expect(resolveCodexLaunchCwd(['-C/first', '--', '-C/ignored'], '/work/wrapper')).toBe('/first');
  });
});

describe('gh#633 — checkCodexBridgeHealthy (app-server pid liveness, NOT pgrep)', () => {
  const SOCK = '/run/borgmcp/codex-remote/abc.sock';

  it('null socketPath → null (cannot determine)', () => {
    expect(checkCodexBridgeHealthy(null)).toBeNull();
  });

  it('live app-server pid → true (bridge armed); derives the pidPath .sock→.pid', () => {
    let seenPid = '';
    const res = checkCodexBridgeHealthy(SOCK, {
      readPidFile: (p) => {
        seenPid = p;
        return '4242\n';
      },
      isAlive: (pid) => {
        expect(pid).toBe(4242);
        return true;
      },
    });
    expect(seenPid).toBe('/run/borgmcp/codex-remote/abc.pid');
    expect(res).toBe(true);
  });

  it('dead app-server pid (stale pidfile after crash/kill -9) → false — flags a real deaf codex (no SLI-lie)', () => {
    const res = checkCodexBridgeHealthy(SOCK, {
      readPidFile: () => '4242',
      isAlive: () => false,
    });
    expect(res).toBe(false);
  });

  it('missing/unreadable pidfile → null (indeterminate → caller maps to armed)', () => {
    const res = checkCodexBridgeHealthy(SOCK, {
      readPidFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      isAlive: () => true,
    });
    expect(res).toBeNull();
  });

  it('unparseable pid → null', () => {
    expect(
      checkCodexBridgeHealthy(SOCK, { readPidFile: () => 'not-a-pid', isAlive: () => true })
    ).toBeNull();
  });
});
