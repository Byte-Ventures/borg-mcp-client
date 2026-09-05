/**
 * gh#855 — codex deaf-when-idle: fresh wake-target re-resolution.
 *
 * The wake target was resolved ONCE at launch (a 15s probe) and never refreshed,
 * so a missed/stale launch probe → permanent deafness. Phase 1 makes the waking
 * borg-mcp child authoritative about its OWN live app-server socket (injected
 * into its pinned env at spawn) and re-resolves the loaded thread FRESH on every
 * wake. These pin the pure pieces: socket-from-env and the thread picker.
 */
import { describe, expect, it } from 'vitest';
import {
  BORG_CODEX_APP_SERVER_SOCKET_ENV,
  codexAppServerSocketConfigArgs,
  codexAppServerSocketFromEnv,
  pickFreshThread,
} from '../src/codex-wake-resolve';

describe('gh#855 — codexAppServerSocketFromEnv', () => {
  it('returns the injected live socket path when present', () => {
    const env = { [BORG_CODEX_APP_SERVER_SOCKET_ENV]: '/run/borgmcp/codex-remote/abc.sock' };
    expect(codexAppServerSocketFromEnv(env)).toBe('/run/borgmcp/codex-remote/abc.sock');
  });

  it('returns null when absent or empty', () => {
    expect(codexAppServerSocketFromEnv({})).toBeNull();
    expect(codexAppServerSocketFromEnv({ [BORG_CODEX_APP_SERVER_SOCKET_ENV]: '' })).toBeNull();
  });

  it('codexAppServerSocketConfigArgs builds the pinned-env `-c` override (round-trips with from-env)', () => {
    const sock = '/run/borgmcp/codex-remote/abc.sock';
    const args = codexAppServerSocketConfigArgs(sock);
    expect(args[0]).toBe('-c');
    expect(args[1]).toBe(`mcp_servers.borg.env.${BORG_CODEX_APP_SERVER_SOCKET_ENV}="${sock}"`);
    // The value the child parses out of the TOML override is exactly the socket.
    const pinned = args[1].slice(args[1].indexOf('"') + 1, args[1].lastIndexOf('"'));
    expect(codexAppServerSocketFromEnv({ [BORG_CODEX_APP_SERVER_SOCKET_ENV]: pinned })).toBe(sock);
  });
});

describe('gh#855 — pickFreshThread (deterministic thread resolution on the live socket)', () => {
  it('single loaded thread → that thread (the fresh-per-launch single-session case)', () => {
    expect(pickFreshThread([{ id: 't1', cwd: '/w/a', updatedAt: 100 }], { cwd: '/w/a' })).toBe('t1');
  });

  it('no loaded thread → null (no wake this cycle; next wake retries — no permanent fail)', () => {
    expect(pickFreshThread([], { cwd: '/w/a' })).toBeNull();
  });

  it('multiple threads → prefer the cwd match', () => {
    const threads = [
      { id: 'other', cwd: '/w/other', updatedAt: 999 },
      { id: 'mine', cwd: '/w/a', updatedAt: 1 },
    ];
    expect(pickFreshThread(threads, { cwd: '/w/a' })).toBe('mine');
  });

  it('multiple cwd matches → newest updatedAt wins (deterministic)', () => {
    const threads = [
      { id: 'older', cwd: '/w/a', updatedAt: 10 },
      { id: 'newer', cwd: '/w/a', updatedAt: 20 },
    ];
    expect(pickFreshThread(threads, { cwd: '/w/a' })).toBe('newer');
  });

  it('multiple threads, none matching cwd → newest overall (best-effort, still deterministic)', () => {
    const threads = [
      { id: 'a', cwd: '/w/x', updatedAt: 5 },
      { id: 'b', cwd: '/w/y', updatedAt: 9 },
    ];
    expect(pickFreshThread(threads, { cwd: '/w/a' })).toBe('b');
  });
  it('skips subagent threads even when they are newer and share the cwd', () => {
    const threads = [
      { id: 'root', cwd: '/w/a', updatedAt: 10, source: 'cli' },
      { id: 'guardian', cwd: '/w/a', updatedAt: 999, source: { subagent: { other: 'guardian' } } },
    ];
    expect(pickFreshThread(threads, { cwd: '/w/a' })).toBe('root');
    expect(pickFreshThread([threads[1]], { cwd: '/w/a' })).toBeNull();
  });
});
