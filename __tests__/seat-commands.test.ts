import { describe, expect, it, vi } from 'vitest';
import {
  parseLaunchSeatArgs,
  parseSeatsArgs,
  runLaunchSeat,
  runSeats,
  type SeatCommandDeps,
} from '../src/seat-commands';
import type { ActiveCube } from '../src/cubes';
import type { SeatRecord } from '../src/seats';

const CUBE_A = '11111111-1111-1111-1111-111111111111';
const CUBE_B = '22222222-2222-2222-2222-222222222222';
const DRONE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DRONE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function activeCube(overrides: Partial<ActiveCube> = {}): ActiveCube {
  return {
    cubeId: CUBE_A,
    droneId: DRONE_A,
    name: 'alpha',
    sessionToken: 'token-a',
    droneLabel: 'builder-aaaaaaaa',
    apiUrl: 'https://127.0.0.1:31337',
    worktree: '/work/a',
    ...overrides,
  };
}

function activeSeat(cube: ActiveCube, worktree = cube.worktree!): { worktree: string; record: SeatRecord } {
  return {
    worktree,
    record: {
      origin: cube.apiUrl,
      trustIdentity: cube.serverTrustIdentity ?? 'spki-sha256:test',
      cubeId: cube.cubeId,
      roleId: '33333333-3333-3333-3333-333333333333',
      operation: { projectRoot: '/work', kind: 'seat', operationKey: cube.droneId },
      credential: 'a'.repeat(43),
      state: 'active',
      droneId: cube.droneId,
      sessionId: '44444444-4444-4444-4444-444444444444',
      worktree,
      name: cube.name,
      droneLabel: cube.droneLabel,
    },
  };
}

function depsFor(cubes: ActiveCube[], overrides: Partial<SeatCommandDeps> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launchBareBorg = vi.fn(async () => 0);
  const deps: SeatCommandDeps = {
    readAllProjectIdentities: vi.fn(async () => cubes.map((cube) => ({ projectPath: cube.worktree!, cube }))),
    readAllActiveSeats: vi.fn(async () => cubes.map((cube) => activeSeat(cube))),
    getProjectCliPreference: vi.fn(async (worktree) => worktree.endsWith('/a') ? 'codex' : 'claude'),
    pathExists: vi.fn(() => true),
    realpath: vi.fn((path) => path.replace('/linked/', '/real/')),
    launchBareBorg,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...overrides,
  };
  return { deps, stdout, stderr, launchBareBorg };
}

describe('seat command parsers', () => {
  it('accepts borg seats without arguments and rejects extras', () => {
    expect(parseSeatsArgs([])).toEqual({ ok: true });
    expect(parseSeatsArgs(['extra'])).toEqual({ ok: false, error: 'takes no arguments' });
  });

  it('parses a launch target and optional cube selector', () => {
    expect(parseLaunchSeatArgs(['builder-aaaaaaaa'])).toEqual({
      ok: true,
      target: 'builder-aaaaaaaa',
    });
    expect(parseLaunchSeatArgs(['builder-aaaaaaaa', '--cube', 'alpha'])).toEqual({
      ok: true,
      target: 'builder-aaaaaaaa',
      cube: 'alpha',
    });
    expect(parseLaunchSeatArgs(['--cube=alpha', DRONE_A.slice(0, 8)])).toEqual({
      ok: true,
      target: DRONE_A.slice(0, 8),
      cube: 'alpha',
    });
  });

  it('rejects a missing target, missing cube value, and extra positionals', () => {
    expect(parseLaunchSeatArgs([])).toEqual({ ok: false, error: 'requires a drone label or id prefix' });
    expect(parseLaunchSeatArgs(['builder-aaaaaaaa', '--cube'])).toEqual({ ok: false, error: '--cube requires a cube name' });
    expect(parseLaunchSeatArgs(['one', 'two'])).toEqual({ ok: false, error: 'accepts exactly one drone label or id prefix' });
  });
});

