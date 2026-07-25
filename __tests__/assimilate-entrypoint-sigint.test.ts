import { describe, expect, it, vi } from 'vitest';
import type { AssimilateDeps } from '../src/assimilate-cmd.js';
import { buildDefaultAssimilateDeps, type PromptQuestion } from '../src/assimilate-deps.js';
import { runAssimilateEntry } from '../src/claude.js';
import { BorgServerError } from '../src/server-errors.js';
import {
  buildDefaultServerFacadeClientDeps,
  runEarlyServerFacade,
  type ServerFacadeProcessDeps,
} from '../src/server-facade.js';

const SERVER_TRUST_IDENTITY = 'spki-sha256:test-server';

function makeEntryDeps(question: PromptQuestion) {
  const stderr = vi.fn();
  const createCube = vi.fn();
  const saveRepositoryAssociation = vi.fn();
  const assimilate = vi.fn();
  const finalizeServerSeat = vi.fn();
  const setActiveCube = vi.fn();
  const getRepositoryIdentity = vi.fn(async () => ({
    kind: 'origin' as const,
    value: 'https://github.com/org/repo',
  }));
  const getRepositoryAssociation = vi.fn(async () => null);
  const productionPrompt = buildDefaultAssimilateDeps(question).prompt;

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
    prompt: productionPrompt,
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
      derivedName: 'repo',
      publicRepository: { kind: 'origin' as const, value: 'https://github.com/org/repo' },
      publicRepositoryName: 'org/repo',
    })),
    getRepositoryIdentity,
    getRepositoryAssociation,
    saveRepositoryAssociation,
    detectLocalServer: vi.fn(async () => 'https://localhost:7091'),
    connectServer: vi.fn(async () => ({
      token: 'test-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
      serverCapabilities: ['create_cube'],
    })),
    resumeServerEnrollment: vi.fn(async () => null),
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(),
    createCube,
    assimilate,
    getInboxPath: vi.fn(() => '/tmp/inbox'),
    probeMcpReady: vi.fn(async () => true),
    resolveCli: vi.fn(async () => 'claude' as const),
    prepareCodexRemoteLaunch: vi.fn(async () => ({ args: [], warning: null, env: {} })),
    setCodexWakeTarget: vi.fn(),
    findLoadedCodexThread: vi.fn(async () => null),
    finalizeServerSeat,
    readPersistedLocalSeat: vi.fn(async () => null),
    peekServerSessionRecord: vi.fn(async () => false),
    findIncompleteSiblingAttempt: vi.fn(async () => null),
    probeSeat: vi.fn(async () => 'live' as const),
    setActiveCube,
    resolveCliApprovals: vi.fn(async () => ({ codexArgs: [] })),
  } as unknown as AssimilateDeps;

  return {
    deps,
    stderr,
    createCube,
    saveRepositoryAssociation,
    assimilate,
    finalizeServerSeat,
    setActiveCube,
    getRepositoryIdentity,
    getRepositoryAssociation,
  };
}

const noServerProcess: ServerFacadeProcessDeps = {
  spawn: vi.fn(() => { throw new Error('server process must not start'); }),
  addSignalListener: vi.fn(),
  removeSignalListener: vi.fn(),
};

const entrypoints = [
  {
    entry: 'borg assimilate',
    run: (deps: AssimilateDeps) => runAssimilateEntry(
      ['--host', 'localhost:8787'],
      () => deps,
    ),
  },
  {
    entry: 'borg server cube init',
    run: (deps: AssimilateDeps) => runEarlyServerFacade(
      ['node', 'borg', 'server', 'cube', 'init', '--host', 'localhost:8787'],
      noServerProcess,
      { writeStdout: vi.fn(), writeStderr: vi.fn() },
      buildDefaultServerFacadeClientDeps(() => deps),
    ),
  },
] as const;

describe.each(entrypoints)('production prompt interruption through $entry', ({ run }) => {
  it.each([
    {
      name: 'SIGINT',
      error: new Error('SIGINT'),
      code: 130,
      copy: '\nCube creation cancelled. Nothing was changed.\n',
    },
    {
      name: 'EOF',
      error: new Error('EOF'),
      code: 1,
      copy: 'Input ended before cube creation. Nothing was changed.\n',
    },
  ])('$name returns $code and stops all continuation', async ({ error, code, copy }) => {
    const state = makeEntryDeps(async () => { throw error; });

    await expect(run(state.deps)).resolves.toBe(code);
    expect(state.stderr).toHaveBeenCalledWith(copy);

    expect(state.getRepositoryIdentity).toHaveBeenCalledOnce();
    expect(state.getRepositoryAssociation).toHaveBeenCalledOnce();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });
});

describe.each(entrypoints)('repository association through $entry', ({ run }) => {
  it('does not associate unassociated repo B with active repo A', async () => {
    const repositoryB = { kind: 'origin' as const, value: 'https://github.com/org/repo-b' };
    const state = makeEntryDeps(async (message) =>
      message.startsWith('Cube name') ? '' : message.startsWith('Create cube?') ? 'y' : '1');
    state.deps.getActiveCube = vi.fn(async () => ({
      cubeId: 'cube-a',
      droneId: 'drone-a',
      name: 'repo-a',
      droneLabel: 'builder-a',
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
      roleName: 'Drone',
    }));
    state.deps.resolveRepositoryContext = vi.fn(async () => ({
      root: '/repo-b',
      commonDir: '/repo-b/.git',
      derivedName: 'repo-b',
      publicRepository: repositoryB,
      publicRepositoryName: 'org/repo-b',
    }));
    state.getRepositoryIdentity.mockResolvedValue(repositoryB);
    state.createCube.mockRejectedValue(
      new BorgServerError('CREATE_CUBE_DENIED', 'stop after repository resolution'),
    );

    await expect(run(state.deps)).resolves.toBe(1);

    expect(state.getRepositoryAssociation).toHaveBeenCalledWith(
      SERVER_TRUST_IDENTITY,
      repositoryB,
    );
    expect(state.createCube).toHaveBeenCalledWith(
      'https://localhost:8787',
      'test-token',
      expect.objectContaining({ repository: repositoryB, name: 'repo-b' }),
      SERVER_TRUST_IDENTITY,
    );
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
  });
});
