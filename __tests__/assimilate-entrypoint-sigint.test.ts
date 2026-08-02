import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  encodeInvitationArtifact,
  getInvitationArtifactIntegrityInput,
} from 'borgmcp-shared/protocol';
import type { AssimilateDeps } from '../src/assimilate-cmd.js';
import { buildDefaultAssimilateDeps, type PromptQuestion } from '../src/assimilate-deps.js';
import { runAssimilateEntry } from '../src/claude.js';
import {
  BorgServerError,
  CubeCreationConfirmationError,
  CubeCreationOutcomeUnknownError,
  RepositoryAssociationOperationError,
  RepositoryAssociationOutcomeUnknownError,
  RepositoryAssociationResolutionError,
} from '../src/server-errors.js';
import {
  buildDefaultServerFacadeClientDeps,
  runEarlyServerFacade,
  type ServerFacadeProcessDeps,
} from '../src/server-facade.js';

vi.mock('../src/ensure-mcp-config.js', () => ({ ensureCliMcpConfigured: vi.fn() }));

const SERVER_TRUST_IDENTITY = 'spki-sha256:test-server';
const CLEAN_PATH_ARTIFACT_BASE = {
  version: 2 as const,
  endpoint: 'https://127.0.0.1:7091',
  ca_spki_sha256: '0'.repeat(64),
  authority: 'client' as const,
  secret: 's'.repeat(43),
  integrity: 'p'.repeat(43),
};
const CLEAN_PATH_ARTIFACT = encodeInvitationArtifact({
  ...CLEAN_PATH_ARTIFACT_BASE,
  integrity: createHmac('sha256', CLEAN_PATH_ARTIFACT_BASE.secret)
    .update(getInvitationArtifactIntegrityInput(CLEAN_PATH_ARTIFACT_BASE))
    .digest('base64url'),
});
const POSITIONAL_INVITATION_SENTINEL = 'A'.repeat(80);

function makeEntryDeps(question: PromptQuestion) {
  const stderr = vi.fn();
  const createCube = vi.fn();
  const resolveRepositoryCube = vi.fn(async () => ({ result: 'none' as const }));
  const associateRepositoryCube = vi.fn(async (_apiUrl, _token, input: {
    cubeId: string;
    workingRepoName: string;
    repository: { kind: 'origin'; value: string };
  }) => ({
    result: 'resolved' as const,
    cube_id: input.cubeId,
    name: 'repo',
    working_repo_name: input.workingRepoName,
    repository: input.repository,
    template: 'default' as const,
    human_seat_role_id: 'role-human',
    default_worker_role_id: 'role-default',
    access: 'manage' as const,
  }));
  const saveRepositoryAssociation = vi.fn();
  const assimilate = vi.fn(async () => ({
    cube_id: 'cube-existing',
    drone_id: 'drone-coordinator',
    drone_label: 'coordinator-1',
    role_id: 'role-human',
    result: 'created' as const,
    local_session: { credential_ref: `borg-server-session:${'a'.repeat(64)}` },
    finalize: {
      activate: vi.fn(async () => {}),
      scrubPending: vi.fn(async () => {}),
    },
  }));
  const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
  const setActiveCube = vi.fn();
  const getRepositoryIdentity = vi.fn(async () => ({
    kind: 'origin' as const,
    value: 'https://github.com/org/repo',
  }));
  const getRepositoryAssociation = vi.fn(async () => null);
  const productionPrompt = buildDefaultAssimilateDeps(question).prompt;

  const deps = {
    runSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
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
    resolveRepositoryCube,
    associateRepositoryCube,
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(async (apiUrl, token, cubeId) => ({
      id: cubeId,
      name: 'repo',
      roles: [
        { id: 'role-human', name: 'Coordinator', is_human_seat: true, is_default: false },
        { id: 'role-default', name: 'Builder', is_human_seat: false, is_default: true },
      ],
      drones: [],
    })),
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
    resolveRepositoryCube,
    associateRepositoryCube,
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
    run: (deps: AssimilateDeps, extra: string[] = []) => runAssimilateEntry(
      ['coordinator', '--host', 'localhost:8787', '--here', ...extra],
      () => deps,
    ),
  },
  {
    entry: 'borg server cube init',
    run: (deps: AssimilateDeps, extra: string[] = []) => runEarlyServerFacade(
      ['node', 'borg', 'server', 'cube', 'init', '--host', 'localhost:8787', ...extra],
      noServerProcess,
      { writeStdout: vi.fn(), writeStderr: vi.fn() },
      buildDefaultServerFacadeClientDeps(() => deps),
    ),
  },
] as const;