describe('borg seats', () => {
  it('lists every local active seat with label, cube, registered worktree, CLI, and state', async () => {
    const linked = activeCube({ worktree: '/linked/a' });
    const second = activeCube({
      cubeId: CUBE_B,
      droneId: DRONE_B,
      name: 'beta',
      droneLabel: 'reviewer-bbbbbbbb',
      worktree: '/work/b',
    });
    const { deps, stdout } = depsFor([second, linked]);

    expect(await runSeats(deps)).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('builder-aaaaaaaa');
    expect(output).toContain('alpha');
    expect(output).toContain('/linked/a');
    expect(output).toContain('codex');
    expect(output).toMatch(/^DRONE\s+CUBE\s+STATE\s+CLI\s+WORKTREE/m);
    expect(output).toContain('active');
    expect(output).toContain('reviewer-bbbbbbbb');
    expect(output.indexOf('builder-aaaaaaaa')).toBeLessThan(output.indexOf('reviewer-bbbbbbbb'));
  });

  it('keeps the registry state and registered path when a worktree is missing', async () => {
    const cube = activeCube();
    const { deps, stdout } = depsFor([cube], {
      pathExists: vi.fn(() => false),
      realpath: vi.fn(() => { throw new Error('ENOENT'); }),
    });

    expect(await runSeats(deps)).toBe(0);
    expect(stdout.join('')).toContain('active');
    expect(stdout.join('')).toContain('/work/a');
  });

  it('includes a bound pending registry entry with a dash for an unset CLI', async () => {
    const pending = activeSeat(activeCube({ droneLabel: 'builder-pending' }));
    pending.record.state = 'pending';
    delete pending.record.sessionId;
    const { deps, stdout } = depsFor([], {
      readAllActiveSeats: vi.fn(async () => [pending]),
      getProjectCliPreference: vi.fn(async () => null),
    });

    expect(await runSeats(deps)).toBe(0);
    expect(stdout.join('')).toMatch(/builder-pending\s+alpha\s+pending\s+-\s+\/work\/a/);
  });

  it('prints a bounded empty-registry message', async () => {
    const { deps, stdout } = depsFor([]);
    expect(await runSeats(deps)).toBe(0);
    expect(stdout.join('')).toBe(
      'No drone seats are registered on this machine. Run `borg assimilate` in a project repository to create one.\n',
    );
  });
});

describe('borg launch', () => {
  it('launches an unambiguous label by running bare borg in the canonical worktree', async () => {
    const cube = activeCube({ worktree: '/linked/a' });
    const { deps, launchBareBorg } = depsFor([cube]);

    expect(await runLaunchSeat({ target: cube.droneLabel }, deps)).toBe(0);
    expect(launchBareBorg).toHaveBeenCalledWith('/real/a');
  });

  it('accepts an unambiguous drone id prefix', async () => {
    const cube = activeCube();
    const { deps, launchBareBorg } = depsFor([cube]);

    expect(await runLaunchSeat({ target: DRONE_A.slice(0, 8) }, deps)).toBe(0);
    expect(launchBareBorg).toHaveBeenCalledWith('/work/a');
  });

  it('requires disambiguation for the same label in multiple cubes', async () => {
    const first = activeCube();
    const second = activeCube({ cubeId: CUBE_B, droneId: DRONE_B, name: 'beta', worktree: '/work/b' });
    const { deps, stderr, launchBareBorg } = depsFor([first, second]);

    expect(await runLaunchSeat({ target: first.droneLabel }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      `borg launch: '${first.droneLabel}' matches 2 drones:\n` +
      `  builder-aaaaaaaa  alpha  id:aaaaaaaa\n` +
      `  builder-aaaaaaaa  beta   id:bbbbbbbb\n` +
      `Add --cube <name>, or use the drone id prefix: borg launch aaaaaaaa.\n`,
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('uses --cube to disambiguate a label', async () => {
    const first = activeCube();
    const second = activeCube({ cubeId: CUBE_B, droneId: DRONE_B, name: 'beta', worktree: '/work/b' });
    const { deps, launchBareBorg } = depsFor([first, second]);

    expect(await runLaunchSeat({ target: first.droneLabel, cube: 'beta' }, deps)).toBe(0);
    expect(launchBareBorg).toHaveBeenCalledWith('/work/b');
  });

  it('reports an unknown target and points to borg seats', async () => {
    const { deps, stderr, launchBareBorg } = depsFor([activeCube()]);

    expect(await runLaunchSeat({ target: 'builder-deadbeef' }, deps)).toBe(1);
    const output = stderr.join('');
    expect(output).toBe(
      "borg launch: no drone matches 'builder-deadbeef' on this machine. Run `borg seats` to list the drones you can launch.\n",
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('explains the per-machine registry when no local drones exist', async () => {
    const { deps, stderr } = depsFor([]);
    expect(await runLaunchSeat({ target: 'builder-deadbeef' }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: drone 'builder-deadbeef' is not in this machine's seat registry. " +
      'The registry is local to each machine and lists only drones assimilated here. ' +
      'Run `borg seats` on the machine where the drone was created.\n',
    );
  });

  it('refuses a missing worktree without guessing another path', async () => {
    const cube = activeCube();
    const { deps, stderr, launchBareBorg } = depsFor([cube], {
      pathExists: vi.fn(() => false),
      realpath: vi.fn(() => { throw new Error('ENOENT'); }),
    });

    expect(await runLaunchSeat({ target: cube.droneLabel }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: drone 'builder-aaaaaaaa' is registered at /work/a, but that directory does not exist. " +
      'Restore the directory, or run `borg cleanup` to review orphaned worktrees.\n',
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });
});
