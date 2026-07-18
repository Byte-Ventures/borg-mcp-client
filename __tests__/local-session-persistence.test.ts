/**
 * cubes.getActiveCube hydration over the collapsed single seat store (seats.ts).
 * The ActiveCube seat map lives wholly in seats.json; getActiveCube composes the
 * ActiveCube from the ACTIVE bound SeatRecord and hydrates the session bearer via
 * the SOLE raw-bearer reader (getActiveSeatCredential).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const fixtures: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.resetModules();
});

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://localhost:8787';
const TRUST = 'spki-sha256:test-server';
const BEARER = 'live-bearer-'.padEnd(43, 'k');
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

async function setup() {
  const fixture = mkdtempSync(join(tmpdir(), 'borg-local-session-'));
  fixtures.push(fixture);
  mkdirSync(join(fixture, 'project', '.git'), { recursive: true });
  const project = realpathSync(join(fixture, 'project'));
  process.env.HOME = fixture;
  process.chdir(project);
  vi.resetModules();
  const seats = await import('../src/seats.js');
  const cubes = await import('../src/cubes.js');
  return { fixture, project, seats, cubes };
}

describe('local ActiveCube session persistence (single store)', () => {
  async function seedActiveSeat(seats: typeof import('../src/seats.js'), worktree: string) {
    const seat = { origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, roleId: ROLE_ID,
      operation: { projectRoot: worktree, kind: 'seat' as const, operationKey: 'current-worktree' } };
    await seats.mintPendingSeat({ ...seat, credential: BEARER });
    expect(await seats.activateAndBindSeat({
      ...seat, droneId: DRONE_ID, sessionId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2026-07-20T00:00:00.000Z', expectedPendingDigest: digestOf(BEARER),
      worktree, name: 'local-cube', droneLabel: 'builder-1', roleName: 'Drone',
    })).toBe('activated');
    return seats.seatRef(seat);
  }

  it('getActiveCube composes the ActiveCube from the active seat and hydrates the bearer', async () => {
    const { project, seats, cubes } = await setup();
    const ref = await seedActiveSeat(seats, project);
    const active = await cubes.getActiveCube();
    expect(active).toMatchObject({
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      name: 'local-cube',
      droneLabel: 'builder-1',
      apiUrl: ORIGIN,
      serverTrustIdentity: TRUST,
      localSessionCredentialRef: ref,
      sessionToken: BEARER,
    });
  });

  it('a pending (non-activated) seat is never surfaced as a live ActiveCube', async () => {
    const { seats, cubes } = await setup();
    await seats.mintPendingSeat({
      origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, roleId: ROLE_ID,
      operation: { projectRoot: '/work/repo', kind: 'seat', operationKey: 'current-worktree' },
      credential: BEARER,
    });
    expect(await cubes.getActiveCube()).toBeNull();
    expect(await cubes.hasPersistedActiveCube()).toBe(false);
  });

  it('the raw bearer never appears in a snapshot observation (digest-only)', async () => {
    const { project, seats, cubes } = await setup();
    await seedActiveSeat(seats, project);
    const snap = await cubes.snapshotLocalSeat();
    expect(snap).not.toBeNull();
    expect(snap!.observation).toEqual({ state: 'active', digest: digestOf(BEARER), droneId: DRONE_ID });
    expect(JSON.stringify(snap)).not.toContain(BEARER);
  });
});
