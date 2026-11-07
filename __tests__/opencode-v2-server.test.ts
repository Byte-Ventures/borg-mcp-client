import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOpenCodeVersion } from '../src/opencode-installation';
import { startOpenCodeV2Server, validateOpenCodeV2Endpoint } from '../src/opencode-v2-server';

const installation = { executable: '/installed/opencode', ...parseOpenCodeVersion('2.1.2') };

function harness(options: { readiness?: string; ignoreLease?: boolean; stalled?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; }),
  });
  if (!options.ignoreLease) child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0, null)));
  const spawnProcess = vi.fn(() => {
    if (!options.stalled) queueMicrotask(() => child.stdout.write(options.readiness ?? '{"url":"http://127.0.0.1:43210"}\n'));
    return child;
  });
  const fetch = vi.fn(async () => Response.json({ version: '2.1.2', pid: 1234, capabilities: {} }));
  const start = (override: Partial<Parameters<typeof startOpenCodeV2Server>[0]> = {}) => startOpenCodeV2Server({
    installation,
    directory: '/worktree',
    env: { PATH: '/installed', OPENCODE_PASSWORD: 'stale-user-password' },
    spawnProcess: spawnProcess as any,
    fetch: fetch as any,
    readyTimeoutMs: 100,
    shutdownTimeoutMs: 10,
    ...override,
  });
  return { child, spawnProcess, fetch, start };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('OpenCode V2 private server lifecycle', () => {
  it('launches the resolved executable, authenticates readiness, and owns only its private child', async () => {
    const h = harness();
    const server = await h.start();
    const [executable, args, options] = h.spawnProcess.mock.calls[0] as any;
    expect(executable).toBe(installation.executable);
    expect(args).toEqual(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0']);
    expect(args.join(' ')).not.toContain('service');
    expect(options.env.OPENCODE_PASSWORD).not.toBe('stale-user-password');
    expect(options.env.OPENCODE_PASSWORD).toBe(options.env.OPENCODE_SERVER_PASSWORD);
    expect(Buffer.from(options.env.OPENCODE_PASSWORD, 'base64url')).toHaveLength(32);
    expect(h.fetch).toHaveBeenCalledWith('http://127.0.0.1:43210/api/info', expect.objectContaining({
      redirect: 'error', headers: server.headers(),
    }));
    expect(server.url).toBe('http://127.0.0.1:43210');
    expect(JSON.stringify(server)).not.toContain(options.env.OPENCODE_PASSWORD);
    await Promise.all([server.close(), server.close()]);
    await server.closed;
    expect(h.child.kill).not.toHaveBeenCalled();
  });

  it('mints independent credentials for concurrent launches', async () => {
    const a = harness();
    const b = harness();
    const servers = await Promise.all([a.start(), b.start()]);
    expect(servers[0].headers()).not.toEqual(servers[1].headers());
    await Promise.all(servers.map(server => server.close()));
  });

  it('cleans up instead of sending a prompt when an upgrade races startup', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(Response.json({ version: '2.1.3', pid: 1234 }));
    await expect(h.start()).rejects.toMatchObject({ code: 'OPENCODE_EXECUTABLE_CHANGED' });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it.each([
    { version: '2.1.2', pid: 9999 },
    { version: '2.1.2' },
    null,
  ])('refuses an unverified server identity %j', async (info) => {
    const h = harness();
    h.fetch.mockResolvedValue(Response.json(info));
    await expect(h.start()).rejects.toThrow('verify its identity');
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it('cleans up an unauthenticated server without returning its output', async () => {
    const h = harness();
    h.fetch.mockResolvedValue(new Response('secret-server-error', { status: 401 }));
    await expect(h.start()).rejects.toThrow('No prompt was submitted');
    expect(h.child.stdin.writableEnded).toBe(true);
  });

  it.each([
    '{"url":"https://example.com"}\n',
    '{"url":"http://127.0.0.1:1234/redirect"}\n',
    'log output instead of a readiness record\n',
    'x'.repeat(16_385),
  ])('never sends credentials to malformed or non-loopback readiness', async (readiness) => {
    const h = harness({ readiness });
    await expect(h.start()).rejects.toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('bounds stalled startup and terminates a child that ignores the lease', async () => {
    const h = harness({ stalled: true, ignoreLease: true });
    await expect(h.start({ readyTimeoutMs: 10 })).rejects.toThrow('Startup verification timed out.');
    expect(h.child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('handles spawn errors without copying child diagnostics', async () => {
    const h = harness({ stalled: true });
    const pending = h.start();
    queueMicrotask(() => {
      h.child.emit('error', new Error('OPENCODE_PASSWORD=do-not-print'));
      h.child.emit('close', -2, null);
    });
    await expect(pending).rejects.toThrow('process exited before startup verification');
  });

  it('sanitizes synchronous spawn errors too', async () => {
    const h = harness();
    await expect(h.start({ spawnProcess: (() => { throw new Error('secret launch environment'); }) as any })).rejects.toThrow('No prompt was submitted');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(['http://user:password@127.0.0.1:43210', 'http://127.0.0.1:43210?token=foo', 'http://localhost:43210', 'file:///tmp/socket', 'http://127.0.0.1'])('rejects unsafe readiness URL %s', (url) => {
    expect(() => validateOpenCodeV2Endpoint(url)).toThrow();
  });
});