const cleanPathEntrypoints = [
  {
    entry: 'borg assimilate',
    run: (deps: AssimilateDeps) => runAssimilateEntry(
      ['--enroll'],
      () => deps,
    ),
  },
  {
    entry: 'borg server cube init',
    run: (deps: AssimilateDeps) => runEarlyServerFacade(
      ['node', 'borg', 'server', 'cube', 'init', '--enroll'],
      noServerProcess,
      { writeStdout: vi.fn(), writeStderr: vi.fn() },
      buildDefaultServerFacadeClientDeps(() => deps),
    ),
  },
] as const;

describe.each(cleanPathEntrypoints)('clean-machine enrollment through $entry', ({ run }) => {
  it('reaches the hidden invitation prompt without accepting an argv secret', async () => {
    const state = makeEntryDeps(async () => '1');
    const promptSecret = vi.fn(async () => CLEAN_PATH_ARTIFACT);
    const connectServer = vi.fn(async () => {
      throw new BorgServerError('INVITATION_REJECTED', 'test rejection');
    });
    state.deps.promptSecret = promptSecret;
    state.deps.connectServer = connectServer;

    await expect(run(state.deps)).resolves.toBe(1);

    expect(promptSecret).toHaveBeenCalledWith('Enrollment invitation (single-use; hidden input):');
    expect(connectServer).toHaveBeenCalledWith(
      'https://127.0.0.1:7091',
      expect.objectContaining({
        invitation: CLEAN_PATH_ARTIFACT,
        artifact: expect.objectContaining({ endpoint: 'https://127.0.0.1:7091' }),
      }),
    );
  });
});

describe.each(['borg assimilate', 'borg server cube init'] as const)('positional enrollment input through $entry', (entry) => {
  it('rejects before orchestration without echoing the invitation-shaped input', async () => {
    const state = makeEntryDeps(async () => '1');
    const ensureLocalServerInstalled = vi.fn(async () => 'present' as const);
    state.deps.ensureLocalServerInstalled = ensureLocalServerInstalled;
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const spawn = vi.fn(() => { throw new Error('server process must not start'); });
    const processDeps: ServerFacadeProcessDeps = {
      spawn,
      addSignalListener: vi.fn(),
      removeSignalListener: vi.fn(),
    };
    const processStderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const code = entry === 'borg assimilate'
        ? await runAssimilateEntry(
          ['--enroll', POSITIONAL_INVITATION_SENTINEL],
          () => state.deps,
        )
        : await runEarlyServerFacade(
          ['node', 'borg', 'server', 'cube', 'init', '--enroll', POSITIONAL_INVITATION_SENTINEL],
          processDeps,
          { writeStdout, writeStderr },
          buildDefaultServerFacadeClientDeps(() => state.deps),
        );

      expect(code).toBe(1);
      const output = [
        ...processStderr.mock.calls.map(([text]) => String(text)),
        ...writeStdout.mock.calls.map(([text]) => String(text)),
        ...writeStderr.mock.calls.map(([text]) => String(text)),
      ].join('');
      expect(output).toContain('That argument is not a valid role name.');
      expect(output).toContain('re-run `borg assimilate --enroll` without it.');
      expect(output).not.toContain(POSITIONAL_INVITATION_SENTINEL);
      expect(state.deps.promptSecret).not.toHaveBeenCalled();
      expect(state.deps.connectServer).not.toHaveBeenCalled();
      expect(state.deps.preparePrivateRoot).not.toHaveBeenCalled();
      expect(ensureLocalServerInstalled).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      processStderr.mockRestore();
    }
  });
});

