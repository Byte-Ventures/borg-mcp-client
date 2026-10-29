import { describe, it, expect, vi } from 'vitest';
import {
  runLaunchAll,
  resolveLaunchDelayMs,
  DEFAULT_LAUNCH_DELAY_MS,
  LAUNCH_ALL_NO_DISPATCH_EXIT_CODE,
} from '../src/launch-all-cmd';
import type { LaunchAllDeps } from '../src/launch-all-deps';
import type { ActiveCube } from '../src/cubes';
import { parseLaunchAllArgs } from '../src/parse-launch-all-args';

const CUBE_ID = '11111111-1111-1111-1111-111111111111';
function did(n: number): string {
  return `${String(n).padStart(8, '0')}-0000-0000-0000-000000000000`;
}
function porcelainFor(paths: string[]): string {
  return ['worktree /work/myrepo\nHEAD a\nbranch refs/heads/main', ...paths.map((p) => `worktree ${p}\nHEAD b\nbranch refs/heads/wt-x`)].join('\n\n') + '\n';
}

// Build N drone worktrees: porcelain + cubes.json identities all in CUBE_ID.
function fleet(n: number): { paths: string[]; identities: Array<{ projectPath: string; cube: ActiveCube }> } {
  const paths = Array.from({ length: n }, (_, i) => `/home/test/.borg/worktrees/myrepo/d${i + 1}`);
  const identities = paths.map((p, i) => ({
    projectPath: p,
    cube: {
      cubeId: CUBE_ID,
      droneId: did(i + 1),
      name: 'myrepo',
      sessionToken: 'sess',
      droneLabel: `drone-${i + 1}`,
      isHumanSeat: false,
      apiUrl: 'http://api.test',
    } as ActiveCube,
  }));
  return { paths, identities };
}

function makeStubDeps(over: Partial<LaunchAllDeps> = {}): LaunchAllDeps {
  return {
    isCliInstalled: vi.fn(() => true),
    runSync: vi.fn(() => ''), // tmux/uname/git all succeed empty unless overridden
    runSyncExitCode: vi.fn(() => 1), // has-session: absent
    attachInteractive: vi.fn(),
    spawnDetached: vi.fn(async () => {}),
    cwd: vi.fn(() => '/work/myrepo'),
    pathExists: vi.fn((p: string) => !p.endsWith('.app')),
    homedir: vi.fn(() => '/home/test'),
    mkdirp: vi.fn(),
    readFileOpt: vi.fn(() => null), // no live locks
    writeFile: vi.fn(),
    unlinkOpt: vi.fn(),
    statMtime: vi.fn(() => null),
    listDir: vi.fn(() => []),
    getCachedAuth: vi.fn(async () => ({ token: 't', apiUrl: 'http://api.test' })),
    getRoster: vi.fn(async () => ({ drones: [] })),
    getCube: vi.fn(async () => ({ id: CUBE_ID, name: 'myrepo', roles: [] })),
    probeAuthority: vi.fn(async () => {}),
    probeSeat: vi.fn(async () => 'live' as const), // server-liveness gate: default live
    getCliPreferenceForPath: vi.fn(async () => null),
    readAllProjectIdentities: vi.fn(async () => []),
    findProjectRoot: vi.fn((d: string) => d),
    getActiveCube: vi.fn(async () => null),
    prompt: vi.fn(async () => 'n'),
    isTTY: vi.fn(() => false), // default non-TTY → no attach in tests
    getEnv: vi.fn(() => undefined),
    platform: vi.fn(() => 'darwin'),
    stderr: vi.fn(),
    stdout: vi.fn(),
    ...over,
  };
}

// Fixed clock — the orchestrator's reconcile loop is bounded to 20 polls, so a
// static clock terminates it (with sleep() a no-op the polls are instant).
const OPTS = { borgPath: '/usr/local/bin/borg', nowISO: () => '2026-06-13T12:00:00.000Z', sleep: async () => {}, now: () => 1000 };
function stdoutOf(deps: LaunchAllDeps): string {
  return (deps.stdout as any).mock.calls.map((c: any[]) => c[0]).join('');
}
function stderrOf(deps: LaunchAllDeps): string {
  return (deps.stderr as any).mock.calls.map((c: any[]) => c[0]).join('');
}

function backendLaunchOrder(deps: LaunchAllDeps): string[] {
  return (deps.runSync as any).mock.calls
    .filter((call: any[]) => call[0] === 'tmux' && call[1]?.[0] === 'rename-window')
    .map((call: any[]) => call[1][3]);
}

function makeTmuxFleetDeps(
  paths: string[],
  identities: Array<{ projectPath: string; cube: ActiveCube }>,
  over: Partial<LaunchAllDeps> = {},
): LaunchAllDeps {
  return makeStubDeps({
    runSync: vi.fn((cmd: string, args: string[]) => {
      if (cmd === 'git') return porcelainFor(paths);
      if (cmd === 'tmux' && (args[0] === 'new-session' || args[0] === 'new-window')) return '@7\n';
      return '';
    }),
    readAllProjectIdentities: vi.fn(async () => identities),
    ...over,
  });
}

