import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BORG_LAUNCH_EXPECTED_SEAT_ENV,
  codexLaunchSeatExpectationConfigArgs,
  withLaunchSeatExpectationEnv,
} from '../src/cubes';
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
const DRONE_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const originalStateRoot = process.env.BORG_STATE_ROOT;
const originalLaunchExpectedSeat = process.env.BORG_LAUNCH_EXPECTED_SEAT;
const fixtures: string[] = [];

afterEach(() => {
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  if (originalLaunchExpectedSeat === undefined) delete process.env.BORG_LAUNCH_EXPECTED_SEAT;
  else process.env.BORG_LAUNCH_EXPECTED_SEAT = originalLaunchExpectedSeat;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.resetModules();
});

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
    readAllBoundSeats: vi.fn(async () => cubes.map((cube) => activeSeat(cube))),
    getActiveSeatForWorktree: vi.fn(async (worktree) => {
      const cube = cubes.find((candidate) => candidate.worktree?.replace('/linked/', '/real/') === worktree);
      return cube ? activeSeat(cube).record : null;
    }),
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
  it('accepts borg drones without arguments and rejects extras', () => {
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

describe('launch-seat identity handoff', () => {
  it('carries only the expected identity through wrapper and Codex MCP child environments', () => {
    const expectation = {
      credentialRef: 'borg-server-session:' + 'a'.repeat(64),
      cubeId: CUBE_A,
      droneId: DRONE_A,
      worktree: '/work/a',
      droneLabel: 'builder-aaaaaaaa',
    };
    const env = withLaunchSeatExpectationEnv({ PATH: '/bin' }, expectation);
    const encoded = Buffer.from(JSON.stringify(expectation), 'utf8').toString('base64url');

    expect(env).toEqual({ PATH: '/bin', [BORG_LAUNCH_EXPECTED_SEAT_ENV]: encoded });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codexLaunchSeatExpectationConfigArgs(env)).toEqual([
      '-c',
      `mcp_servers.borg.env.${BORG_LAUNCH_EXPECTED_SEAT_ENV}=${JSON.stringify(encoded)}`,
    ]);
    expect(codexLaunchSeatExpectationConfigArgs({})).toEqual([]);
    expect(encoded).not.toContain('credential":"');
  });
});

describe('borg drones', () => {
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
      readAllBoundSeats: vi.fn(async () => [pending]),
      getProjectCliPreference: vi.fn(async () => null),
    });

    expect(await runSeats(deps)).toBe(0);
    expect(stdout.join('')).toMatch(/builder-pending\s+alpha\s+pending\s+-\s+\/work\/a/);
  });

  it('prints a bounded empty-registry message', async () => {
    const { deps, stdout } = depsFor([]);
    expect(await runSeats(deps)).toBe(0);
    expect(stdout.join('')).toBe(
      'No drones are registered on this machine. Run `borg assimilate` in a project repository to create one.\n',
    );
  });
});

