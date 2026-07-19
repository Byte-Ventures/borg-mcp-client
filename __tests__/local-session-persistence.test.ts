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

describe('CR#4: reset-local-seat discovers + clears a BOUND-PENDING seat (no false "nothing to reset")', () => {
  // Seed a bound-PENDING record (a sibling whose activation failed, bound to THIS
  // worktree) directly through the real seats API, then prove the offline reset
  // snapshot sees it and the exact-delete clears it.
  async function seedBoundPending(
    seats: typeof import('../src/seats.js'),
    worktree: string,
    withDroneId: boolean,
  ) {
    const seat = {
      origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, roleId: ROLE_ID,
      // The ORIGINAL sibling operation (NOT the worktree's derived seat op).
      operation: { projectRoot: '/orig/repo', kind: 'sibling' as const, operationKey: 'implicit-sibling:x' },
    };
    await seats.mintPendingSeat({ ...seat, credential: BEARER });
    const outcome = await seats.bindPendingSeatToWorktree({
      ...seat,
      expectedPendingDigest: digestOf(BEARER),
      ...(withDroneId ? { droneId: DRONE_ID } : {}),
      worktree, name: 'local-cube', droneLabel: 'builder-1', roleName: 'Drone',
    });
    expect(outcome).toBe('bound');
    return seats.seatRef(seat);
  }

  it.each([true, false])('clears the bound-pending record (droneId present=%s); it is NOT a live ActiveCube', async (withDroneId) => {
    const { project, seats, cubes } = await setup();
    const ref = await seedBoundPending(seats, project, withDroneId);
    // The bound-pending record is NON-hydratable as a live seat…
    expect(await cubes.getActiveCube()).toBeNull();
    expect(await seats.getActiveSeatForWorktree(project)).toBeNull();
    // …but reset MUST discover it (no false "nothing to reset").
    const snap = await cubes.snapshotLocalSeat();
    expect(snap).not.toBeNull();
    expect(snap!.observation.state).toBe('pending');
    expect(snap!.credentialRef).toBe(ref);
    // The exact re-check + delete clears the whole record.
    const outcome = await cubes.resetLocalSeatBinding(snap!);
    expect(outcome.outcome).toBe('reset');
    // Convergence: the record is gone; a second snapshot is an honest null.
    expect(await cubes.snapshotLocalSeat()).toBeNull();
    expect(await seats.getSeatForWorktree(project)).toBeNull();
  });
});
