import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  worktreeLockName,
  lockPath,
  writeLockMarker,
  sweepStaleLocks,
  isLockLive,
  LOCK_STALE_MS,
} from '../src/launch-all-locks';
import { runPastelistBackend } from '../src/backends/launch-all-pastelist';
import { runTmuxBackend } from '../src/backends/launch-all-tmux';
import { runWindowsBackend } from '../src/backends/launch-all-windows';
import type { LaunchAllDeps } from '../src/launch-all-deps';
import type { DroneCandidate } from '../src/launch-all-discovery';

const CUBE_ID = '11111111-1111-1111-1111-111111111111';

function makeStubDeps(over: Partial<LaunchAllDeps> = {}): LaunchAllDeps {
  return {
    runSync: vi.fn(() => ''),
    runSyncExitCode: vi.fn(() => 1),
    attachInteractive: vi.fn(),
    cwd: vi.fn(() => '/work/myrepo'),
    pathExists: vi.fn(() => true),
    homedir: vi.fn(() => '/home/test'),
    mkdirp: vi.fn(),
    readFileOpt: vi.fn(() => null),
    writeFile: vi.fn(),
    unlinkOpt: vi.fn(),
    statMtime: vi.fn(() => null),
    listDir: vi.fn(() => []),
    getCachedAuth: vi.fn(async () => null),
    getRoster: vi.fn(async () => ({ drones: [] })),
    getCube: vi.fn(async () => ({ id: CUBE_ID, name: 'r', roles: [] })),
    getCliPreferenceForPath: vi.fn(async () => null),
    readAllProjectIdentities: vi.fn(async () => []),
    findProjectRoot: vi.fn((d: string) => d),
    getActiveCube: vi.fn(async () => null),
    prompt: vi.fn(async () => 'y'),
    isTTY: vi.fn(() => true),
    getEnv: vi.fn(() => undefined),
    stderr: vi.fn(),
    stdout: vi.fn(),
    ...over,
  };
}

function cand(over: Partial<DroneCandidate> = {}): DroneCandidate {
  return {
    worktreeDir: '/home/test/.borg/worktrees/myrepo/builder',
    cubeId: CUBE_ID,
    droneId: '00000001-0000-0000-0000-000000000000',
    droneLabel: 'drone-1',
    sessionToken: 'sess',
    apiUrl: 'http://api.test',
    ...over,
  };
}

describe('lock helpers (gh#556 Part 2 §6)', () => {
  it('worktreeLockName is the sha1 hex of the abs path', () => {
    const p = '/home/test/.borg/worktrees/myrepo/builder';
    expect(worktreeLockName(p)).toBe(createHash('sha1').update(p, 'utf8').digest('hex'));
    expect(worktreeLockName(p)).toHaveLength(40);
  });

  it('lockPath = ~/.config/borgmcp/locks/<cubeId>/<sha1>.pid', () => {
    const p = lockPath('/home/test', CUBE_ID, '/w/x');
    expect(p).toBe(`/home/test/.config/borgmcp/locks/${CUBE_ID}/${worktreeLockName('/w/x')}.pid`);
  });

  it('writeLockMarker mkdir-ps the cube locks dir + writes JSON marker mode 0600', () => {
    const deps = makeStubDeps();
    writeLockMarker(deps, CUBE_ID, 'drone-1', '/w/x', '2026-06-13T12:00:00.000Z');
    expect(deps.mkdirp).toHaveBeenCalledWith(`/home/test/.config/borgmcp/locks/${CUBE_ID}`);
    expect(deps.writeFile).toHaveBeenCalledWith(
      lockPath('/home/test', CUBE_ID, '/w/x'),
      JSON.stringify({ launchedAt: '2026-06-13T12:00:00.000Z', droneLabel: 'drone-1', worktreeDir: '/w/x' }),
      0o600
    );
  });

  it('sweepStaleLocks deletes mtime>5min markers, keeps fresh ones', () => {
    const now = 1_000_000_000_000;
    const deps = makeStubDeps({
      listDir: vi.fn(() => ['stale.pid', 'fresh.pid', 'notalock.txt']),
      statMtime: vi.fn((p: string) =>
        p.endsWith('stale.pid') ? now - (LOCK_STALE_MS + 1) : now - 1000
      ),
    });
    sweepStaleLocks(deps, CUBE_ID, now);
    const dir = `/home/test/.config/borgmcp/locks/${CUBE_ID}`;
    expect(deps.unlinkOpt).toHaveBeenCalledWith(`${dir}/stale.pid`);
    expect(deps.unlinkOpt).not.toHaveBeenCalledWith(`${dir}/fresh.pid`);
    expect(deps.unlinkOpt).not.toHaveBeenCalledWith(`${dir}/notalock.txt`); // non-.pid ignored
  });

  it('isLockLive: fresh marker → live; stale → not; absent → not; malformed → not', () => {
    const now = 1_000_000_000_000;
    const fresh = makeStubDeps({ readFileOpt: vi.fn(() => JSON.stringify({ launchedAt: new Date(now - 1000).toISOString(), droneLabel: 'd', worktreeDir: '/w' })) });
    expect(isLockLive(fresh, CUBE_ID, '/w', now).live).toBe(true);
    const stale = makeStubDeps({ readFileOpt: vi.fn(() => JSON.stringify({ launchedAt: new Date(now - LOCK_STALE_MS - 1).toISOString(), droneLabel: 'd', worktreeDir: '/w' })) });
    expect(isLockLive(stale, CUBE_ID, '/w', now).live).toBe(false);
    expect(isLockLive(makeStubDeps({ readFileOpt: vi.fn(() => null) }), CUBE_ID, '/w', now).live).toBe(false);
    expect(isLockLive(makeStubDeps({ readFileOpt: vi.fn(() => 'not json') }), CUBE_ID, '/w', now).live).toBe(false);
  });
});