describe('production local-registry wiring', () => {
  it('lists active and bound-pending records while pending remains non-hydratable', async () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'borg-seat-commands-default-')));
    fixtures.push(stateRoot);
    process.env.BORG_STATE_ROOT = stateRoot;
    const activeWorktree = join(stateRoot, 'active-worktree');
    const siblingWorktree = join(stateRoot, 'sibling-worktree');
    const pendingWorktree = join(stateRoot, 'pending-worktree');
    mkdirSync(activeWorktree);
    mkdirSync(siblingWorktree);
    mkdirSync(pendingWorktree);
    vi.resetModules();

    const seats = await import('../src/seats.js');
    const cubes = await import('../src/cubes.js');
    const commands = await import('../src/seat-commands.js');
    const base = {
      origin: 'https://localhost:8787',
      trustIdentity: 'spki-sha256:test',
      cubeId: CUBE_A,
      roleId: '33333333-3333-3333-3333-333333333333',
    };
    const activeBearer = 'active-bearer-'.padEnd(43, 'a');
    const activeOperation = { projectRoot: stateRoot, kind: 'seat' as const, operationKey: 'active' };
    await seats.mintPendingSeat({ ...base, operation: activeOperation, credential: activeBearer });
    await seats.activateAndBindSeat({
      ...base,
      operation: activeOperation,
      expectedPendingDigest: createHash('sha256').update(activeBearer).digest('hex'),
      droneId: DRONE_A,
      sessionId: '44444444-4444-4444-4444-444444444444',
      worktree: activeWorktree,
      name: 'alpha',
      droneLabel: 'builder-active',
    });

    const sibling = {
      ...base,
      cubeId: CUBE_B,
      roleId: '55555555-5555-5555-5555-555555555555',
    };
    const siblingBearer = 'sibling-bearer-'.padEnd(43, 's');
    const siblingOperation = { projectRoot: stateRoot, kind: 'sibling' as const, operationKey: 'sibling' };
    await seats.mintPendingSeat({ ...sibling, operation: siblingOperation, credential: siblingBearer });
    await seats.activateAndBindSeat({
      ...sibling,
      operation: siblingOperation,
      expectedPendingDigest: createHash('sha256').update(siblingBearer).digest('hex'),
      droneId: DRONE_B,
      sessionId: '66666666-6666-6666-6666-666666666666',
      worktree: siblingWorktree,
      name: 'beta',
      droneLabel: 'builder-sibling',
    });

    const priorEmptyExpectation = process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV];
    process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = '';
    try {
      await expect(cubes.getActiveCubeForWorktree(activeWorktree)).resolves.toMatchObject({
        cubeId: CUBE_A,
        droneId: DRONE_A,
        droneLabel: 'builder-active',
      });
    } finally {
      if (priorEmptyExpectation === undefined) delete process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV];
      else process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = priorEmptyExpectation;
    }

    const pendingBearer = 'pending-bearer-'.padEnd(43, 'p');
    const pendingOperation = { projectRoot: stateRoot, kind: 'sibling' as const, operationKey: 'pending' };
    await seats.mintPendingSeat({ ...base, operation: pendingOperation, credential: pendingBearer });
    await seats.bindPendingSeatToWorktree({
      ...base,
      operation: pendingOperation,
      expectedPendingDigest: createHash('sha256').update(pendingBearer).digest('hex'),
      droneId: DRONE_C,
      worktree: pendingWorktree,
      name: 'alpha',
      droneLabel: 'builder-pending',
    });

    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await commands.runSeats({
      ...commands.buildDefaultSeatCommandDeps(),
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    })).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('')).toMatch(/builder-active\s+alpha\s+active\s+-\s+.*active-worktree/);
    expect(stdout.join('')).toMatch(/builder-sibling\s+beta\s+active\s+-\s+.*sibling-worktree/);
    expect(stdout.join('')).toMatch(/builder-pending\s+alpha\s+pending\s+-\s+.*pending-worktree/);
    expect(await cubes.getActiveCubeForWorktree(pendingWorktree)).toBeNull();

    const launchBareBorg = vi.fn(async () => 0);
    stderr.length = 0;
    expect(await commands.runLaunchSeat({ target: 'builder-pending' }, {
      ...commands.buildDefaultSeatCommandDeps(),
      launchBareBorg,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    })).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: drone 'builder-pending' is not fully assimilated (shown as `pending` in `borg drones`) — " +
      'its assimilation did not complete, so launching now would start an unattached session. ' +
      `To finish it, run \`borg assimilate\` in ${pendingWorktree}, then run ` +
      '`borg launch builder-pending` again.\n',
    );
    expect(launchBareBorg).not.toHaveBeenCalled();

    const missingLaunchBareBorg = vi.fn(async () => 0);
    stderr.length = 0;
    expect(await commands.runLaunchSeat({ target: 'builder-pending' }, {
      ...commands.buildDefaultSeatCommandDeps(),
      pathExists: (path) => path !== pendingWorktree,
      launchBareBorg: missingLaunchBareBorg,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    })).toBe(1);
    expect(stderr.join('')).toBe(
      `borg launch: drone 'builder-pending' is registered at ${pendingWorktree}, but that directory does not exist. ` +
      'Restore the directory, or run `borg cleanup` to review orphaned worktrees.\n',
    );
    expect(missingLaunchBareBorg).not.toHaveBeenCalled();

    const activeLaunchBareBorg = vi.fn(async () => 0);
    stderr.length = 0;
    expect(await commands.runLaunchSeat({ target: 'builder-active' }, {
      ...commands.buildDefaultSeatCommandDeps(),
      launchBareBorg: activeLaunchBareBorg,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    })).toBe(0);
    expect(stderr).toEqual([]);
    expect(activeLaunchBareBorg).toHaveBeenCalledOnce();

    const racedLaunchBareBorg = vi.fn(async (worktree, expectation) => {
      const priorExpectation = process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV];
      const encodedExpectation =
        cubes.withLaunchSeatExpectationEnv({}, expectation)[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV]!;
      process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = encodedExpectation;
      try {
        await expect(cubes.getActiveCubeForWorktree(worktree)).resolves.toMatchObject({
          cubeId: CUBE_B,
          droneId: DRONE_B,
          droneLabel: 'builder-sibling',
        });
        process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = `${encodedExpectation}!`;
        await expect(cubes.getActiveCubeForWorktree(worktree)).rejects.toMatchObject({
          name: 'LaunchSeatIdentityChangedError',
        });
        process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = encodedExpectation;
        await seats.clearSeat(expectation.credentialRef);
        await expect(cubes.getActiveCubeForWorktree(worktree)).rejects.toMatchObject({
          name: 'LaunchSeatIdentityChangedError',
          message:
            "borg launch: did not launch 'builder-sibling' — its registration changed before the launch could start. " +
            'Run `borg drones` to see the current state, then try again.',
        });
        return 1;
      } finally {
        if (priorExpectation === undefined) delete process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV];
        else process.env[cubes.BORG_LAUNCH_EXPECTED_SEAT_ENV] = priorExpectation;
      }
    });
    stderr.length = 0;
    expect(await commands.runLaunchSeat({ target: 'builder-sibling' }, {
      ...commands.buildDefaultSeatCommandDeps(),
      launchBareBorg: racedLaunchBareBorg,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    })).toBe(1);
    expect(racedLaunchBareBorg).toHaveBeenCalledOnce();
    expect(stderr).toEqual([]);
  });
});

