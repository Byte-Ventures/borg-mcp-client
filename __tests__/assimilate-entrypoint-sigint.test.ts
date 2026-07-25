import { describe, it, expect, vi } from 'vitest';
import { runAssimilate } from '../src/assimilate-cmd';
import { createTestablePromptAdapter } from '../src/assimilate-deps';
import type { AssimilateDeps } from '../src/assimilate-cmd';

const SERVER_TRUST_IDENTITY = 'spki-sha256:test-server';

function makeAssimilateDeps(stderr: ReturnType<typeof vi.fn>, prompt: AssimilateDeps['prompt']) {
  return {
    runSync: vi.fn(),
    pathExists: vi.fn(),
    cwd: () => '/repo',
    chdir: vi.fn(),
    homedir: () => '/home',
    mkdirp: vi.fn(),
    preparePrivateRoot: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
    stderr,
    stdout: vi.fn(),
    prompt,
    promptSecret: vi.fn(async () => ''),
    isTTY: () => true,
    getHostname: () => 'test-host',
    setTerminalTitle: vi.fn(),
    getActiveCube: vi.fn(async () => null),
    hasPersistedActiveCube: vi.fn(async () => false),
    findProjectRoot: vi.fn(() => '/repo'),
    resolveRepositoryContext: vi.fn(async () => ({
      root: '/repo',
      commonDir: '/repo/.git',
      derivedName: 'myrepo',
      publicRepository: { kind: 'origin' as const, value: 'https://github.com/org/repo' },
      publicRepositoryName: 'org/repo',
    })),
    getRepositoryIdentity: vi.fn(async () => ({ kind: 'origin' as const, value: 'https://github.com/org/repo' })),
    getRepositoryAssociation: vi.fn(async () => null),
    saveRepositoryAssociation: vi.fn(async () => {}),
    detectLocalServer: vi.fn(async () => 'http://localhost:7091'),
    connectServer: vi.fn(async () => ({
      token: 'test-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
      serverCapabilities: ['create_cube'],
    })),
    resumeServerEnrollment: vi.fn(async () => null),
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [], drones: [] })),
    createCube: vi.fn(async (params) => ({
      response: {
        result: 'created' as const,
        cube_id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
        name: params.name,
        working_repo_name: params.workingRepoName,
        repository: params.repository,
        template: params.template,
        human_seat_role_id: 'role-1',
        default_worker_role_id: 'role-2',
        access: 'manage' as const,
      },
      cube: { id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826', name: params.name, roles: [], drones: [] },
    })),
    assimilate: vi.fn(),
    getInboxPath: vi.fn(() => '/tmp/inbox'),
    probeMcpReady: vi.fn(async () => true),
    resolveCli: vi.fn(async () => 'claude' as any),
    prepareCodexRemoteLaunch: vi.fn(async () => ({ args: [], warning: null, env: {} })),
    setCodexWakeTarget: vi.fn(),
    findLoadedCodexThread: vi.fn(async () => null),
    finalizeServerSeat: vi.fn(async () => ({ committed: true })),
    readPersistedLocalSeat: vi.fn(async () => null),
    peekServerSessionRecord: vi.fn(async () => false),
    findIncompleteSiblingAttempt: vi.fn(async () => null),
    probeSeat: vi.fn(async () => 'live' as any),
    setActiveCube: vi.fn(),
    resolveCliApprovals: vi.fn(async () => ({ codexArgs: [] })),
  } as unknown as AssimilateDeps;
}

describe('real-adapter SIGINT integration through borg assimilate entry point', () => {
  it('maps SIGINT to exit 130 with exact cancel copy (borg assimilate)', async () => {
    const stderr = vi.fn();
    const promptAdapter = createTestablePromptAdapter(async () => {
      throw new Error('SIGINT');
    });
    const deps = makeAssimilateDeps(stderr, promptAdapter);

    const exitCode = await runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps);

    expect(exitCode).toBe(130);
    expect(stderr).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
    expect(deps.createCube).not.toHaveBeenCalled();
    expect(deps.assimilate).not.toHaveBeenCalled();
    expect(deps.finalizeServerSeat).not.toHaveBeenCalled();
    expect(deps.setActiveCube).not.toHaveBeenCalled();
  });

  it('maps SIGINT during name prompt to exit 130 (borg assimilate)', async () => {
    const stderr = vi.fn();
    const promptAdapter = createTestablePromptAdapter(async () => {
      throw new Error('SIGINT');
    });
    const deps = makeAssimilateDeps(stderr, promptAdapter);

    const exitCode = await runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps);

    expect(exitCode).toBe(130);
    expect(stderr).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
    expect(deps.createCube).not.toHaveBeenCalled();
    expect(deps.assimilate).not.toHaveBeenCalled();
  });

  it('maps EOF to exit 1 with exact EOF copy (borg assimilate)', async () => {
    const stderr = vi.fn();
    const prompt = vi.fn(async () => {
      throw new Error('EOF');
    });
    const deps = makeAssimilateDeps(stderr, prompt);

    const exitCode = await runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps);

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Input ended before cube creation. Nothing was changed.\n');
    expect(deps.createCube).not.toHaveBeenCalled();
    expect(deps.assimilate).not.toHaveBeenCalled();
    expect(deps.finalizeServerSeat).not.toHaveBeenCalled();
    expect(deps.setActiveCube).not.toHaveBeenCalled();
  });
});

