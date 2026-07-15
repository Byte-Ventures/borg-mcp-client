import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setDebug,
  isDebug,
  initDebugFromArgv,
  _resetDebugForTests,
} from '../src/debug.js';

// Sentinel token material — must NEVER appear in any debug output.
const SENTINEL_ID_TOKEN = 'SENTINEL-ID-TOKEN-do-not-log';
const SENTINEL_REFRESH = 'SENTINEL-REFRESH-do-not-log';

vi.mock('../src/config.js', () => ({
  getIdToken: vi.fn(async () => SENTINEL_ID_TOKEN),
  getRefreshToken: vi.fn(async () => SENTINEL_REFRESH),
  clearTokens: vi.fn(async () => {}),
}));

vi.mock('../src/auth.js', () => ({
  refreshIdToken: vi.fn(async () => {}),
  RefreshTokenInvalidError: class RefreshTokenInvalidError extends Error {},
  RefreshTransientError: class RefreshTransientError extends Error {},
}));

describe('debug module — setDebug / isDebug toggle', () => {
  beforeEach(() => {
    _resetDebugForTests();
    delete process.env.BORG_DEBUG;
  });

  it('defaults to disabled', () => {
    expect(isDebug()).toBe(false);
  });

  it('setDebug(true) enables, setDebug(false) disables', () => {
    setDebug(true);
    expect(isDebug()).toBe(true);
    setDebug(false);
    expect(isDebug()).toBe(false);
  });
});

describe('initDebugFromArgv', () => {
  beforeEach(() => {
    _resetDebugForTests();
    delete process.env.BORG_DEBUG;
  });

  it('enables debug and strips --debug from argv when the flag is present', () => {
    const argv = ['node', 'borg', 'assimilate', 'builder', '--debug'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['node', 'borg', 'assimilate', 'builder']);
  });

  it('strips every --debug occurrence', () => {
    const argv = ['borg', '--debug', 'setup', '--debug'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['borg', 'setup']);
  });

  it('enables debug from a truthy BORG_DEBUG even without the flag', () => {
    process.env.BORG_DEBUG = '1';
    const argv = ['borg', 'assimilate'];
    initDebugFromArgv(argv);
    expect(isDebug()).toBe(true);
    expect(argv).toEqual(['borg', 'assimilate']); // unchanged — no flag to strip
  });

  it('treats falsy BORG_DEBUG spellings as disabled', () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      _resetDebugForTests();
      process.env.BORG_DEBUG = value;
      initDebugFromArgv(['borg']);
      expect(isDebug()).toBe(false);
    }
  });

  it('leaves debug disabled when neither flag nor env is set', () => {
    initDebugFromArgv(['borg', 'setup']);
    expect(isDebug()).toBe(false);
  });
});

describe('authedFetch debug instrumentation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetDebugForTests();
    delete process.env.BORG_DEBUG;
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    errSpy.mockRestore();
    _resetDebugForTests();
  });

  const allErrOutput = (): string =>
    errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

  it('emits → request and ← response debug lines when debug is ON', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cubes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    setDebug(true);

    const { listCubes } = await import('../src/remote-client.js');
    await listCubes();

    const out = allErrOutput();
    expect(out).toContain('[borg:debug] → GET /api/cubes');
    expect(out).toContain('[borg:debug] ← 200 GET /api/cubes');
  });

  it('emits NOTHING when debug is OFF', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cubes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    // debug stays off (reset in beforeEach)

    const { listCubes } = await import('../src/remote-client.js');
    await listCubes();

    expect(allErrOutput()).not.toContain('[borg:debug]');
  });

  it('logs the server error body on a non-ok response under debug', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"Cube not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    setDebug(true);

    const { listCubes } = await import('../src/remote-client.js');
    await expect(listCubes()).rejects.toThrow('HTTP 404');

    const out = allErrOutput();
    expect(out).toContain('[borg:debug] → GET /api/cubes');
    expect(out).toContain('[borg:debug] ✗ 404 GET /api/cubes: {"error":"Cube not found"}');
  });

  it('NEVER logs token material (no Bearer/id_token/refresh_token) in debug output', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"boom"}', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    setDebug(true);

    const { listCubes } = await import('../src/remote-client.js');
    await expect(listCubes()).rejects.toThrow('HTTP 500');

    const out = allErrOutput();
    // Debug emitted (proves we captured real output, not an empty pass)…
    expect(out).toContain('[borg:debug]');
    // …and the sentinel token material is absent everywhere.
    expect(out).not.toContain(SENTINEL_ID_TOKEN);
    expect(out).not.toContain(SENTINEL_REFRESH);
    expect(out).not.toContain('Bearer');
    expect(out.toLowerCase()).not.toContain('authorization');
  });

  it('confirms the Bearer header carries the token (so the no-leak assertion is meaningful)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cubes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    setDebug(true);

    const { listCubes } = await import('../src/remote-client.js');
    await listCubes();

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const sentHeaders = init.headers as Record<string, string>;
    expect(sentHeaders['Authorization']).toBe(`Bearer ${SENTINEL_ID_TOKEN}`);
  });
});