describe('borg launch', () => {
  it('launches an unambiguous label by running bare borg in the canonical worktree', async () => {
    const cube = activeCube({ worktree: '/linked/a' });
    const { deps, launchBareBorg } = depsFor([cube]);

    expect(await runLaunchSeat({ target: cube.droneLabel }, deps)).toBe(0);
    expect(launchBareBorg).toHaveBeenCalledWith('/real/a', expect.objectContaining({
      cubeId: CUBE_A,
      droneId: DRONE_A,
      worktree: '/real/a',
      droneLabel: cube.droneLabel,
    }));
  });

  it('accepts an unambiguous drone id prefix', async () => {
    const cube = activeCube();
    const { deps, launchBareBorg } = depsFor([cube]);

    expect(await runLaunchSeat({ target: DRONE_A.slice(0, 8) }, deps)).toBe(0);
    expect(launchBareBorg).toHaveBeenCalledWith('/work/a', expect.objectContaining({
      cubeId: CUBE_A,
      droneId: DRONE_A,
      worktree: '/work/a',
      droneLabel: cube.droneLabel,
    }));
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
    expect(launchBareBorg).toHaveBeenCalledWith('/work/b', expect.objectContaining({
      cubeId: CUBE_B,
      droneId: DRONE_B,
      worktree: '/work/b',
      droneLabel: second.droneLabel,
    }));
  });

  it('reports an unknown --cube name without denying a registered drone match', async () => {
    const cube = activeCube();
    const { deps, stderr, launchBareBorg } = depsFor([cube]);

    expect(await runLaunchSeat({ target: cube.droneLabel, cube: 'typo-cube' }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: no cube named 'typo-cube' is registered on this machine. " +
      "Run `borg drones` to list this machine's cubes and drones.\n",
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('reports a target missing from the selected cube without denying its other-cube match', async () => {
    const first = activeCube();
    const second = activeCube({
      cubeId: CUBE_B,
      droneId: DRONE_B,
      name: 'beta',
      droneLabel: 'reviewer-bbbbbbbb',
      worktree: '/work/b',
    });
    const { deps, stderr, launchBareBorg } = depsFor([first, second]);

    expect(await runLaunchSeat({ target: first.droneLabel, cube: 'beta' }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: no drone matches 'builder-aaaaaaaa' in cube 'beta'. " +
      "Run `borg drones` to list the drones you can launch.\n",
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('reports an unknown target and points to borg drones', async () => {
    const { deps, stderr, launchBareBorg } = depsFor([activeCube()]);

    expect(await runLaunchSeat({ target: 'builder-deadbeef' }, deps)).toBe(1);
    const output = stderr.join('');
    expect(output).toBe(
      "borg launch: no drone matches 'builder-deadbeef' on this machine. Run `borg drones` to list the drones you can launch.\n",
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('fails closed when the preferred hydration identity can no longer be read', async () => {
    const cube = activeCube();
    const { deps, stderr, launchBareBorg } = depsFor([cube], {
      getActiveSeatForWorktree: vi.fn(async () => { throw new Error('store changed'); }),
    });

    expect(await runLaunchSeat({ target: cube.droneLabel }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: did not launch 'builder-aaaaaaaa' — its registration changed before the launch could start. " +
      'Run `borg drones` to see the current state, then try again.\n',
    );
    expect(launchBareBorg).not.toHaveBeenCalled();
  });

  it('explains the per-machine registry when no local drones exist', async () => {
    const { deps, stderr } = depsFor([]);
    expect(await runLaunchSeat({ target: 'builder-deadbeef' }, deps)).toBe(1);
    expect(stderr.join('')).toBe(
      "borg launch: drone 'builder-deadbeef' is not in this machine's registry. " +
      'The registry is local to each machine and lists only drones assimilated here. ' +
      'Run `borg drones` on the machine where the drone was created.\n',
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