describe('pastelist backend (gh#556 Part 2 §4.3)', () => {
  it('prints shellEscaped cd lines per candidate', () => {
    const deps = makeStubDeps();
    runPastelistBackend([cand({ worktreeDir: "/a b/it's" })], '/usr/local/bin/borg', deps);
    const out = (deps.stdout as any).mock.calls.map((c: any[]) => c[0]).join('');
    expect(out).toContain("cd '/a b/it'\\''s' && '/usr/local/bin/borg' assimilate --here");
  });
});

describe('tmux backend (gh#556 Part 2 §4.1)', () => {
  const opts = { sessionName: 'borg-myrepo', borgPath: '/usr/local/bin/borg', attachMode: 'none' as const, launchedAtISO: '2026-06-13T12:00:00.000Z', launchDelayMs: 0, sleep: async () => {} };
  // new-session / new-window print the created window's id (-P -F '#{window_id}').
  const idRunSync = (id = '@7') => vi.fn((_c: string, a: string[]) => (a[0] === 'new-session' || a[0] === 'new-window' ? `${id}\n` : ''));

  it('no existing session → new-session (with -P -F window_id) + rename/send-keys target the CAPTURED id (base-index-proof)', async () => {
    const deps = makeStubDeps({ runSyncExitCode: vi.fn(() => 1), runSync: idRunSync('@7') }); // has-session → absent
    await runTmuxBackend([cand()], opts, deps);
    const calls = (deps.runSync as any).mock.calls.map((c: any[]) => c[1]);
    const ns = calls.find((a: string[]) => a[0] === 'new-session');
    expect(ns).toEqual(['new-session', '-d', '-P', '-F', '#{window_id}', '-s', 'borg-myrepo', '-c', cand().worktreeDir]);
    expect(calls.some((a: string[]) => a[0] === 'new-window')).toBe(false);
    // rename-window + send-keys target the CAPTURED id '@7', NOT ':0' (no base-index assumption).
    expect(calls.some((a: string[]) => a[0] === 'rename-window' && a[2] === '@7' && a[3] === 'drone-1')).toBe(true);
    const sk = calls.find((a: string[]) => a[0] === 'send-keys');
    expect(sk[2]).toBe('@7');
    expect(sk[3]).toContain('assimilate --here');
    expect(calls.some((a: string[]) => String(a[2] ?? '').includes(':0'))).toBe(false); // never index-targets
    expect(deps.writeFile).toHaveBeenCalled(); // lock marker
  });

  it('existing session → new-window (not new-session), targets captured id', async () => {
    const deps = makeStubDeps({ runSyncExitCode: vi.fn(() => 0), runSync: idRunSync('@12') }); // has-session → exists
    await runTmuxBackend([cand()], opts, deps);
    const calls = (deps.runSync as any).mock.calls.map((c: any[]) => c[1]);
    expect(calls.some((a: string[]) => a[0] === 'new-session')).toBe(false);
    expect(calls.some((a: string[]) => a[0] === 'new-window')).toBe(true);
    expect(calls.some((a: string[]) => a[0] === 'send-keys' && a[2] === '@12')).toBe(true);
  });

  it('attachMode switch → switch-client; attach → attach-session; none → no attachInteractive', async () => {
    const sw = makeStubDeps({ runSync: idRunSync() });
    await runTmuxBackend([cand()], { ...opts, attachMode: 'switch' }, sw);
    expect(sw.attachInteractive).toHaveBeenCalledWith('tmux', ['switch-client', '-t', 'borg-myrepo']);
    const at = makeStubDeps({ runSync: idRunSync() });
    await runTmuxBackend([cand()], { ...opts, attachMode: 'attach' }, at);
    expect(at.attachInteractive).toHaveBeenCalledWith('tmux', ['attach-session', '-t', 'borg-myrepo']);
    const no = makeStubDeps({ runSync: idRunSync() });
    await runTmuxBackend([cand()], { ...opts, attachMode: 'none' }, no);
    expect(no.attachInteractive).not.toHaveBeenCalled();
  });

  it('send-keys shellEscapes a path with spaces + single-quotes', async () => {
    const deps = makeStubDeps({ runSyncExitCode: vi.fn(() => 1), runSync: idRunSync() });
    await runTmuxBackend([cand({ worktreeDir: "/Users/a b/it's a test" })], opts, deps);
    const sk = (deps.runSync as any).mock.calls.map((c: any[]) => c[1]).find((a: string[]) => a[0] === 'send-keys');
    expect(sk[3]).toContain("cd '/Users/a b/it'\\''s a test'");
  });

  it('rate-limit stagger: sleep(launchDelayMs) fires BETWEEN launches (N-1 times), never before the first', async () => {
    const sleep = vi.fn(async () => {});
    const deps = makeStubDeps({ runSyncExitCode: vi.fn(() => 1), runSync: idRunSync() });
    const fleet = [cand({ worktreeDir: '/w/a' }), cand({ worktreeDir: '/w/b' }), cand({ worktreeDir: '/w/c' })];
    await runTmuxBackend(fleet, { ...opts, launchDelayMs: 1500, sleep }, deps);
    expect(sleep).toHaveBeenCalledTimes(2); // 3 launches → 2 inter-launch gaps (first never waits)
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('launchDelayMs: 0 → no stagger (sleep never called)', async () => {
    const sleep = vi.fn(async () => {});
    const deps = makeStubDeps({ runSyncExitCode: vi.fn(() => 1), runSync: idRunSync() });
    await runTmuxBackend([cand({ worktreeDir: '/w/a' }), cand({ worktreeDir: '/w/b' })], { ...opts, launchDelayMs: 0, sleep }, deps);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('windows backend (gh#556 Part 2 §4.2 + control-char fold-in)', () => {
  const wopts = (platform: NodeJS.Platform) => ({ borgPath: '/usr/local/bin/borg', platform, launchedAtISO: '2026-06-13T12:00:00.000Z', launchDelayMs: 0, sleep: async () => {} });

  it('macOS + iTerm present → osascript per candidate + lock written', async () => {
    const deps = makeStubDeps({ pathExists: vi.fn((p: string) => p === '/Applications/iTerm.app') });
    await runWindowsBackend([cand()], wopts('darwin'), deps);
    const calls = (deps.runSync as any).mock.calls;
    expect(calls.some((c: any[]) => c[0] === 'osascript')).toBe(true);
    expect(deps.writeFile).toHaveBeenCalled();
  });

  it('macOS + no terminal app → hard-fails (NoTerminalError)', async () => {
    const deps = makeStubDeps({ pathExists: vi.fn(() => false) });
    await expect(runWindowsBackend([cand()], wopts('darwin'), deps)).rejects.toThrow(/compatible terminal app/);
  });

  it('control-char (newline) in worktree path → skipped + warned (not passed to osascript)', async () => {
    const deps = makeStubDeps({ pathExists: vi.fn((p: string) => p === '/Applications/iTerm.app') });
    await runWindowsBackend([cand({ worktreeDir: '/a/evil\nrm -rf' })], wopts('darwin'), deps);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('control'));
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'osascript')).toBe(false);
  });

  it('Linux → uses $BORG_TERMINAL when set', async () => {
    const deps = makeStubDeps({ getEnv: vi.fn((n: string) => (n === 'BORG_TERMINAL' ? 'kitty' : undefined)) });
    await runWindowsBackend([cand()], wopts('linux'), deps);
    expect((deps.runSync as any).mock.calls.some((c: any[]) => c[0] === 'kitty')).toBe(true);
  });

  it('rate-limit stagger on macOS: sleep(launchDelayMs) fires BETWEEN launches (N-1), not before the first', async () => {
    const sleep = vi.fn(async () => {});
    const deps = makeStubDeps({ pathExists: vi.fn((p: string) => p === '/Applications/iTerm.app') });
    const fleet = [cand({ worktreeDir: '/w/a' }), cand({ worktreeDir: '/w/b' }), cand({ worktreeDir: '/w/c' })];
    await runWindowsBackend(fleet, { ...wopts('darwin'), launchDelayMs: 800, sleep }, deps);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(800);
  });
});
