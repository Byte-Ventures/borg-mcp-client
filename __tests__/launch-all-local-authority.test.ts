import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const fixtures: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('launch-all local authority binding', () => {
  it.each([
    ['missing second lookup', 'missing'],
    ['malformed second lookup', 'malformed'],
    ['throwing second lookup', 'throw'],
  ] as const)(
    'fails closed before OAuth/network when candidate authority has a %s',
    async (_label, lossMode) => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-launch-all-authority-')));
      fixtures.push(home);
      const main = join(home, 'repo');
      const candidate = join(home, 'candidate');
      mkdirSync(join(main, '.git'), { recursive: true });
      mkdirSync(join(candidate, '.git'), { recursive: true });
      process.env.HOME = home;
      process.chdir(main);
      vi.resetModules();

      const values = new Map<string, string>();
      let launchDispatched = false;
      let postDispatchActiveReads = 0;
      let activeCredentialRef = '';
      const serverBackend = {
        name: 'keychain' as const,
        get: vi.fn(async (account: string) => {
          if (!launchDispatched || account !== activeCredentialRef) {
            return values.get(account) ?? null;
          }
          postDispatchActiveReads += 1;
          if (postDispatchActiveReads === 1) return values.get(account) ?? null;
          if (lossMode === 'throw') throw new Error('keychain locked');
          if (lossMode === 'malformed') return '{"version":1,"credential":"corrupt"}';
          return null;
        }),
        set: vi.fn(async (account: string, value: string) => {
          values.set(account, value);
        }),
        delete: vi.fn(async (account: string) => {
          values.delete(account);
        }),
      };
      const oauthGet = vi.fn(async (account: string) => {
        if (account === 'google-id-token') return 'cloud-token-must-not-leak';
        if (account === 'token-expiry') return String(Date.now() + 60 * 60 * 1000);
        return null;
      });
      const oauthBackend = {
        name: 'keychain' as const,
        get: oauthGet,
        set: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };

      const config = await import('../src/config.js');
      config.__setServerCredentialBackendForTest(serverBackend);
      config.__setBackendForTest(oauthBackend);
      const cubes = await import('../src/cubes.js');

      const cubeId = '11111111-1111-4111-8111-111111111111';
      const activeDroneId = '22222222-2222-4222-8222-222222222222';
      const candidateDroneId = '33333333-3333-4333-8333-333333333333';
      const apiUrl = 'https://127.0.0.1:7091';
      const serverTrustIdentity = 'spki-sha256:launch-all-server';
      const activeToken = 'a'.repeat(43);
      const candidateToken = 'b'.repeat(43);

      activeCredentialRef = await config.storeServerSessionCredential({
        origin: apiUrl,
        trustIdentity: serverTrustIdentity,
        cubeId,
        droneId: activeDroneId,
        generation: 1,
        credential: activeToken,
      });
      await cubes.setActiveCube({
        cubeId,
        droneId: activeDroneId,
        name: 'local-cube',
        droneLabel: 'active-seat',
        apiUrl,
        serverTrustIdentity,
        localSessionCredentialRef: activeCredentialRef,
        localSessionGeneration: 1,
      });

      process.chdir(candidate);
      const candidateCredentialRef = await config.storeServerSessionCredential({
        origin: apiUrl,
        trustIdentity: serverTrustIdentity,
        cubeId,
        droneId: candidateDroneId,
        generation: 1,
        credential: candidateToken,
      });
      await cubes.setActiveCube({
        cubeId,
        droneId: candidateDroneId,
        name: 'local-cube',
        droneLabel: 'candidate-seat',
        apiUrl,
        serverTrustIdentity,
        localSessionCredentialRef: candidateCredentialRef,
        localSessionGeneration: 1,
      });
      process.chdir(main);

      const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ drones: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchSpy);

      const { buildDefaultLaunchAllDeps } = await import('../src/launch-all-deps.js');
      const { runLaunchAll } = await import('../src/launch-all-cmd.js');
      const deps = buildDefaultLaunchAllDeps();
      deps.runSync = vi.fn((command: string, args: string[]) => {
        if (command === 'git') {
          return [
            `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
            `worktree ${candidate}\nHEAD b\nbranch refs/heads/candidate`,
          ].join('\n\n') + '\n';
        }
        if (command === 'tmux' && args[0] === '-V') return 'tmux 3.4';
        if (command === 'tmux' && args[0] === 'new-session') {
          launchDispatched = true;
          return '@1\n';
        }
        return '';
      });
      deps.runSyncExitCode = vi.fn(() => 1);
      deps.probeSeat = vi.fn(async () => 'live');
      deps.isTTY = vi.fn(() => false);
      deps.getEnv = vi.fn(() => undefined);
      deps.stderr = vi.fn();
      deps.stdout = vi.fn();

      await expect(runLaunchAll(
        { flags: {} },
        deps,
        {
          borgPath: '/usr/local/bin/borg',
          now: () => 1_000,
          nowISO: () => '2026-07-15T19:30:00.000Z',
          sleep: async () => {},
        },
      )).resolves.toBe(0);

      expect(activeToken).not.toBe(candidateToken);
      expect(postDispatchActiveReads).toBe(1);
      expect(oauthGet).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(deps.stderr).toHaveBeenCalledWith(
        expect.stringContaining('roster confirmation skipped'),
      );
    },
  );

  it('rejects a legacy-looking loopback candidate whose trust metadata was removed', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-launch-all-downgrade-')));
    fixtures.push(home);
    const main = join(home, 'repo');
    const candidate = join(home, 'candidate');
    mkdirSync(join(main, '.git'), { recursive: true });
    mkdirSync(join(candidate, '.git'), { recursive: true });
    process.env.HOME = home;
    process.chdir(main);
    vi.resetModules();

    const oauthGet = vi.fn(async (account: string) => {
      if (account === 'google-id-token') return 'cloud-token-must-not-leak';
      if (account === 'token-expiry') return String(Date.now() + 60 * 60 * 1000);
      return null;
    });
    const config = await import('../src/config.js');
    config.__setBackendForTest({
      name: 'keychain',
      get: oauthGet,
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    });
    const { API_URL } = await import('../src/remote-client.js');
    const cubeId = '11111111-1111-4111-8111-111111111111';
    const activeToken = 'a'.repeat(43);
    const candidateToken = 'b'.repeat(43);
    const configDir = join(home, '.config', 'borgmcp');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'cubes.json'), JSON.stringify({
      projects: {
        [main]: {
          cubeId,
          droneId: '22222222-2222-4222-8222-222222222222',
          name: 'mixed-authority-cube',
          sessionToken: activeToken,
          droneLabel: 'active-cloud-seat',
          apiUrl: API_URL,
        },
        [candidate]: {
          cubeId,
          droneId: '33333333-3333-4333-8333-333333333333',
          name: 'mixed-authority-cube',
          sessionToken: candidateToken,
          droneLabel: 'downgraded-local-seat',
          apiUrl: 'https://127.0.0.1:7091',
          // Deliberately removed: serverTrustIdentity and keychain reference.
        },
      },
    }));

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ drones: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchSpy);
    const { buildDefaultLaunchAllDeps } = await import('../src/launch-all-deps.js');
    const { runLaunchAll } = await import('../src/launch-all-cmd.js');
    const deps = buildDefaultLaunchAllDeps();
    deps.runSync = vi.fn((command: string, args: string[]) => {
      if (command === 'git') {
        return [
          `worktree ${main}\nHEAD a\nbranch refs/heads/main`,
          `worktree ${candidate}\nHEAD b\nbranch refs/heads/candidate`,
        ].join('\n\n') + '\n';
      }
      if (command === 'tmux' && args[0] === '-V') return 'tmux 3.4';
      if (command === 'tmux' && args[0] === 'new-session') return '@1\n';
      return '';
    });
    deps.runSyncExitCode = vi.fn(() => 1);
    deps.probeSeat = vi.fn(async () => 'live');
    deps.isTTY = vi.fn(() => false);
    deps.getEnv = vi.fn(() => undefined);
    deps.stderr = vi.fn();
    deps.stdout = vi.fn();

    await expect(runLaunchAll(
      { flags: {} },
      deps,
      {
        borgPath: '/usr/local/bin/borg',
        now: () => 1_000,
        nowISO: () => '2026-07-15T19:45:00.000Z',
        sleep: async () => {},
      },
    )).resolves.toBe(0);

    expect(activeToken).not.toBe(candidateToken);
    expect(oauthGet).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining('roster confirmation skipped'),
    );
  });
});