describe.each(entrypoints)('production prompt interruption through $entry', ({ run }) => {
  it.each([
    {
      name: 'SIGINT',
      error: new Error('SIGINT'),
      code: 130,
      copy: '\nCube creation cancelled. No cube, repository binding, or drone was created.\n',
    },
    {
      name: 'EOF',
      error: new Error('EOF'),
      code: 1,
      copy: 'Input ended before cube creation. No cube, repository binding, or drone was created.\n',
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

  it.each([
    ['repository-already-associated', 'This repository is already associated with another cube. Run the same command again to use the existing managed association, or ask the server operator to correct the repository binding.'],
    ['cube-already-associated', 'The selected cube is already associated with another repository. Choose a different cube, or run the command from the repository already linked to that cube.'],
    ['access-denied', 'This enrolled client does not have permission to manage the selected cube. Ask the server operator to grant this client management access, then run the same command again.'],
    ['invalid-cube', 'The selected cube does not have valid authoritative roles. Ask the server operator to repair its role configuration, or choose another cube.'],
  ] as const)('reports %s without partial local state or server-body interpolation', async (failure, recovery) => {
    const state = makeEntryDeps(async () => 'yes');
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);
    state.associateRepositoryCube.mockRejectedValue(Object.assign(
      new RepositoryAssociationOperationError(failure),
      {
        cube_id: 'server-secret-cube-id',
        repository: 'https://example.invalid/server-secret-repository',
      },
    ));

    await expect(run(state.deps)).resolves.toBe(1);

    expect(state.stderr).toHaveBeenCalledWith(
      'Repository cube association could not be completed.\n' +
      `${recovery}\n` +
      'No cube, repository binding, or drone was created.\n',
    );
    const output = state.stderr.mock.calls.flat().join('');
    expect(output).not.toContain('server-secret-cube-id');
    expect(output).not.toContain('server-secret-repository');
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });

  it('reports an initial resolve failure with truthful pre-mutation recovery', async () => {
    const state = makeEntryDeps(async () => 'yes');
    state.resolveRepositoryCube.mockRejectedValue(new RepositoryAssociationResolutionError());

    await expect(run(state.deps)).resolves.toBe(1);

    expect(state.stderr).toHaveBeenCalledWith(
      'Repository cube association could not be resolved.\n' +
      'Verify that the server is reachable and the client and server versions match, then run the same command again.\n' +
      'No cube, repository binding, or drone was created.\n',
    );
    expect(state.deps.listCubes).not.toHaveBeenCalled();
    expect(state.associateRepositoryCube).not.toHaveBeenCalled();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
  });

  it('reports a post-dispatch association failure as unknown without a zero-mutation claim', async () => {
    const state = makeEntryDeps(async () => 'yes');
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);
    state.associateRepositoryCube.mockRejectedValue(Object.assign(
      new RepositoryAssociationOutcomeUnknownError(),
      {
        cube_id: 'server-secret-cube-id',
        repository: 'https://example.invalid/server-secret-repository',
      },
    ));

    await expect(run(state.deps)).resolves.toBe(1);

    const expected =
      'Repository cube association outcome is unknown.\n' +
      'The server may have created the repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will first resolve the authoritative server association without creating a cube.\n';
    expect(state.stderr).toHaveBeenCalledWith(expected);
    expect(expected).not.toContain('Nothing was created or changed.');
    expect(expected).not.toContain('server-secret-cube-id');
    expect(expected).not.toContain('server-secret-repository');
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
  });

  it('reports post-association readback failure as unconfirmed without a zero-mutation claim', async () => {
    const state = makeEntryDeps(async () => 'yes');
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);
    state.resolveRepositoryCube
      .mockResolvedValueOnce({ result: 'none' })
      .mockRejectedValueOnce(new RepositoryAssociationResolutionError());

    await expect(run(state.deps)).resolves.toBe(1);

    const expected =
      'Repository cube association could not be confirmed.\n' +
      'The server may have created the repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will resolve authoritative server state before creating or associating a cube.\n';
    expect(state.stderr).toHaveBeenCalledWith(expected);
    expect(expected).not.toContain('Nothing was created or changed.');
    expect(state.associateRepositoryCube).toHaveBeenCalledOnce();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
  });
});