describe('runLaunchAll (gh#556 Part 2 §11.5)', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('rejects missing %s before any batch dispatch or marker', async (cli) => {
    for (const mode of [undefined, 'tmux', 'terminals'] as const) {
      const { paths, identities } = fleet(2);
      const deps = makeTmuxFleetDeps(paths, identities, {
        isTTY: vi.fn(() => true), pathExists: vi.fn(() => true),
        isCliInstalled: vi.fn(() => false),
      });
      expect(await runLaunchAll({ cubeName: 'myrepo', flags: { cli, mode } }, deps, OPTS)).toBe(1);
      expect(stderrOf(deps)).toContain(`${cli} CLI is not installed; nothing was launched.`);
      expect(deps.isCliInstalled).toHaveBeenCalledWith(cli);
      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(deps.mkdirp).not.toHaveBeenCalled();
      expect(deps.spawnDetached).not.toHaveBeenCalled();
      expect(deps.attachInteractive).not.toHaveBeenCalled();
      expect(deps.getRoster).not.toHaveBeenCalled();
      expect((deps.runSync as any).mock.calls.some(([cmd, args]: [string, string[]]) =>
        cmd === 'osascript' || ['new-session', 'new-window', 'send-keys'].includes(args[0])
      )).toBe(false);
    }
  });

  it('can preview and print a CLI that is not installed, without changing preferences', async () => {
    for (const flags of [{ cli: 'opencode', dryRun: true }, { cli: 'opencode', mode: 'pastelist' }] as const) {
      const { paths, identities } = fleet(2);
      const deps = makeTmuxFleetDeps(paths, identities, { isCliInstalled: vi.fn(() => false) });
      expect(await runLaunchAll({ cubeName: 'myrepo', flags }, deps, OPTS)).toBe(0);
      expect(stdoutOf(deps)).toContain('opencode');
      expect(deps.isCliInstalled).not.toHaveBeenCalled();
      expect(deps.writeFile).not.toHaveBeenCalled();
      expect(deps.spawnDetached).not.toHaveBeenCalled();
    }
  });

  it('keeps per-worktree CLI selection when no batch CLI is given', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeTmuxFleetDeps(paths, identities, { isCliInstalled: vi.fn(() => false) });
    expect(await runLaunchAll({ cubeName: 'myrepo', flags: { mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(deps.isCliInstalled).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'opencode'])('forwards --cli %s through tmux, terminal, and printed launches', async (cli) => {
    for (const mode of ['tmux', 'terminals', 'pastelist']) {
      const { paths, identities } = fleet(2);
      const deps = makeTmuxFleetDeps(paths, identities, {
        isTTY: vi.fn(() => true),
        pathExists: vi.fn(() => true),
        getCliPreferenceForPath: vi.fn(async () => 'codex'),
      });
      const parsed = parseLaunchAllArgs(['myrepo', '--cli', cli, '--mode', mode, '--no-attach']);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(await runLaunchAll(parsed.args, deps, OPTS)).toBe(0);
      const commands = mode === 'pastelist'
        ? stdoutOf(deps)
        : (deps.runSync as any).mock.calls
          .filter(([cmd, args]: [string, string[]]) => cmd === 'osascript' || args[0] === 'send-keys')
          .map(([, args]: [string, string[]]) => args.join(' ')).join('\n');
      for (const { cube } of identities) {
        expect(commands).toContain(`launch '${cube.droneId}' --cli '${cli}'`);
      }
    }
  });

  it('passes the CLI to both worker and human-seat launches in default split mode', async () => {
    const { paths, identities } = fleet(2);
    identities[1].cube.isHumanSeat = true;
    const deps = makeTmuxFleetDeps(paths, identities, {
      isTTY: vi.fn(() => true),
      pathExists: vi.fn(() => true),
    });
    expect(await runLaunchAll({ cubeName: 'myrepo', flags: { cli: 'opencode', noAttach: true } }, deps, OPTS)).toBe(0);
    const calls = (deps.runSync as any).mock.calls;
    expect(calls.find(([cmd, args]: [string, string[]]) => cmd === 'tmux' && args[0] === 'send-keys')[1][3])
      .toContain(`launch '${did(1)}' --cli 'opencode'`);
    expect(calls.find(([cmd]: [string]) => cmd === 'osascript')[1][1])
      .toContain(`launch '${did(2)}' --cli 'opencode'`);
  });

  it('previews the override without starting or changing any drone', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeTmuxFleetDeps(paths, identities);
    expect(await runLaunchAll({ cubeName: 'myrepo', flags: { cli: 'opencode', dryRun: true } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('[tmux] [opencode]');
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect((deps.runSync as any).mock.calls.some(([, args]: [string, string[]]) => args[0] === 'new-session')).toBe(false);
  });

  it('keeps --only and live-session skips when a CLI is selected', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeTmuxFleetDeps(paths, identities, {
      readFileOpt: vi.fn(() => JSON.stringify({ launchedAt: new Date(1000).toISOString() })),
    });
    expect(await runLaunchAll({ cubeName: 'myrepo', flags: { cli: 'opencode', only: 'drone-1', mode: 'pastelist' } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).not.toContain("--cli 'opencode'");
    expect(deps.probeSeat).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('no cube argument + no active cube + no repo drone worktrees → cause-accurate error, exit 1', async () => {
    const deps = makeStubDeps({ getActiveCube: vi.fn(async () => null) });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(1);
    const error = stderrOf(deps);
    expect(error).toContain('no saved drone worktrees');
    expect(error).toContain('borg launch-all <cube-name>');
    expect(error).toContain('cd into a drone worktree');
    expect(error).not.toContain('borg assimilate');
  });

  it('positional cube name dedupes two saved seats with the same cubeId', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });

    expect(await runLaunchAll({ cubeName: 'myrepo', flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('dry-run');
    expect(stderrOf(deps)).not.toContain('ambiguous');
  });

  it('no-name launch from a seatless main checkout infers the one cube in linked drone worktrees', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });

    expect(await runLaunchAll({ flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('dry-run');
    expect(stderrOf(deps)).not.toContain('borg assimilate');
  });

  it('no-name launch from a seatless main checkout refuses when linked worktrees span two cubes', async () => {
    const paths = ['/home/test/.borg/worktrees/myrepo/a', '/home/test/.borg/worktrees/myrepo/b'];
    const identities = [
      { projectPath: paths[0], cube: { cubeId: CUBE_ID, droneId: did(1), name: 'cube-a', sessionToken: 's', droneLabel: 'drone-1', apiUrl: 'http://api.test' } as ActiveCube },
      { projectPath: paths[1], cube: { cubeId: '22222222-2222-2222-2222-222222222222', droneId: did(2), name: 'cube-b', sessionToken: 's', droneLabel: 'drone-2', apiUrl: 'http://api.test' } as ActiveCube },
    ];
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });

    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(1);
    const error = stderrOf(deps);
    expect(error).toContain('belong to 2 cubes');
    expect(error).toContain('borg launch-all <cube-name>');
    expect(error).toContain('cd into a drone worktree');
    expect(error).not.toContain('borg assimilate');
  });

  it('zero candidates after discovery → message + exit 0', async () => {
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor([])),
      readAllProjectIdentities: vi.fn(async () => []),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('No worktrees found for cube');
  });

  it('zero candidates after --only → message + exit 0', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll({ flags: { only: 'nonexistent' } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain("No worktrees matched --only 'nonexistent'");
  });

  it('7 candidates + no --yes + prompt n → no launch, exit 0', async () => {
    const { paths, identities } = fleet(7);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      prompt: vi.fn(async () => 'n'),
      isTTY: vi.fn(() => true),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(deps.prompt).toHaveBeenCalled();
    // no tmux new-session dispatched
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(false);
  });

  it('7 candidates + --yes → no prompt, dispatches', async () => {
    const { paths, identities } = fleet(7);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(true);
  });

  it('--dry-run → no launch, candidates printed, exit 0', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll({ flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('dry-run');
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(false);
  });

  it('an internal quickstart roster filter excludes other saved cube drones', async () => {
    const { paths, identities } = fleet(2);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll(
      { flags: { dryRun: true } },
      deps,
      { ...OPTS, droneIds: [did(2)] },
    )).toBe(0);
    expect(stdoutOf(deps)).toContain('drone-2');
    expect(stdoutOf(deps)).not.toContain('drone-1');
  });

  it('quickstart dispatches the default human seat after every worker without changing worker order', async () => {
    const { paths, identities } = fleet(4);
    identities[0].cube.droneLabel = 'coordinator-1';
    identities[0].cube.roleName = 'Coordinator';
    identities[0].cube.isHumanSeat = true;
    identities[1].cube.droneLabel = 'builder-1';
    identities[1].cube.isHumanSeat = false;
    identities[2].cube.droneLabel = 'code-reviewer-1';
    identities[2].cube.isHumanSeat = false;
    identities[3].cube.droneLabel = 'release-quality-1';
    identities[3].cube.isHumanSeat = false;
    const deps = makeTmuxFleetDeps(paths, identities);

    expect(await runLaunchAll(
      { flags: { mode: 'tmux' } },
      deps,
      {
        ...OPTS,
        droneIds: identities.map(({ cube }) => cube.droneId),
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
        humanSeatLast: true,
      },
    )).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['builder-1', 'code-reviewer-1', 'release-quality-1', 'coordinator-1']);
    expect(deps.getRoster).toHaveBeenCalledWith(identities[0].cube, '2026-06-13T12:00:00.000Z');
    expect(stdoutOf(deps).indexOf('coordinator-1')).toBeLessThan(stdoutOf(deps).indexOf('builder-1'));
  });

  it('quickstart uses persisted human-seat metadata rather than role or label conventions', async () => {
    const { paths, identities } = fleet(3);
    identities[1].cube.droneLabel = 'custom-authority';
    identities[1].cube.roleName = 'Builder';
    identities[1].cube.isHumanSeat = true;
    const deps = makeTmuxFleetDeps(paths, identities);

    expect(await runLaunchAll(
      { flags: { mode: 'tmux' } },
      deps,
      {
        ...OPTS,
        droneIds: identities.map(({ cube }) => cube.droneId),
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
        humanSeatLast: true,
      },
    )).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-1', 'drone-3', 'custom-authority']);
  });

  it('quickstart preserves discovery order when no persisted human seat exists', async () => {
    const { paths, identities } = fleet(3);
    for (const { cube } of identities) cube.isHumanSeat = false;
    const deps = makeTmuxFleetDeps(paths, identities);

    expect(await runLaunchAll(
      { flags: { mode: 'tmux' } },
      deps,
      {
        ...OPTS,
        droneIds: identities.map(({ cube }) => cube.droneId),
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
        humanSeatLast: true,
      },
    )).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-1', 'drone-2', 'drone-3']);
  });

  it('ordinary launch-all preserves discovery order even when a persisted human seat is first', async () => {
    const { paths, identities } = fleet(3);
    identities[0].cube.isHumanSeat = true;
    const deps = makeTmuxFleetDeps(paths, identities, {
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
    });

    expect(await runLaunchAll({ flags: { mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-1', 'drone-2', 'drone-3']);
  });

  it('a strict internal roster filter fails instead of misreporting a missing registration as launched', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll(
      { flags: { dryRun: true } },
      deps,
      { ...OPTS, droneIds: [did(1), did(2)], requireAllRequested: true },
    )).toBe(1);
    expect(stderrOf(deps)).toContain('found 1 of 2 requested registered drone worktrees');
    expect(stdoutOf(deps)).not.toContain('would launch');
  });

  it('a strict internal roster fails when a requested saved drone is terminally unlaunchable', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      probeSeat: vi.fn(async () => 'evicted' as const),
    });
    expect(await runLaunchAll(
      { flags: {} },
      deps,
      {
        ...OPTS,
        droneIds: [did(1)],
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
      },
    )).toBe(1);
    expect(stderrOf(deps)).toContain('1 requested registered drone(s) are not launchable');
    expect(stdoutOf(deps)).not.toContain('launched');
  });

  it('roster reconcile: seen_since true → VERIFIED in summary', async () => {
    const { paths, identities } = fleet(1);
    identities[0].cube.serverTrustIdentity = 'spki-sha256:local-server';
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      getRoster: vi.fn(async () => ({ drones: [{ id: did(1), seen_since: true }] })),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('VERIFIED');
    expect(deps.getRoster).toHaveBeenCalledWith(
      identities[0].cube,
      '2026-06-13T12:00:00.000Z',
    );
  });

  it('roster reconcile: getRoster throws → skipped, still exit 0', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      getRoster: vi.fn(async () => { throw new Error('network'); }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain('unconfirmed');
  });

  it('roster reconcile: getRoster throws → surfaces a "confirmation skipped" reason (gh#850)', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      getRoster: vi.fn(async () => { throw new Error('network'); }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(stderrOf(deps)).toContain('roster confirmation skipped');
    expect(stderrOf(deps)).toContain('network');
  });

  it('roster reconcile: 401 (token rotated) → "token rotated mid-launch" reason (gh#850)', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      getRoster: vi.fn(async () => { throw new Error('Authentication required. Run: borg setup'); }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(stderrOf(deps)).toContain('roster confirmation skipped (token rotated mid-launch)');
  });

  it('positional cube name shared by two distinct cubeIds still refuses as ambiguous (gh#850)', async () => {
    const idA = '22222222-2222-2222-2222-222222222222';
    const idB = '33333333-3333-3333-3333-333333333333';
    const identities = [
      { projectPath: '/home/test/projA', cube: { cubeId: idA, droneId: did(1), name: 'dup', sessionToken: 's', droneLabel: 'drone-1', apiUrl: 'http://api.test' } as ActiveCube },
      { projectPath: '/home/test/projB', cube: { cubeId: idB, droneId: did(2), name: 'dup', sessionToken: 's', droneLabel: 'drone-1', apiUrl: 'http://api.test' } as ActiveCube },
    ];
    const deps = makeStubDeps({
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    expect(await runLaunchAll({ cubeName: 'dup', flags: {} }, deps, OPTS)).toBe(1);
    const err = stderrOf(deps);
    expect(err).toContain('ambiguous');
    expect(err).toContain(idA);
    expect(err).toContain(idB);
    expect(err).toContain('/home/test/projA');
    expect(err).toContain('re-run as `borg launch-all` without the positional cube name');
    expect(err).not.toContain('--cube-name');
  });

  it('native Windows → pastelist regardless of --mode tmux', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn((c: string, a: string[]) => (a[0] === 'list' ? porcelainFor(paths) : a?.[0] === 'worktree' ? porcelainFor(paths) : '')),
      readAllProjectIdentities: vi.fn(async () => identities),
      platform: vi.fn(() => 'win32'),
    });
    // git worktree list returns porcelain; everything else empty.
    (deps.runSync as any).mockImplementation((cmd: string, args: string[]) =>
      cmd === 'git' ? porcelainFor(paths) : ''
    );
    expect(await runLaunchAll({ flags: { mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('native Windows is not supported'));
    // pastelist printed cd lines; no tmux new-session
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(false);
    expect(stdoutOf(deps)).toContain(`launch '${did(1)}'`);
  });

  it('strict quickstart launch fails instead of treating native-Windows pastelist as dispatch', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      runSync: vi.fn((cmd: string) => cmd === 'git' ? porcelainFor(paths) : ''),
      readAllProjectIdentities: vi.fn(async () => identities),
      platform: vi.fn(() => 'win32'),
    });
    expect(await runLaunchAll(
      { flags: { mode: 'tmux' } },
      deps,
      {
        ...OPTS,
        droneIds: [did(1)],
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
      },
    )).toBe(LAUNCH_ALL_NO_DISPATCH_EXIT_CODE);
    expect(stderrOf(deps)).toContain('pastelist mode prints commands for manual use but does not launch sessions');
    expect(stdoutOf(deps)).not.toContain(`launch '${did(1)}'`);
  });

  it.each([
    '/Applications/iTerm.app',
    '/System/Applications/Utilities/Terminal.app',
  ])('macOS auto puts workers in tmux when %s exists', async (terminalApp) => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      pathExists: vi.fn((p: string) => p === terminalApp || paths.includes(p)),
      isTTY: vi.fn(() => true),
      runSync: vi.fn((cmd: string) => (cmd === 'git' ? porcelainFor(paths) : '')),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'osascript')).toBe(false);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(true);
  });

  it('macOS non-TTY auto never dispatches osascript and retains the prior pastelist fallback', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      pathExists: vi.fn((p: string) => p === '/Applications/iTerm.app' || paths.includes(p)),
      isTTY: vi.fn(() => false),
      runSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux' && args[0] === '-V') throw new Error('ENOENT');
        return '';
      }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'osascript')).toBe(false);
    expect(stdoutOf(deps)).toContain(`launch '${did(1)}'`);
    expect(stderrOf(deps)).toContain('Falling back to pastelist mode');
  });

  it('strict quickstart launch fails when auto selection falls back to pastelist', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      readAllProjectIdentities: vi.fn(async () => identities),
      isTTY: vi.fn(() => false),
      runSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux' && args[0] === '-V') throw new Error('ENOENT');
        return '';
      }),
    });
    expect(await runLaunchAll(
      { flags: {} },
      deps,
      {
        ...OPTS,
        droneIds: [did(1)],
        requireAllRequested: true,
        targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
      },
    )).toBe(LAUNCH_ALL_NO_DISPATCH_EXIT_CODE);
    expect(stderrOf(deps)).toContain('pastelist mode prints commands for manual use but does not launch sessions');
    expect(stdoutOf(deps)).not.toContain(`launch '${did(1)}'`);
  });

  it('explicit --mode terminals wins over tmux availability', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      pathExists: vi.fn((p: string) => p === '/System/Applications/Utilities/Terminal.app' || paths.includes(p)),
      runSync: vi.fn((cmd: string) => (cmd === 'git' ? porcelainFor(paths) : '')),
    });
    expect(await runLaunchAll({ flags: { mode: 'terminals' } }, deps, OPTS)).toBe(0);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'osascript')).toBe(true);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session')).toBe(false);
    expect(stdoutOf(deps)).not.toContain('Attach: tmux');
  });

  it('explicit --mode tmux wins over the macOS terminal-app default', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      pathExists: vi.fn((p: string) => p === '/Applications/iTerm.app' || paths.includes(p)),
      runSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux' && (args[0] === 'new-session' || args[0] === 'new-window')) return '@7\n';
        return '';
      }),
    });
    expect(await runLaunchAll({ flags: { mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'tmux' && c[1]?.[0] === 'new-session')).toBe(true);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'osascript')).toBe(false);
  });

  it('Linux auto stays tmux-first', async () => {
    const { paths, identities } = fleet(1);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      platform: vi.fn(() => 'linux'),
      getEnv: vi.fn((name: string) => (name === 'BORG_TERMINAL' ? 'kitty' : undefined)),
      runSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux' && (args[0] === 'new-session' || args[0] === 'new-window')) return '@7\n';
        return '';
      }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'tmux' && c[1]?.[0] === 'new-session')).toBe(true);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'kitty')).toBe(false);
  });

  it('live lock → skip + warn (no --force); --force → relaunch', async () => {
    const { paths, identities } = fleet(1);
    const live = JSON.stringify({ launchedAt: new Date().toISOString(), droneLabel: 'drone-1', worktreeDir: paths[0] });
    const base = (over: Partial<LaunchAllDeps>) => makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn((cmd: string) => (cmd === 'git' ? porcelainFor(paths) : '')),
      readAllProjectIdentities: vi.fn(async () => identities),
      readFileOpt: vi.fn(() => live),
      ...over,
    });
    const skip = base({});
    expect(await runLaunchAll({ flags: {} }, skip, OPTS)).toBe(0);
    expect(skip.stderr).toHaveBeenCalledWith(expect.stringContaining('appears live'));

    const forced = base({});
    await runLaunchAll({ flags: { force: true } }, forced, OPTS);
    expect(forced.stderr).toHaveBeenCalledWith(expect.stringContaining('--force: re-launching'));
  });

  it('tmux absent + --mode tmux → hard-fail exit 1; absent + no mode → pastelist + hint', async () => {
    const { paths, identities } = fleet(1);
    const mk = () => makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      readAllProjectIdentities: vi.fn(async () => identities),
      runSync: vi.fn((cmd: string, args: string[]) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux' && args[0] === '-V') throw new Error('ENOENT');
        if (cmd === 'uname') return 'Darwin';
        return '';
      }),
    });
    const hard = mk();
    expect(await runLaunchAll({ flags: { mode: 'tmux' } }, hard, OPTS)).toBe(1);
    expect(hard.stderr).toHaveBeenCalledWith(expect.stringContaining('tmux not found'));

    const auto = mk();
    expect(await runLaunchAll({ flags: {} }, auto, OPTS)).toBe(0);
    expect(stdoutOf(auto)).toContain(`launch '${did(1)}'`); // pastelist
  });
});

