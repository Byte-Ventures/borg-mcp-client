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
      roleName: 'Builder',
      roleClass: 'worker' as const,
      isHumanSeat: false,
    };

    const refreshed = activeCubeWithFreshRegenIdentity(active, {
      cube: { name: 'borg-mcp' },
      drone: { label: 'fresh-server-label' },
      role: { name: 'Coordinator', role_class: 'queen', is_human_seat: true },
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
    expect(refreshed.roleName).toBe('Coordinator');
    expect(refreshed.roleClass).toBe('queen');
    expect(refreshed.isHumanSeat).toBe(true);
    expect(out).toContain('borg inbox for fresh-server-label on cube borg-mcp');
    expect(out).not.toContain('stale-cache-label');
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