describe.each(entrypoints)('repository association through $entry', ({ entry, run }) => {
  it('does not associate unassociated repo B with active repo A', async () => {
    const repositoryB = { kind: 'origin' as const, value: 'https://github.com/org/repo-b' };
    const state = makeEntryDeps(async (message) =>
      message.startsWith('Cube name') ? '' : message.startsWith('Create cube ') ? 'y' : '1');
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

describe.each(entrypoints)('post-dispatch cube creation recovery through $entry', ({ run }) => {
  it.each(['response loss', 'malformed 201 response'])('%s is unconfirmed and never persists local state', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run with --yes'); });
    state.createCube.mockRejectedValue(new CubeCreationOutcomeUnknownError());

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    const expected =
      'Cube creation outcome is unconfirmed.\n' +
      'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n';
    expect(state.stderr).toHaveBeenCalledWith(expected);
    expect(expected).not.toContain('Nothing was changed.');
    expect(expected).not.toContain('Nothing was created or changed.');
    expect(state.createCube).toHaveBeenCalledOnce();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });

  it('post-create cube readback failure is unconfirmed and never persists local state', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run with --yes'); });
    state.createCube.mockRejectedValue(
      new CubeCreationConfirmationError('server response body must not be rendered'),
    );

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    const expected =
      'Cube creation could not be confirmed.\n' +
      'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n';
    expect(state.stderr).toHaveBeenCalledWith(expected);
    expect(expected).not.toContain('server response body');
    expect(expected).not.toContain('Nothing was changed.');
    expect(state.createCube).toHaveBeenCalledOnce();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });

  it('post-create authoritative repository readback failure is unconfirmed and never persists local state', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run with --yes'); });
    state.createCube.mockResolvedValue({
      response: {
        result: 'created',
        cube_id: 'cube-created',
        name: 'repo',
        working_repo_name: 'repo',
        repository: { kind: 'origin', value: 'https://github.com/org/repo' },
        template: 'software-dev',
        human_seat_role_id: 'role-human',
        default_worker_role_id: 'role-default',
        access: 'manage',
      },
      cube: {
        id: 'cube-created',
        name: 'repo',
        roles: [
          { id: 'role-human', is_human_seat: true },
          { id: 'role-default', is_default: true },
        ],
        drones: [],
      },
    });
    state.resolveRepositoryCube
      .mockResolvedValueOnce({ result: 'none' })
      .mockRejectedValueOnce(new RepositoryAssociationResolutionError());

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    expect(state.stderr).toHaveBeenCalledWith(
      'Cube creation could not be confirmed.\n' +
      'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n',
    );
    expect(state.resolveRepositoryCube).toHaveBeenCalledTimes(2);
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });

  it('rejects authoritative role IDs absent from cube readback before local persistence', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run with --yes'); });
    state.createCube.mockResolvedValue({
      response: {
        result: 'created',
        cube_id: 'cube-created',
        name: 'repo',
        working_repo_name: 'repo',
        repository: { kind: 'origin', value: 'https://github.com/org/repo' },
        template: 'software-dev',
        human_seat_role_id: 'missing-human-role',
        default_worker_role_id: 'role-default',
        access: 'manage',
      },
      cube: {
        id: 'cube-created',
        name: 'repo',
        roles: [{ id: 'role-default', is_default: true }],
        drones: [],
      },
    });
    state.resolveRepositoryCube
      .mockResolvedValueOnce({ result: 'none' })
      .mockResolvedValueOnce({
        result: 'resolved',
        cube_id: 'cube-created',
        name: 'repo',
        working_repo_name: 'repo',
        repository: { kind: 'origin', value: 'https://github.com/org/repo' },
        template: 'software-dev',
        human_seat_role_id: 'missing-human-role',
        default_worker_role_id: 'role-default',
        access: 'manage',
      });

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    expect(state.stderr).toHaveBeenCalledWith(
      'Cube creation could not be confirmed.\n' +
      'The server may have created the cube and repository binding; no local repository association was saved and no drone was created.\n' +
      'Run the same command again; Borg will resolve authoritative server state before creating a cube.\n',
    );
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });
});