describe('default batch destinations', () => {
  function mixedFleet(over: Partial<LaunchAllDeps> = {}) {
    const { paths, identities } = fleet(3);
    identities[0].cube.isHumanSeat = true;
    identities[0].cube.droneLabel = 'custom-human';
    identities[0].cube.roleName = 'Builder';
    const deps = makeTmuxFleetDeps(paths, identities, {
      isTTY: vi.fn(() => true),
      pathExists: vi.fn(() => true),
      ...over,
    });
    return { deps, paths, identities };
  }

  it('launches workers in tmux, the human in a terminal, then attaches and reconciles everyone', async () => {
    const { deps, identities } = mixedFleet();
    const sleep = vi.fn(async () => {});
    expect(await runLaunchAll({ flags: {} }, deps, { ...OPTS, sleep })).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-2', 'drone-3']);
    const calls = (deps.runSync as any).mock.calls;
    const scripts = calls.filter((c: any[]) => c[0] === 'osascript');
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1][1]).toContain(did(1));
    const terminalCall = calls.findIndex((c: any[]) => c[0] === 'osascript');
    const lastWorker = calls.findLastIndex((c: any[]) => c[0] === 'tmux' && c[1][0] === 'send-keys');
    expect(terminalCall).toBeGreaterThan(lastWorker);
    expect((deps.attachInteractive as any).mock.invocationCallOrder[0]).toBeGreaterThan(
      (deps.runSync as any).mock.invocationCallOrder[terminalCall],
    );
    expect(sleep.mock.calls.filter((c: any[]) => c[0] === 2000)).toHaveLength(2);
    expect(deps.getRoster).toHaveBeenCalledWith(identities[0].cube, OPTS.nowISO());
    expect(stdoutOf(deps)).toContain('launched 3 drones');
    for (const { cube } of identities) expect(stdoutOf(deps)).toContain(cube.droneLabel);
  });

  it('dry-run shows destinations without dispatching', async () => {
    const { deps, paths } = mixedFleet();
    expect(await runLaunchAll({ flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    expect(stdoutOf(deps)).toContain(`custom-human  ${paths[0]}  [terminal]`);
    expect(stdoutOf(deps)).toContain(`drone-2  ${paths[1]}  [tmux]`);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect(deps.attachInteractive).not.toHaveBeenCalled();
  });

  it('uses fresh probe metadata rather than a stale saved classification', async () => {
    const { deps } = mixedFleet({
      probeSeat: vi.fn(async (seat) => {
        seat.isHumanSeat = seat.droneId === did(2);
        return 'live';
      }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['custom-human', 'drone-3']);
    const scripts = (deps.runSync as any).mock.calls.filter((c: any[]) => c[0] === 'osascript');
    expect(scripts[0][1][1]).toContain(did(2));
  });

  it('keeps unknown identities out of tmux without dropping them', async () => {
    const { deps, identities } = mixedFleet();
    delete identities[1].cube.isHumanSeat;
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-3']);
    expect((deps.runSync as any).mock.calls.filter((c: any[]) => c[0] === 'osascript')).toHaveLength(2);
    expect(stderrOf(deps)).toContain('identity is unknown');
  });

  it.each(['darwin', 'linux'] as const)('falls back to terminals when tmux is missing on %s', async (platform) => {
    const { deps, paths } = mixedFleet({
      platform: vi.fn(() => platform),
      runSyncExitCode: vi.fn(() => 0),
      getEnv: vi.fn((name) => name === 'BORG_TERMINAL' ? 'kitty' : name === 'DISPLAY' ? ':0' : undefined),
      runSync: vi.fn((cmd, args) => {
        if (cmd === 'git') return porcelainFor(paths);
        if (cmd === 'tmux') throw new Error('ENOENT');
        return '';
      }),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    const terminal = platform === 'darwin' ? 'osascript' : 'kitty';
    const calls = platform === 'darwin' ? (deps.runSync as any).mock.calls : (deps.spawnDetached as any).mock.calls;
    expect(calls.filter((c: any[]) => c[0] === terminal)).toHaveLength(3);
    expect(stderrOf(deps)).toContain('Falling back to terminals for all drones');
    expect(deps.attachInteractive).not.toHaveBeenCalled();
  });

  it('preflights human terminal support before launching any workers', async () => {
    const { deps } = mixedFleet({ pathExists: vi.fn((p) => !p.endsWith('.app')) });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect(stdoutOf(deps)).toContain(`launch '${did(1)}'`);
    expect(stdoutOf(deps)).toContain(`launch '${did(2)}'`);
    expect(stderrOf(deps)).toContain('A terminal is required');
  });

  it('rejects an unsafe human terminal path before creating worker windows', async () => {
    const { deps, paths, identities } = mixedFleet();
    paths[0] += '\x01';
    identities[0].projectPath = paths[0];
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(1);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect(stderrOf(deps)).toContain('nothing was launched');
  });

  it.each(['indeterminate', 'unreachable', 'server-failure'] as const)(
    'routes a cached worker to a terminal when its current identity is unverified: %s', async (status) => {
      const { deps } = mixedFleet({ probeSeat: vi.fn(async () => status) });
      expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
      expect(backendLaunchOrder(deps)).toEqual([]);
      expect((deps.runSync as any).mock.calls.filter((c: any[]) => c[0] === 'osascript')).toHaveLength(3);
    },
  );

  it('treats a thrown identity probe as unknown rather than using cached worker metadata', async () => {
    const { deps } = mixedFleet({ probeSeat: vi.fn(async () => { throw new Error('timeout'); }) });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect((deps.runSync as any).mock.calls.filter((c: any[]) => c[0] === 'osascript')).toHaveLength(3);
  });

  it.each([undefined, '   '])('does not start workers on Linux without a graphical display: %j', async (display) => {
    const { deps } = mixedFleet({
      platform: vi.fn(() => 'linux'),
      runSyncExitCode: vi.fn(() => 0),
      getEnv: vi.fn((name) => name === 'BORG_TERMINAL' ? 'kitty' : name === 'DISPLAY' ? display : undefined),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect(deps.spawnDetached).not.toHaveBeenCalled();
    expect(stdoutOf(deps)).toContain(`launch '${did(1)}'`);
  });

  it.each(['DISPLAY', 'WAYLAND_DISPLAY'])('allows Linux split dispatch with %s', async (displayVariable) => {
    const { deps } = mixedFleet({
      platform: vi.fn(() => 'linux'),
      runSyncExitCode: vi.fn(() => 0),
      getEnv: vi.fn((name) => name === 'BORG_TERMINAL' ? 'kitty' : name === displayVariable ? ':0' : undefined),
    });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-2', 'drone-3']);
    expect(deps.spawnDetached).toHaveBeenCalledTimes(1);
  });

  it('quickstart keeps its full requested roster with the split', async () => {
    const { deps, identities } = mixedFleet();
    expect(await runLaunchAll({ flags: { yes: true } }, deps, {
      ...OPTS, droneIds: identities.map(({ cube }) => cube.droneId),
      requireAllRequested: true, humanSeatLast: true,
      targetCube: { cubeId: CUBE_ID, name: 'myrepo' },
    })).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual(['drone-2', 'drone-3']);
    expect(stdoutOf(deps)).toContain('launched 3 drones');
  });

  it('human-only batches do not create or attach to an empty tmux session', async () => {
    const { deps, identities } = mixedFleet();
    identities.splice(1);
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toEqual([]);
    expect(deps.attachInteractive).not.toHaveBeenCalled();
    expect(stdoutOf(deps)).not.toContain('Attach:');
  });

  it.each([{ noAttach: true }, {}])('worker-only headless batches launch detached: %j', async (flags) => {
    const { deps, identities } = mixedFleet({ isTTY: vi.fn(() => false) });
    identities[0].cube.isHumanSeat = false;
    expect(await runLaunchAll({ flags }, deps, OPTS)).toBe(0);
    expect(backendLaunchOrder(deps)).toHaveLength(3);
    expect(deps.attachInteractive).not.toHaveBeenCalled();
  });
});

describe('runLaunchAll server-liveness gate (gh#877 follow-up — skip evicted seats)', () => {
  const stderrOf = (deps: LaunchAllDeps): string =>
    (deps.stderr as any).mock.calls.map((c: any[]) => c[0]).join('');
  const dispatched = (deps: LaunchAllDeps): boolean =>
    (deps.runSync as any).mock.calls.some((c: any[]) => c[1]?.[0] === 'new-session');

  // Two worktrees with DISTINCT saved tokens so probeSeat classifies per-seat.
  function twoSeats(): { paths: string[]; identities: Array<{ projectPath: string; cube: ActiveCube }> } {
    const paths = ['/home/test/.borg/worktrees/myrepo/a', '/home/test/.borg/worktrees/myrepo/b'];
    const identities = [
      { projectPath: paths[0], cube: { cubeId: CUBE_ID, droneId: did(1), name: 'myrepo', sessionToken: 'tok-a', droneLabel: 'drone-a', isHumanSeat: false, apiUrl: 'http://api.test' } as ActiveCube },
      { projectPath: paths[1], cube: { cubeId: CUBE_ID, droneId: did(2), name: 'myrepo', sessionToken: 'tok-b', droneLabel: 'drone-b', isHumanSeat: false, apiUrl: 'http://api.test' } as ActiveCube },
    ];
    return { paths, identities };
  }
  function depsFor(
    identities: Array<{ projectPath: string; cube: ActiveCube }>,
    probe: LaunchAllDeps['probeSeat'],
    extra: Partial<LaunchAllDeps> = {}
  ): LaunchAllDeps {
    const paths = identities.map((i) => i.projectPath);
    return makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
      probeSeat: vi.fn(probe),
      ...extra,
    });
  }

  it('skips an EVICTED seat, launches the live ones, probes EACH seat with its OWN token', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'evicted' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toContain('drone-b');
    expect(stderrOf(deps)).toMatch(/drone no longer in cube \(evicted\)/);
    const seats = (deps.probeSeat as any).mock.calls.map((c: any[]) => c[0]);
    expect(seats).toContain(identities[0].cube);
    expect(seats).toContain(identities[1].cube);
  });

  it('launches zero sessions when one readiness check finds a 9-drone authority unavailable', async () => {
    const { paths, identities } = fleet(9);
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn((cmd: string) => cmd === 'git' ? porcelainFor(paths) : ''),
      readAllProjectIdentities: vi.fn(async () => identities),
      probeAuthority: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    });

    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(1);
    expect(deps.probeAuthority).toHaveBeenCalledOnce();
    expect(deps.probeSeat).not.toHaveBeenCalled();
    expect(dispatched(deps)).toBe(false);
    expect(stderrOf(deps)).toContain('configured Borg authority is unavailable');
    expect(stderrOf(deps)).toContain('nothing was launched');
  });

  it('retains per-seat terminal refusals after the authority readiness check succeeds', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => seat.sessionToken === 'tok-b' ? 'revoked' : 'live');

    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(deps.probeAuthority).toHaveBeenCalledOnce();
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toContain('Local session was revoked.');
  });

  it('ALL seats evicted → nothing to launch (the 4b post-server-gate early-return), exit 0, backend never invoked', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'evicted');
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    // 4b-specific phrasing — distinct from the 4a lock-live 'appear live; nothing to launch'.
    expect(stdoutOf(deps)).toMatch(/are not launchable .*nothing to launch/);
    expect(dispatched(deps)).toBe(false);
  });

  it('a superseded seat is skipped with the exact bounded recovery', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'rejected' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toContain(
      'Local session was superseded by a newer enrollment.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host http://api.test --enroll.\n',
    );
  });

  it('a revoked seat is skipped with the distinct exact bounded recovery', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'revoked' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toContain(
      'Local session was revoked.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host http://api.test --enroll.\n',
    );
  });

  it('ALL seats rejected → nothing launched, accurate summary (never called "evicted")', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'rejected');
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(false);
    const out = stdoutOf(deps);
    expect(out).toMatch(/are not launchable .*nothing to launch/);
    expect(out).toContain('2 superseded');
    expect(out).not.toMatch(/evicted/);
  });

  it('an INDETERMINATE (transient) seat is LAUNCHED (fail-OPEN) with a soft note', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'indeterminate' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toMatch(/could not confirm drone-b.*launching anyway/);
  });

  it('SR-seven (b): a TRUST-MISMATCH seat is a TERMINAL SKIP (never fail-open-launched)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'trust-mismatch' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    // The live one launches; the trust-mismatch one is SKIPPED, not launched.
    expect(dispatched(deps)).toBe(true);
    const err = stderrOf(deps);
    expect(err).toMatch(/skipping drone-b.*could not verify the server identity/);
    expect(err).toMatch(/terminal/);
    expect(err).not.toMatch(/drone-b.*launching anyway/);
  });

  it('SR-seven (b): ALL trust-mismatch → nothing launched, terminal cause named (never fail-open)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'trust-mismatch');
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(false);
    expect(stdoutOf(deps)).toMatch(/changed \(terminal\) server identity/);
  });

  it('SR-seven (b): a CREDENTIAL-REJECTED seat is a cause-accurate SKIP (not fail-open), re-enroll guidance', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'credential-rejected' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    const err = stderrOf(deps);
    expect(err).toMatch(/skipping drone-b.*saved credential was rejected/);
    expect(err).toContain('--enroll');
    expect(err).not.toMatch(/drone-b.*launching anyway/);
  });

  it('--force does NOT override an eviction skip (distinct from the lock-live --force re-launch)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'evicted');
    expect(await runLaunchAll({ flags: { yes: true, force: true } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(false);
    expect(stdoutOf(deps)).toContain('nothing to launch');
  });

  it('--dry-run reflects the post-gate set (evicted seat omitted from the would-launch list)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => (seat.sessionToken === 'tok-b' ? 'evicted' : 'live'));
    expect(await runLaunchAll({ flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    const out = stdoutOf(deps);
    expect(out).toContain('drone-a');
    expect(out).not.toContain('drone-b');
  });

  it('a MIXED run (evicted + live + indeterminate) launches exactly live+indeterminate, skips evicted', async () => {
    const labels = ['ev', 'li', 'in'];
    const statusByTok: Record<string, 'evicted' | 'live' | 'indeterminate'> = {
      'tok-ev': 'evicted', 'tok-li': 'live', 'tok-in': 'indeterminate',
    };
    const identities = labels.map((l, i) => ({
      projectPath: `/home/test/.borg/worktrees/myrepo/${l}`,
      cube: { cubeId: CUBE_ID, droneId: did(i + 1), name: 'myrepo', sessionToken: `tok-${l}`, droneLabel: `drone-${l}`, apiUrl: 'http://api.test' } as ActiveCube,
    }));
    const deps = depsFor(identities, async (seat) => statusByTok[seat.sessionToken]);
    // dry-run prints exactly the post-gate would-launch set; the gate ran first.
    expect(await runLaunchAll({ flags: { dryRun: true } }, deps, OPTS)).toBe(0);
    const out = stdoutOf(deps);
    expect(out).toContain('drone-li');
    expect(out).toContain('drone-in'); // indeterminate launches (fail-OPEN)
    expect(out).not.toContain('drone-ev'); // evicted skipped
    const err = stderrOf(deps);
    expect(err).toMatch(/drone-ev.*evicted/);
    expect(err).toMatch(/could not confirm drone-in.*launching anyway/);
  });

  it('a probeSeat that THROWS is treated as indeterminate → LAUNCHED (fail-OPEN catch path)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (seat) => {
      if (seat.sessionToken === 'tok-b') throw new Error('network down');
      return 'live';
    });
    expect(await runLaunchAll({ flags: { yes: true, mode: 'tmux' } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toMatch(/could not confirm drone-b.*launching anyway/);
  });
});

describe('resolveLaunchDelayMs (flag > env > default)', () => {
  it('a valid non-negative flag wins over env + default (0 disables)', () => {
    expect(resolveLaunchDelayMs(500, '9999')).toBe(500);
    expect(resolveLaunchDelayMs(0, '9999')).toBe(0);
  });
  it('env wins when no flag is set', () => {
    expect(resolveLaunchDelayMs(undefined, '750')).toBe(750);
    expect(resolveLaunchDelayMs(undefined, '0')).toBe(0);
  });
  it('falls back to the default when neither flag nor env is a valid non-negative int', () => {
    expect(resolveLaunchDelayMs(undefined, undefined)).toBe(DEFAULT_LAUNCH_DELAY_MS);
    expect(resolveLaunchDelayMs(undefined, '')).toBe(DEFAULT_LAUNCH_DELAY_MS);
    expect(resolveLaunchDelayMs(undefined, '   ')).toBe(DEFAULT_LAUNCH_DELAY_MS); // whitespace-only must NOT silently disable
    expect(resolveLaunchDelayMs(undefined, 'abc')).toBe(DEFAULT_LAUNCH_DELAY_MS);
    expect(resolveLaunchDelayMs(undefined, '-5')).toBe(DEFAULT_LAUNCH_DELAY_MS);
    expect(resolveLaunchDelayMs(undefined, '1.5')).toBe(DEFAULT_LAUNCH_DELAY_MS);
  });
});

describe('runLaunchAll threads the resolved launch delay to the backend', () => {
  it('--launch-delay flag → the backend staggers with that exact value', async () => {
    const { paths, identities } = fleet(3);
    const sleep = vi.fn(async () => {});
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({ cubeId: CUBE_ID, name: 'myrepo' } as ActiveCube)),
      runSync: vi.fn(() => porcelainFor(paths)),
      readAllProjectIdentities: vi.fn(async () => identities),
    });
    await runLaunchAll({ flags: { yes: true, launchDelayMs: 1234 } }, deps, { ...OPTS, sleep });
    expect(sleep).toHaveBeenCalledWith(1234); // resolved delay reached the backend stagger
  });
});