describe('real-adapter SIGINT integration through borg server cube init entry point', () => {
  it('maps SIGINT to exit 130 with exact cancel copy (borg server cube init)', async () => {
    const stderr = vi.fn();
    const promptAdapter = createTestablePromptAdapter(async () => {
      throw new Error('SIGINT');
    });
    const createCube = vi.fn();
    const getAssociation = vi.fn(async () => null);
    const saveAssociation = vi.fn();

    const { runEarlyServerFacade } = await import('../src/server-facade.js');
    const { runAssimilate } = await import('../src/assimilate-cmd.js');

    const client = {
      cubeInit: async () => {
        const deps = {
          runSync: vi.fn(),
          pathExists: vi.fn(),
          cwd: () => '/repo',
          chdir: vi.fn(),
          homedir: () => '/home',
          mkdirp: vi.fn(),
          preparePrivateRoot: vi.fn(async () => {}),
          exec: vi.fn(async () => 0),
          stderr,
          stdout: vi.fn(),
          prompt: promptAdapter,
          promptSecret: vi.fn(async () => ''),
          isTTY: () => true,
          getHostname: () => 'test-host',
          setTerminalTitle: vi.fn(),
          getActiveCube: vi.fn(async () => null),
          hasPersistedActiveCube: vi.fn(async () => false),
          findProjectRoot: vi.fn(() => '/repo'),
          resolveRepositoryContext: vi.fn(async () => ({
            root: '/repo',
            commonDir: '/repo/.git',
            derivedName: 'myrepo',
            publicRepository: { kind: 'origin' as const, value: 'https://github.com/org/repo' },
            publicRepositoryName: 'org/repo',
          })),
          getRepositoryIdentity: vi.fn(async () => ({ kind: 'origin' as const, value: 'https://github.com/org/repo' })),
          getRepositoryAssociation: getAssociation,
          saveRepositoryAssociation: saveAssociation,
          detectLocalServer: vi.fn(async () => 'http://localhost:7091'),
          connectServer: vi.fn(async () => ({
            token: 'test-token',
            trustIdentity: 'spki-sha256:test',
            serverCapabilities: ['create_cube'],
          })),
          resumeServerEnrollment: vi.fn(async () => null),
          listCubes: vi.fn(async () => []),
          getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [], drones: [] })),
          createCube: createCube,
          assimilate: vi.fn(),
          getInboxPath: vi.fn(() => '/tmp/inbox'),
          probeMcpReady: vi.fn(async () => true),
          resolveCli: vi.fn(async () => 'claude' as any),
          prepareCodexRemoteLaunch: vi.fn(async () => ({ args: [], warning: null, env: {} })),
          setCodexWakeTarget: vi.fn(),
          findLoadedCodexThread: vi.fn(async () => null),
          finalizeServerSeat: vi.fn(async () => ({ committed: true })),
          readPersistedLocalSeat: vi.fn(async () => null),
          peekServerSessionRecord: vi.fn(async () => false),
          findIncompleteSiblingAttempt: vi.fn(async () => null),
          probeSeat: vi.fn(async () => 'live' as any),
          setActiveCube: vi.fn(),
          resolveCliApprovals: vi.fn(async () => ({ codexArgs: [] })),
        } as unknown as ReturnType<typeof import('../src/assimilate-deps.js').buildDefaultAssimilateDeps>;

        return runAssimilate(
          { role: undefined, flags: { server: 'localhost:8787' }, mode: 'cube-init' },
          deps,
        );
      },
    };

    const output = {
      writeStdout: vi.fn(),
      writeStderr: (text: string) => stderr(text),
    };
    const child = {
      once: vi.fn(),
      kill: vi.fn(() => true),
    } as unknown as ReturnType<typeof import('../src/server-facade.js').runServerFacadeProcess> extends (...args: any[]) => Promise<infer R> ? any : never;

    const processDeps = {
      spawn: vi.fn(() => child),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
    };

    const exitCode = await runEarlyServerFacade(
      ['node', 'borg', 'server', 'cube', 'init'],
      processDeps,
      output,
      client,
    );

    expect(exitCode).toBe(130);
    expect(stderr).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
    expect(createCube).not.toHaveBeenCalled();
    expect(saveAssociation).not.toHaveBeenCalled();
  });

  it('maps EOF to exit 1 with exact EOF copy (borg server cube init)', async () => {
    const stderr = vi.fn();
    const prompt = vi.fn(async () => {
      throw new Error('EOF');
    });
    const createCube = vi.fn();
    const getAssociation = vi.fn(async () => null);
    const saveAssociation = vi.fn();

    const { runEarlyServerFacade } = await import('../src/server-facade.js');
    const { runAssimilate } = await import('../src/assimilate-cmd.js');

    const client = {
      cubeInit: async () => {
        const deps = {
          runSync: vi.fn(),
          pathExists: vi.fn(),
          cwd: () => '/repo',
          chdir: vi.fn(),
          homedir: () => '/home',
          mkdirp: vi.fn(),
          preparePrivateRoot: vi.fn(async () => {}),
          exec: vi.fn(async () => 0),
          stderr,
          stdout: vi.fn(),
          prompt,
          promptSecret: vi.fn(async () => ''),
          isTTY: () => true,
          getHostname: () => 'test-host',
          setTerminalTitle: vi.fn(),
          getActiveCube: vi.fn(async () => null),
          hasPersistedActiveCube: vi.fn(async () => false),
          findProjectRoot: vi.fn(() => '/repo'),
          resolveRepositoryContext: vi.fn(async () => ({
            root: '/repo',
            commonDir: '/repo/.git',
            derivedName: 'myrepo',
            publicRepository: { kind: 'origin' as const, value: 'https://github.com/org/repo' },
            publicRepositoryName: 'org/repo',
          })),
          getRepositoryIdentity: vi.fn(async () => ({ kind: 'origin' as const, value: 'https://github.com/org/repo' })),
          getRepositoryAssociation: getAssociation,
          saveRepositoryAssociation: saveAssociation,
          detectLocalServer: vi.fn(async () => 'http://localhost:7091'),
          connectServer: vi.fn(async () => ({
            token: 'test-token',
            trustIdentity: 'spki-sha256:test',
            serverCapabilities: ['create_cube'],
          })),
          resumeServerEnrollment: vi.fn(async () => null),
          listCubes: vi.fn(async () => []),
          getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [], drones: [] })),
          createCube: createCube,
          assimilate: vi.fn(),
          getInboxPath: vi.fn(() => '/tmp/inbox'),
          probeMcpReady: vi.fn(async () => true),
          resolveCli: vi.fn(async () => 'claude' as any),
          prepareCodexRemoteLaunch: vi.fn(async () => ({ args: [], warning: null, env: {} })),
          setCodexWakeTarget: vi.fn(),
          findLoadedCodexThread: vi.fn(async () => null),
          finalizeServerSeat: vi.fn(async () => ({ committed: true })),
          readPersistedLocalSeat: vi.fn(async () => null),
          peekServerSessionRecord: vi.fn(async () => false),
          findIncompleteSiblingAttempt: vi.fn(async () => null),
          probeSeat: vi.fn(async () => 'live' as any),
          setActiveCube: vi.fn(),
          resolveCliApprovals: vi.fn(async () => ({ codexArgs: [] })),
        } as unknown as ReturnType<typeof import('../src/assimilate-deps.js').buildDefaultAssimilateDeps>;

        return runAssimilate(
          { role: undefined, flags: { server: 'localhost:8787' }, mode: 'cube-init' },
          deps,
        );
      },
    };

    const output = {
      writeStdout: vi.fn(),
      writeStderr: (text: string) => stderr(text),
    };
    const child = {
      once: vi.fn(),
      kill: vi.fn(() => true),
    } as unknown as ReturnType<typeof import('../src/server-facade.js').runServerFacadeProcess> extends (...args: any[]) => Promise<infer R> ? any : never;

    const processDeps = {
      spawn: vi.fn(() => child),
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
    };

    const exitCode = await runEarlyServerFacade(
      ['node', 'borg', 'server', 'cube', 'init'],
      processDeps,
      output,
      client,
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith('Input ended before cube creation. Nothing was changed.\n');
    expect(createCube).not.toHaveBeenCalled();
    expect(saveAssociation).not.toHaveBeenCalled();
  });
});