describe.each(entrypoints)('legacy repository cube adoption through $entry', ({ entry, run }) => {
  it('restores an authoritative server association without prompting or name discovery', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run'); });
    state.resolveRepositoryCube.mockResolvedValue({
      result: 'resolved',
      cube_id: 'cube-existing',
      name: 'repo',
      working_repo_name: 'repo',
      repository: { kind: 'origin', value: 'https://github.com/org/repo' },
      template: 'default',
      human_seat_role_id: 'role-human',
      default_worker_role_id: 'role-default',
      access: 'manage',
    });

    await expect(run(state.deps)).resolves.toBe(0);

    expect(state.resolveRepositoryCube).toHaveBeenCalledOnce();
    expect(state.deps.listCubes).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).toHaveBeenCalledWith(
      SERVER_TRUST_IDENTITY,
      { kind: 'origin', value: 'https://github.com/org/repo' },
      { cubeId: 'cube-existing', name: 'repo', workingRepoName: 'repo', template: 'default' },
    );
    expect(state.createCube).not.toHaveBeenCalled();
    if (entry === 'borg assimilate') expect(state.assimilate).toHaveBeenCalledOnce();
    else expect(state.assimilate).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before atomically adopting one exact-name match', async () => {
    const state = makeEntryDeps(async (message) => {
      if (message.startsWith('Link this repository to that cube?')) return 'yes';
      throw new Error(`unexpected prompt: ${message}`);
    });
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);
    state.resolveRepositoryCube
      .mockResolvedValueOnce({ result: 'none' })
      .mockResolvedValueOnce({
        result: 'resolved',
        cube_id: 'cube-existing',
        name: 'repo',
        working_repo_name: 'repo',
        repository: { kind: 'origin', value: 'https://github.com/org/repo' },
        template: 'default',
        human_seat_role_id: 'role-human',
        default_worker_role_id: 'role-default',
        access: 'manage',
      });

    await expect(run(state.deps)).resolves.toBe(0);

    expect(state.associateRepositoryCube).toHaveBeenCalledWith(
      'https://localhost:8787',
      'test-token',
      {
        cubeId: 'cube-existing',
        workingRepoName: 'repo',
        repository: { kind: 'origin', value: 'https://github.com/org/repo' },
      },
      SERVER_TRUST_IDENTITY,
    );
    expect(state.resolveRepositoryCube).toHaveBeenCalledTimes(2);
    expect(state.saveRepositoryAssociation).toHaveBeenCalledOnce();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.stderr).toHaveBeenCalledWith(
      'Found an existing cube matching this repository:\n' +
      '  cube:       repo\n' +
      '  repository: /repo\n' +
      '  server:     https://localhost:8787\n',
    );
  });

  it('never lets --yes adopt an existing cube by name', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run'); });
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    expect(state.associateRepositoryCube).not.toHaveBeenCalled();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    const retryCommand = entry === 'borg server cube init'
      ? "borg server cube init --host 'https://localhost:8787'"
      : "borg assimilate --host 'https://localhost:8787'";
    expect(state.stderr).toHaveBeenCalledWith(
      "Found existing cube 'repo' on https://localhost:8787.\n" +
      'Linking a repository to an existing cube requires one interactive confirmation.\n' +
      `Run ${retryCommand} --cube-name 'repo' once in an interactive terminal to link it; scripted runs work from then on.\n` +
      'No cube, repository binding, or drone was created.\n',
    );
  });

  it('scopes the --yes refusal after local repository identity persistence', async () => {
    const state = makeEntryDeps(async () => { throw new Error('prompt must not run'); });
    let identityPersisted = false;
    state.getRepositoryIdentity.mockImplementation(async () => {
      identityPersisted = true;
      return { kind: 'local', value: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    });
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);

    await expect(run(state.deps, ['--yes'])).resolves.toBe(1);

    expect(identityPersisted).toBe(true);
    const output = state.stderr.mock.calls.flat().join('');
    expect(output).toContain('No cube, repository binding, or drone was created.');
    expect(output).not.toContain('Nothing was changed.');
    expect(output).not.toContain('Nothing was created or changed.');
    expect(state.associateRepositoryCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'decline',
      answer: async (message: string) => {
        if (message.startsWith('Link this repository to that cube?')) return 'no';
        throw new Error(`unexpected prompt: ${message}`);
      },
      code: 0,
      copy: 'No cube, repository binding, or drone was created.\n',
    },
    {
      name: 'SIGINT',
      answer: async () => { throw new Error('SIGINT'); },
      code: 130,
      copy: '\nCube adoption cancelled. No cube, repository binding, or drone was created.\n',
    },
    {
      name: 'EOF',
      answer: async () => { throw new Error('EOF'); },
      code: 1,
      copy: 'Input ended before cube adoption. No cube, repository binding, or drone was created.\n',
    },
  ])('$name creates no cube, repository binding, drone, or local association', async ({ answer, code, copy }) => {
    const state = makeEntryDeps(answer);
    state.deps.listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]);

    await expect(run(state.deps)).resolves.toBe(code);

    expect(state.deps.listCubes).toHaveBeenCalledOnce();
    expect(state.stderr).toHaveBeenCalledWith(copy);
    expect(state.associateRepositoryCube).not.toHaveBeenCalled();
    expect(state.createCube).not.toHaveBeenCalled();
    expect(state.saveRepositoryAssociation).not.toHaveBeenCalled();
    expect(state.assimilate).not.toHaveBeenCalled();
    expect(state.finalizeServerSeat).not.toHaveBeenCalled();
    expect(state.setActiveCube).not.toHaveBeenCalled();
  });
});
