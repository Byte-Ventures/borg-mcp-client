/**
 * Sprint 1 — test-stub-vs-real-IO gap closure (drone-3 SPRINT-CANDIDATE-A
 * acceptance criteria; drone-1 dispatch 2026-05-18T12:02:40Z).
 *
 * These tests exercise the REAL IO at the high-leverage dep-injected
 * seams in client/src/assimilate-deps.ts. The Phase E test suite stubbed
 * each seam at the function-boundary, which hid wire-shape mismatches
 * (BUG-2), subprocess wiring drift (BUG-5), and persistence-layer
 * regressions. These integration tests close that gap by spawning real
 * subprocesses, fetch-mocking at the global.fetch boundary, and
 * round-tripping the real fs persistence layer in a tmp HOME.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Seam 1: probeMcpReady — REAL production wiring via buildDefaultAssimilateDeps
// ---------------------------------------------------------------------------

describe('probeMcpReady (real production wiring)', () => {
  // QA-FAIL fix (drone-3 2026-05-18T12:09:15Z): the previous test defined
  // its own probeReal helper that MIRRORED the production wiring shape but
  // didn't actually call buildDefaultAssimilateDeps().probeMcpReady — so a
  // regression in the real factory (timeout, spawn args, JSON-RPC shape,
  // buffer parsing) would NOT be caught. These tests now invoke the real
  // production seam through its public surface so any future drift in the
  // factory's probeMcpReady implementation fails at test time.

  it('success path: real probeMcpReady against borg-mcp on PATH', async () => {
    // This opt-in probe targets the globally installed artifact, not the source
    // under test. Keep ordinary standalone runs independent of workstation state.
    if (process.env.BORG_TEST_INSTALLED_CLI !== '1') return;
    try { execSync('which borg-mcp', { stdio: 'ignore' }); }
    catch { return; /* not installed; skip silently */ }
    const { buildDefaultAssimilateDeps } = await import('../src/assimilate-deps.js');
    const deps = buildDefaultAssimilateDeps();
    const ok = await deps.probeMcpReady();
    expect(ok).toBe(true);
  }, 10000);

  it('failure path: real probeMcpReady when borg-mcp absent from PATH', async () => {
    // Stub PATH to an empty dir so `borg-mcp` lookup fails. Real factory
    // exercises ENOENT-from-spawn → settle(false) via the child.on('error')
    // path, which is exactly the runtime case we need coverage for.
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-tmpdir';
    try {
      const { buildDefaultAssimilateDeps } = await import('../src/assimilate-deps.js');
      const deps = buildDefaultAssimilateDeps();
      const ok = await deps.probeMcpReady();
      expect(ok).toBe(false);
    } finally {
      process.env.PATH = origPath;
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// Seam 2: remote-client.createCube + getCube wire-shape unwrap
// ---------------------------------------------------------------------------

describe('remote-client wire-shape unwrap (fetch-mocked)', () => {
  // BUG-2 regression class: server returns wrapped `{cube, roles}`; wrapper
  // must return flat `{...cube, roles, drones}`. The Phase G test stubs
  // returned the FLAT shape directly, hiding the wire mismatch. This test
  // exercises the actual wrapper code against the WIRE shape.

  beforeEach(() => {
    // Mock the global fetch + the keychain dependency chain. The wrapper
    // uses authedFetch which calls getValidToken which calls config/auth
    // — we mock these at module level so the wrapper exercises its
    // unwrap logic without keychain access.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('createCube unwraps server {cube, roles} into flat {...cube, roles, drones}', async () => {
    // Mock getValidToken to avoid keychain dependency.
    vi.doMock('../src/config.js', () => ({
      getIdToken: vi.fn(async () => 'test-token'),
      getRefreshToken: vi.fn(async () => null),
      clearTokens: vi.fn(async () => {}),
    }));
    vi.doMock('../src/auth.js', () => ({
      refreshIdToken: vi.fn(),
      RefreshTokenInvalidError: class extends Error {},
    }));

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          cube: { id: 'cube-uuid', name: 'myrepo', cube_directive: 'rules', owner_id: 'u' },
          roles: [{ id: 'r1', name: 'Builder', is_default: true }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { createCube } = await import('../src/remote-client.js');
    const result = await createCube('myrepo', 'rules');
    // Flat shape: cube fields lifted to top level + roles + drones.
    expect(result.id).toBe('cube-uuid');
    expect(result.name).toBe('myrepo');
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0].name).toBe('Builder');
    // drones defaults to [] when absent from the server response.
    expect(result.drones).toEqual([]);
  });

  it('getCube unwraps server {cube, roles, drones} into flat shape', async () => {
    vi.doMock('../src/config.js', () => ({
      getIdToken: vi.fn(async () => 'test-token'),
      getRefreshToken: vi.fn(async () => null),
      clearTokens: vi.fn(async () => {}),
    }));
    vi.doMock('../src/auth.js', () => ({
      refreshIdToken: vi.fn(),
      RefreshTokenInvalidError: class extends Error {},
    }));

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          cube: { id: 'cube-uuid', name: 'myrepo' },
          roles: [{ id: 'r1', name: 'Builder' }, { id: 'r2', name: 'Coordinator' }],
          drones: [{ id: 'd1', label: 'drone-1' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { getCube } = await import('../src/remote-client.js');
    const result = await getCube('cube-uuid');
    expect(result.id).toBe('cube-uuid');
    expect(result.name).toBe('myrepo');
    expect(result.roles).toHaveLength(2);
    expect(result.drones).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Seam 3: getInboxPath — real path computation
// ---------------------------------------------------------------------------

describe('inboxPathForDrone canonical pattern', () => {
  // Verifies the path that getInboxPath wires to. The kickoff prompt
  // embeds this string verbatim into the borg-inbox-monitor command,
  // so a path-format regression breaks every newly-launched drone's
  // wake path.

  it('produces ~/.config/borgmcp/inboxes/<cube>/<drone>.log for valid UUIDs', async () => {
    const { inboxPathForDrone } = await import('../src/cubes.js');
    const cubeId = '11111111-1111-1111-1111-111111111111';
    const droneId = '22222222-2222-2222-2222-222222222222';
    const path = inboxPathForDrone(cubeId, droneId);
    expect(path).toMatch(/[/\\]borgmcp[/\\]inboxes[/\\]/);
    expect(path).toContain(cubeId);
    expect(path.endsWith(`${droneId}.log`)).toBe(true);
  });

  it('rejects invalid cubeId / droneId (defense against path injection)', async () => {
    const { inboxPathForDrone } = await import('../src/cubes.js');
    expect(() => inboxPathForDrone('../../etc', '22222222-2222-2222-2222-222222222222'))
      .toThrow(/Invalid cubeId/);
    expect(() => inboxPathForDrone('11111111-1111-1111-1111-111111111111', '../escape'))
      .toThrow(/Invalid droneId/);
  });
});

// ---------------------------------------------------------------------------
// Seam 4: setActiveCube + getActiveCube real fs round-trip
// ---------------------------------------------------------------------------

describe('cubes.json fs persistence round-trip', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'borg-sprint1-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
    // cubes.ts computes CUBES_FILE at module import time from homedir(),
    // so reset modules to pick up the new HOME.
    vi.resetModules();
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('setActiveCube → getActiveCube round-trips the same ActiveCube', async () => {
    const { setActiveCube, getActiveCube } = await import('../src/cubes.js');
    const active = {
      cubeId: '11111111-1111-1111-1111-111111111111',
      droneId: '22222222-2222-2222-2222-222222222222',
      name: 'myrepo',
      sessionToken: 'a'.repeat(64),
      droneLabel: 'drone-1',
      apiUrl: 'https://api.example.invalid',
    };
    await setActiveCube(active);
    const read = await getActiveCube();
    expect(read).toEqual(active);
  });

  it('refreshes stale cached identity from regen before stream-status warning render', async () => {
    const { activeCubeWithFreshRegenIdentity } = await import('../src/cubes.js');
    const { renderStreamStatus } = await import('../src/stream-status.js');
    const active = {
      cubeId: '11111111-1111-1111-1111-111111111111',
      droneId: '22222222-2222-2222-2222-222222222222',
      name: 'borg-mcp',
      sessionToken: 'a'.repeat(64),
      droneLabel: 'stale-cache-label',
      apiUrl: 'https://api.example.invalid',
    };

    const refreshed = activeCubeWithFreshRegenIdentity(active, {
      cube: { name: 'borg-mcp' },
      drone: { label: 'fresh-server-label' },
    });
    const out = renderStreamStatus({
      status: {
        connected: true,
        lastWireActivityAt: '2026-05-31T12:00:00.000Z',
        lastContentEventAt: '2026-05-31T12:00:00.000Z',
        lastHeartbeatAt: null,
        lastPersistedEventId: null,
        reconnectAttempts: 0,
        runLoopRestartCount: 0,
        ownership: { state: 'unowned' },
      },
      inboxMonitorHealthy: false,
      inboxPath: '/tmp/borg/inbox.log',
      droneLabel: refreshed.droneLabel,
      cubeName: refreshed.name,
      humanAgo: () => '23s ago',
    });

    expect(refreshed.droneLabel).toBe('fresh-server-label');
    expect(out).toContain('borg inbox for fresh-server-label on cube borg-mcp');
    expect(out).not.toContain('stale-cache-label');
  });

  it('cubes.json file is written under ~/.config/borgmcp/', async () => {
    const { setActiveCube } = await import('../src/cubes.js');
    await setActiveCube({
      cubeId: '11111111-1111-1111-1111-111111111111',
      droneId: '22222222-2222-2222-2222-222222222222',
      name: 'myrepo',
      sessionToken: 'a'.repeat(64),
      droneLabel: 'drone-1',
      apiUrl: 'https://api.example.invalid',
    });
    const cubesPath = join(tmpHome, '.config', 'borgmcp', 'cubes.json');
    expect(existsSync(cubesPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cubesPath, 'utf-8'));
    expect(parsed.projects).toBeDefined();
  });

  it('getActiveCube returns null when cubes.json contains malformed JSON', async () => {
    // Seed a malformed file at the expected location and verify graceful
    // null return (no throw) — drone-7 spec rev-1 UX-F3 + Phase D CR-PD-F3.
    const fsmod = await import('node:fs/promises');
    const cubesDir = join(tmpHome, '.config', 'borgmcp');
    await fsmod.mkdir(cubesDir, { recursive: true });
    await fsmod.writeFile(join(cubesDir, 'cubes.json'), '{not valid json', 'utf-8');
    const { getActiveCube } = await import('../src/cubes.js');
    const read = await getActiveCube();
    expect(read).toBeNull();
  });
});
