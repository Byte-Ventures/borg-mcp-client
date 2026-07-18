import { describe, it, expect, vi } from 'vitest';
import { runLaunchAll, resolveLaunchDelayMs, DEFAULT_LAUNCH_DELAY_MS } from '../src/launch-all-cmd';
import type { LaunchAllDeps } from '../src/launch-all-deps';
import type { ActiveCube } from '../src/cubes';

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
      apiUrl: 'http://api.test',
    } as ActiveCube,
  }));
  return { paths, identities };
}

function makeStubDeps(over: Partial<LaunchAllDeps> = {}): LaunchAllDeps {
  return {
    runSync: vi.fn(() => ''), // tmux/uname/git all succeed empty unless overridden
    runSyncExitCode: vi.fn(() => 1), // has-session: absent
    attachInteractive: vi.fn(),
    cwd: vi.fn(() => '/work/myrepo'),
    pathExists: vi.fn(() => true),
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

describe('runLaunchAll (gh#556 Part 2 §11.5)', () => {
  it('no cube argument + no active cube → error, exit 1', async () => {
    const deps = makeStubDeps({ getActiveCube: vi.fn(async () => null) });
    expect(await runLaunchAll({ flags: {} }, deps, OPTS)).toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('no active cube'));
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
      'sess',
      'http://api.test',
      '2026-06-13T12:00:00.000Z',
      'spki-sha256:local-server',
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

  it('--cube-name that matches >1 cube → ambiguity error listing each id, exit 1 (gh#850)', async () => {
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
    expect(stdoutOf(deps)).toContain('assimilate --here');
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
    expect(stdoutOf(auto)).toContain('assimilate --here'); // pastelist
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
      { projectPath: paths[0], cube: { cubeId: CUBE_ID, droneId: did(1), name: 'myrepo', sessionToken: 'tok-a', droneLabel: 'drone-a', apiUrl: 'http://api.test' } as ActiveCube },
      { projectPath: paths[1], cube: { cubeId: CUBE_ID, droneId: did(2), name: 'myrepo', sessionToken: 'tok-b', droneLabel: 'drone-b', apiUrl: 'http://api.test' } as ActiveCube },
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
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'evicted' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toContain('drone-b');
    expect(stderrOf(deps)).toMatch(/seat no longer in cube \(evicted\)/);
    const tokens = (deps.probeSeat as any).mock.calls.map((c: any[]) => c[0]);
    expect(tokens).toContain('tok-a');
    expect(tokens).toContain('tok-b');
  });

  it('ALL seats evicted → nothing to launch (the 4b post-server-gate early-return), exit 0, backend never invoked', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'evicted');
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    // 4b-specific phrasing — distinct from the 4a lock-live 'appear live; nothing to launch'.
    expect(stdoutOf(deps)).toMatch(/are not launchable .*nothing to launch/);
    expect(dispatched(deps)).toBe(false);
  });

  it('a REJECTED seat is SKIPPED (not launched, not pruned) with the EXECUTABLE bound recovery (reset → scoped invite → assimilate --enroll)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'rejected' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    // The live seat still launches; the rejected one is skipped, never launched.
    expect(dispatched(deps)).toBe(true);
    const err = stderrOf(deps);
    expect(err).toMatch(/drone-b.*no longer accepted/);
    // The full executable recovery contract — no inference required from the
    // aggregate launch surface: reset THIS worktree → operator mints a scoped
    // invitation while the server stays running → the exact assimilate command.
    expect(err).toContain('borg reset-local-seat');
    expect(err).toMatch(/scoped invitation \(the server stays running\)/);
    expect(err).toMatch(/borg assimilate --host \S+ --enroll/);
    expect(err).not.toMatch(/drone-b.*evicted/);
  });

  it('ALL seats rejected → nothing launched, accurate summary (never called "evicted")', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async () => 'rejected');
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(false);
    const out = stdoutOf(deps);
    expect(out).toMatch(/are not launchable .*nothing to launch/);
    // Accurate cause counts — an all-rejected sweep must NOT claim "evicted".
    expect(out).toContain('no longer accepted');
    expect(out).not.toMatch(/evicted/);
  });

  it('an INDETERMINATE (transient) seat is LAUNCHED (fail-OPEN) with a soft note', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'indeterminate' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(true);
    expect(stderrOf(deps)).toMatch(/could not confirm drone-b.*launching anyway/);
  });

  it('SR-seven (b): a TRUST-MISMATCH seat is a TERMINAL SKIP (never fail-open-launched)', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'trust-mismatch' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
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
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
    expect(dispatched(deps)).toBe(false);
    expect(stdoutOf(deps)).toMatch(/changed \(terminal\) server identity/);
  });

  it('SR-seven (b): a CREDENTIAL-REJECTED seat is a cause-accurate SKIP (not fail-open), re-enroll guidance', async () => {
    const { identities } = twoSeats();
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'credential-rejected' : 'live'));
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
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
    const deps = depsFor(identities, async (token) => (token === 'tok-b' ? 'evicted' : 'live'));
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
    const deps = depsFor(identities, async (token) => statusByTok[token]);
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
    const deps = depsFor(identities, async (token) => {
      if (token === 'tok-b') throw new Error('network down');
      return 'live';
    });
    expect(await runLaunchAll({ flags: { yes: true } }, deps, OPTS)).toBe(0);
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
