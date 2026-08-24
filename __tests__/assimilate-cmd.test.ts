import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAssimilate,
  safeStderr,
  type AssimilationActiveCube,
  type AssimilateDeps,
  type AssimilateResult,
} from '../src/assimilate-cmd';
import type { ActiveCube } from '../src/cubes';
import { BorgServerError, LegacySessionCredentialCollisionError } from '../src/server-errors';
import { DroneEvictedError } from '../src/drone-lifecycle';
import { createHash } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encodeInvitationArtifact, getInvitationArtifactIntegrityInput } from 'borgmcp-shared/protocol';

const createHashDigest = (s: string): string => createHash('sha256').update(s).digest('hex');

const openCodeDroneMocks = vi.hoisted(() => ({
  computeOpenCodePort: vi.fn(() => 15555),
  allocateOpenCodePort: vi.fn(async () => 15555),
  connectOpenCodeDrone: vi.fn(async () => {}),
  createOpenCodeLaunchKickoff: vi.fn((kickoff: string) => ({
    prompt: kickoff,
    apiPassword: 'api-password-for-test',
    correlationIdentity: 'correlation-for-test',
  })),
  injectInitialKickoff: vi.fn(async () => true),
}));
const mcpConfigMocks = vi.hoisted(() => ({
  ensureCliMcpConfigured: vi.fn(),
}));
const SERVER_TRUST_IDENTITY = 'spki-sha256:test-server';
const TEST_ARTIFACT_SECRET = 'i'.repeat(43);
const TEST_ARTIFACT_BASE = {
  version: 2 as const,
  endpoint: 'https://localhost:8787',
  ca_spki_sha256: '0'.repeat(64),
  authority: 'client' as const,
  secret: TEST_ARTIFACT_SECRET,
  integrity: 'p'.repeat(43),
};
const TEST_ARTIFACT = encodeInvitationArtifact({
  ...TEST_ARTIFACT_BASE,
  integrity: createHmac('sha256', TEST_ARTIFACT_SECRET)
    .update(getInvitationArtifactIntegrityInput(TEST_ARTIFACT_BASE))
    .digest('base64url'),
});

function artifactForEndpoint(endpoint: string): string {
  const base = { ...TEST_ARTIFACT_BASE, endpoint };
  return encodeInvitationArtifact({
    ...base,
    integrity: createHmac('sha256', TEST_ARTIFACT_SECRET)
      .update(getInvitationArtifactIntegrityInput(base))
      .digest('base64url'),
  });
}

vi.mock('../src/opencode-drone.js', () => openCodeDroneMocks);
vi.mock('../src/opencode-plugin.js', () => ({
  installBorgPlugin: vi.fn(),
}));
vi.mock('../src/ensure-mcp-config.js', () => mcpConfigMocks);

beforeEach(() => {
  mcpConfigMocks.ensureCliMcpConfigured.mockReset();
});

function makeStubDeps(overrides: Partial<AssimilateDeps> = {}): AssimilateDeps {
  let repositoryAssociation: any = null;
  let serverRepositoryResolution: any = { result: 'none' };
  const deps: AssimilateDeps = {
    runSync: vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    ),
    pathExists: vi.fn(() => false),
    cwd: vi.fn(() => '/work/myrepo'),
    stderr: vi.fn(),
    stdout: vi.fn(),
    prompt: vi.fn(async (message: string) =>
      message.startsWith('Cube name') ? '' : message.startsWith('Create cube ') ? 'y' : '1'),
    promptSecret: vi.fn(async () => TEST_ARTIFACT),
    isTTY: () => true,
    ensureLocalServerInstalled: vi.fn(async () => 'present'),
    chdir: vi.fn(),
    homedir: vi.fn(() => '/home/test'),
    mkdirp: vi.fn(),
    preparePrivateRoot: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
    getHostname: vi.fn(() => 'test-host.local'),
    setTerminalTitle: vi.fn(),
    getActiveCube: vi.fn(async () => null),
    inspectLiveInboxMonitor: vi.fn(() => null),
    hasPersistedActiveCube: vi.fn(async () => false),
    readPersistedLocalSeat: vi.fn(async () => null),
    peekServerSessionRecord: vi.fn(async () => false),
    probeSeat: vi.fn(async () => 'live'),
    findProjectRoot: vi.fn(() => '/work/myrepo'),
    resolveRepositoryContext: vi.fn(async () => ({
      root: '/work/myrepo',
      commonDir: '/work/myrepo/.git',
      derivedName: 'myrepo',
      publicRepository: { kind: 'origin', value: 'https://github.com/org/myrepo' },
      publicRepositoryName: 'org/myrepo',
    })),
    getRepositoryIdentity: vi.fn(async (context) => context.publicRepository ?? {
      kind: 'local', value: '11111111-1111-4111-8111-111111111111',
    }),
    getRepositoryAssociation: vi.fn(async () => repositoryAssociation),
    saveRepositoryAssociation: vi.fn(async (_trust, _repository, association) => {
      repositoryAssociation = association;
    }),
    installProjectSessionHook: vi.fn(),
    defaultAuthority: { kind: 'server', apiUrl: 'https://server.test' },
    detectLocalServer: vi.fn(async () => null),
    connectServer: vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
      serverCapabilities: ['create_cube'],
    })),
    resumeServerEnrollment: vi.fn(async () => null),
    peekPendingServerEnrollment: vi.fn(async () => null),
    resolveRepositoryCube: vi.fn(async () => serverRepositoryResolution),
    associateRepositoryCube: vi.fn(async (_apiUrl, _token, input) => {
      serverRepositoryResolution = {
        result: 'resolved',
        cube_id: input.cubeId,
        name: 'myrepo',
        working_repo_name: input.workingRepoName,
        repository: input.repository,
        template: 'software-dev',
        human_seat_role_id: 'role-human',
        default_worker_role_id: 'role-default',
        access: 'manage',
      };
      return serverRepositoryResolution;
    }),
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(async () => { throw new Error('not called in this scenario'); }),
    createCube: vi.fn(async (_apiUrl, _token, params) => ({
      response: {
        result: 'created',
        cube_id: 'cube-1',
        name: params.name,
        working_repo_name: params.workingRepoName,
        repository: params.repository,
        template: params.template,
        human_seat_role_id: 'role-human',
        default_worker_role_id: 'role-default',
        access: 'manage',
      },
      cube: { id: 'cube-1', name: params.name, roles: [
        { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
      ]},
    })),
    assimilate: vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      role_id: 'role-default',
      result: 'created' as const,
      local_session: {
        credential_ref: 'borg-server-session:' + 'a'.repeat(64),
      },
      finalize: {
        activate: vi.fn(async () => {}),
        scrubPending: vi.fn(async () => {}),
      },
    })),
    finalizeServerSeat: vi.fn(async () => ({ committed: true as const })),
    hasActiveSeatInDifferentCloneFamily: vi.fn(async () => false),
    getInboxPath: vi.fn((c: string, d: string) => `/tmp/test-inbox/${c}/${d}.log`),
    probeMcpReady: vi.fn(async () => true),
    setCliPreferenceForWorktree: vi.fn(async () => {}),
    resolveCli: vi.fn(async (explicit) => explicit ?? 'claude'),
    prepareCodexRemoteLaunch: vi.fn(async () => ({ args: ['--remote', 'unix:///tmp/codex.sock'], env: { BORG_CODEX_REMOTE_WAKE: '1' } })),
    setCodexWakeTarget: vi.fn(async () => {}),
    findLoadedCodexThread: vi.fn(async () => 'thread-123'),
    ...overrides,
  };
  const assimilate = deps.assimilate;
  deps.assimilate = vi.fn(async (...args: Parameters<AssimilateDeps['assimilate']>) => {
    const result = await assimilate(...args);
    if (result.prepareAborted) return result;
    return {
      ...result,
      result: result.result ?? 'created',
      local_session: result.local_session ?? {
        credential_ref: 'borg-server-session:' + 'a'.repeat(64),
      },
      finalize: result.finalize ?? {
        activate: vi.fn(async () => {}),
        scrubPending: vi.fn(async () => {}),
      },
    };
  }) as AssimilateDeps['assimilate'];
  const connectServer = deps.connectServer;
  deps.connectServer = vi.fn(async (...args: Parameters<AssimilateDeps['connectServer']>) => {
    const connected = await connectServer(...args);
    return {
      ...connected,
      serverCapabilities: connected.serverCapabilities ?? ['create_cube'],
    };
  });
  if (!overrides.resolveRepositoryCube) {
    deps.resolveRepositoryCube = vi.fn(async (...args: Parameters<AssimilateDeps['resolveRepositoryCube']>) => {
      if (serverRepositoryResolution.result === 'resolved') return serverRepositoryResolution;
      if (overrides.listCubes && overrides.getCube) {
        const listed = await deps.listCubes(args[0], args[1], args[3]);
        const match = listed.filter((cube) => cube.name === args[2].workingRepoName);
        if (match.length === 1) {
          const cube = await deps.getCube(args[0], args[1], match[0].id, args[3]);
          return {
            result: 'resolved',
            cube_id: cube.id,
            name: cube.name,
            working_repo_name: args[2].workingRepoName,
            repository: args[2].repository,
            template: 'software-dev',
            human_seat_role_id: cube.roles.find((role) => role.is_human_seat)?.id ?? cube.roles[0]?.id,
            default_worker_role_id: cube.roles.find((role) => role.is_default)?.id ?? cube.roles[0]?.id,
            access: 'manage',
          };
        }
      }
      return { result: 'none' };
    });
  }
  const createCube = deps.createCube;
  deps.createCube = vi.fn(async (...args: Parameters<AssimilateDeps['createCube']>) => {
    const params = args[2];
    let created: any;
    if (!overrides.createCube && overrides.listCubes) {
      const listed = await deps.listCubes(args[0], args[1], args[3]);
      const existing = listed.find((cube) => cube.name === params.name);
      created = existing && overrides.getCube
        ? await deps.getCube(args[0], args[1], existing.id, args[3])
        : await createCube(...args);
    } else {
      created = await createCube(...args) as any;
    }
    const creation = created?.response && created?.cube ? created : {
      response: {
        result: 'created',
        cube_id: created.id,
        name: created.name,
        working_repo_name: params.workingRepoName,
        repository: params.repository,
        template: params.template,
        human_seat_role_id: created.roles.find((role: any) => role.is_human_seat)?.id ?? 'role-human',
        default_worker_role_id: created.roles.find((role: any) => role.is_default)?.id ?? created.roles[0]?.id,
        access: 'manage',
      },
      cube: created,
    };
    serverRepositoryResolution = {
      ...creation.response,
      result: 'resolved',
      human_seat_role_id: creation.cube.roles.find((role: any) => role.is_human_seat)?.id ?? creation.cube.roles[0]?.id,
      default_worker_role_id: creation.cube.roles.find((role: any) => role.is_default)?.id ?? creation.cube.roles[0]?.id,
    };
    return creation;
  }) as AssimilateDeps['createCube'];
  return deps;
}

describe('runAssimilate private-root preflight', () => {
  it('keeps the approved artifact and terminal copy byte-exact across TTY and NO_COLOR', async () => {
    const artifact = readFileSync(
      new URL('../docs/design/mockups/private-root-unavailable.html', import.meta.url),
      'utf8',
    );
    const copy = [
      'Borg could not safely prepare its private local state.',
      'No Borg server or cube change was made.',
      "Before retrying, verify that Borg-owned directories are real, owned by your account, and not writable by other users. Verify that their parent directories are real, trusted directories owned by your account or the system and not writable by other users. Verify that Borg files are private regular files owned by your account, then run the same command again.",
    ].join('\n');
    expect(artifact).toContain(`<p>${copy.split('\n')[0]}</p>`);
    expect(artifact).toContain(`<p>${copy.split('\n')[1]}</p>`);
    expect(artifact).toContain(`<p>${copy.split('\n')[2]}</p>`);
    const generated = readFileSync(new URL('../dist/assimilate-cmd.js', import.meta.url), 'utf8');
    expect(generated).toContain(copy.split('\n')[0]);
    expect(generated).toContain(copy.split('\n')[1]);
    expect(generated).toContain(copy.split('\n')[2]);

    const previousNoColor = process.env.NO_COLOR;
    try {
      for (const isTTY of [true, false]) {
        for (const noColor of [undefined, '1']) {
          if (noColor === undefined) delete process.env.NO_COLOR;
          else process.env.NO_COLOR = noColor;
          const deps = makeStubDeps({
            isTTY: () => isTTY,
            preparePrivateRoot: vi.fn(async () => { throw new Error('hostile root'); }),
          });
          await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).resolves.toBe(1);
          expect(deps.stderr).toHaveBeenCalledWith(`${copy}\n`);
        }
      }
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it('stops before local reads and network access when the root cannot be prepared', async () => {
    const deps = makeStubDeps({
      preparePrivateRoot: vi.fn(async () => { throw new Error('mode 0755'); }),
    });

    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps))
      .resolves.toBe(1);

    expect(deps.getActiveCube).not.toHaveBeenCalled();
    expect(deps.connectServer).not.toHaveBeenCalled();
    expect(deps.listCubes).not.toHaveBeenCalled();
    expect(deps.createCube).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      'Borg could not safely prepare its private local state.\n' +
        'No Borg server or cube change was made.\n' +
        'Before retrying, verify that Borg-owned directories are real, owned by your account, and not writable by other users. Verify that their parent directories are real, trusted directories owned by your account or the system and not writable by other users. Verify that Borg files are private regular files owned by your account, then run the same command again.\n',
    );
  });

  it('keeps first-seat role selection when retrying an existing empty cube', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-x', drone_label: 'coordinator-1',
      role_id: 'role-coordinator', result: 'created' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) },
      finalize: { activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}) },
    }));
    const deps = makeStubDeps({
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1', name: 'myrepo', drones: [], roles: [
          { id: 'role-coordinator', name: 'Coordinator', is_default: false, is_human_seat: true },
          { id: 'role-builder', name: 'Builder', is_default: true, is_human_seat: false },
        ],
      })),
      assimilate: assimilate as AssimilateDeps['assimilate'],
    });

    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps))
      .resolves.toBe(0);
    expect(assimilate.mock.calls[0][2]).toMatchObject({ role_id: 'role-coordinator' });
  });
});

// Sprint 4 / gh#147 — defense-in-depth control-char strip from subprocess stderr.
describe('safeStderr (Sprint 4 / gh#147)', () => {
  it('strips embedded ANSI escape sequences', () => {
    // Cursor-move + clear-screen escape — would corrupt the operator's terminal.
    const malicious = 'fatal: \x1b[2Joops';
    expect(safeStderr(malicious)).toBe('fatal: [2Joops');
  });

  it('strips NUL byte', () => {
    expect(safeStderr('a\x00b')).toBe('ab');
  });

  it('strips DEL (0x7F)', () => {
    expect(safeStderr('a\x7Fb')).toBe('ab');
  });

  it('strips all C0 control chars (\\x00 through \\x1F)', () => {
    // Build a string containing every C0 control char + visible chars.
    let s = 'a';
    for (let i = 0; i < 0x20; i++) s += String.fromCharCode(i);
    s += 'b';
    expect(safeStderr(s)).toBe('ab');
  });

  it('passes printable ASCII through unchanged', () => {
    // No over-strip on the common case — git stderr is mostly punctuation+letters.
    const benign = 'fatal: not a valid object name: HEAD (no commits yet)';
    expect(safeStderr(benign)).toBe(benign);
  });
});

describe('runAssimilate: exact legacy session credential collision', () => {
  it.each([true, false])('renders identical bounded non-mutating copy when TTY=%s', async (isTTY) => {
    const deps = makeStubDeps({
      isTTY: () => isTTY,
      getActiveCube: vi.fn(async () => {
        throw new LegacySessionCredentialCollisionError('https://server.test');
      }),
    });

    await expect(runAssimilate({ role: undefined, flags: {} }, deps)).resolves.toBe(1);
    expect(vi.mocked(deps.stderr).mock.calls.map(([line]) => line).join('')).toBe(
      `Local session credential collision detected.\n` +
        `No local credentials were changed.\n` +
        `Next: run borg assimilate --host https://server.test --enroll.\n`,
    );
    expect(deps.detectLocalServer).not.toHaveBeenCalled();
    expect(deps.connectServer).not.toHaveBeenCalled();
    expect(deps.listCubes).not.toHaveBeenCalled();
    expect(deps.assimilate).not.toHaveBeenCalled();
  });

  it('keeps pending+replacement in the generic malformed classification without network or special copy', async () => {
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => {
        throw new Error('Borg private store is malformed or uses an unsupported version');
      }),
    });

    await expect(runAssimilate({ role: undefined, flags: { server: 'server.test' } }, deps)).resolves.toBe(1);
    const output = vi.mocked(deps.stderr).mock.calls.map(([line]) => line).join('');
    expect(output).toContain('could not access its private store');
    expect(output).not.toContain('Local session credential collision detected');
    expect(deps.detectLocalServer).not.toHaveBeenCalled();
    expect(deps.connectServer).not.toHaveBeenCalled();
    expect(deps.listCubes).not.toHaveBeenCalled();
    expect(deps.assimilate).not.toHaveBeenCalled();
  });
});

describe('runAssimilate: scaffolding', () => {
  it('returns exit code 0 on a stubbed happy path', async () => {
    const deps = makeStubDeps();
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
  });
});

// gh#653 B4: the createCube/assimilate round-trips take 2–5s and
// were silent, so a user read the wait as a hang and Ctrl-C'd mid-run. Each
// step now announces itself. (The dup-creation guard B4 originally proposed
// was redundant — cubes have UNIQUE(owner_id,name) + a client pre-create
// existence check — so B4 is progress-output only.)
describe('runAssimilate: progress output (gh#653 B4)', () => {
  it('first-drone path announces guided creation + joining', async () => {
    const stderr = vi.fn();
    // default stub: listCubes [] → createCube path; cubeName derives to 'myrepo'
    const deps = makeStubDeps({ stderr });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('Create a cube for this repository');
    expect(text).toContain("Creating cube 'myrepo'…");
    expect(text).toContain('Joining cube');
  });

  it('existing-association path announces readback + joining but NOT creating', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      // git remote → cube name derives to 'myrepo' so it matches the existing
      // cube below (cube-name derivation reads the remote, like the other tests)
      runSync: vi.fn((cmd: string, args: string[]) =>
        args[0] === 'remote'
          ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      ),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getRepositoryAssociation: vi.fn(async () => ({
        cubeId: 'c', name: 'myrepo', workingRepoName: 'myrepo', template: 'software-dev',
      })),
      getCube: vi.fn(async () => ({
        id: 'c', name: 'myrepo',
        roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }],
      })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('Cube already initialized.');
    expect(text).toContain('Joining cube');
    expect(text).not.toContain('Creating'); // existing cube → no create round-trip
  });
});

describe('runAssimilate: cube-init surrounding surface', () => {
  it('keeps the existing copy for a genuine non-repository outcome', async () => {
    const deps = makeStubDeps({ resolveRepositoryContext: vi.fn(async () => null) });
    await expect(runAssimilate({ role: undefined, flags: {} }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      'No Git repository was found for this directory.\n' +
      'Nothing was changed.\n' +
      'Run this command inside a Git repository.\n',
    );
  });

  it('reports an operational repository-discovery failure with its cause', async () => {
    const deps = makeStubDeps({
      resolveRepositoryContext: vi.fn(async () => { throw new Error('git failed: dubious ownership\u001b[2J'); }),
    });
    await expect(runAssimilate({ role: undefined, flags: {} }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      'Could not inspect this Git repository: git failed: dubious ownership[2J\n' +
      'Nothing was changed.\n',
    );
  });

  it('writes the affirmative final frame to stdout while progress stays on stderr', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const deps = makeStubDeps({ stdout, stderr, isTTY: () => true });

    await expect(runAssimilate({
      role: undefined,
      flags: { yes: true },
      mode: 'cube-init',
    }, deps)).resolves.toBe(0);

    const result = stdout.mock.calls.map(([text]) => String(text)).join('');
    const progress = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(result).toContain('✓');
    expect(result).toContain('Cube created.');
    expect(result).toContain('No drone was created.');
    expect(result).toContain("Next: borg assimilate --host 'https://server.test'");
    expect(progress).toContain('Create a cube for this repository');
    expect(progress).toContain("Creating cube 'myrepo'…");
    expect(progress).not.toContain('✓');
    expect(progress).not.toContain('Cube created.');
  });

  it('uses the assimilation color gate for the cube-init success frame', async () => {
    const previous = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const stdout = vi.fn();
      const deps = makeStubDeps({ stdout, isTTY: () => true });
      await expect(runAssimilate({
        role: undefined,
        flags: { yes: true },
        mode: 'cube-init',
      }, deps)).resolves.toBe(0);
      const result = stdout.mock.calls.map(([text]) => String(text)).join('');
      expect(result).toContain('✓ Cube created.');
      expect(result).not.toContain('\u001b[');
    } finally {
      if (previous === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previous;
    }
  });

  it('names cube init in pre-core bare-repository recovery', async () => {
    const deps = makeStubDeps({
      resolveRepositoryContext: vi.fn(async () => { throw new Error('BARE_REPOSITORY'); }),
    });
    await expect(runAssimilate({
      role: undefined,
      flags: {},
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      'borg server cube init requires a non-bare repository worktree. Clone or check out the repository, then retry.\n',
    );
  });

  it('names cube init in pre-core server recovery', async () => {
    const deps = makeStubDeps({
      connectServer: vi.fn(async () => { throw new Error('network unreachable'); }),
    });
    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com' },
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);
    const output = vi.mocked(deps.stderr).mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain(
      'then rerun `borg server cube init --host https://server.example.com`.',
    );
    expect(output).not.toContain('rerun `borg assimilate');
  });

  it.each([
    ['assimilate', undefined, '`borg assimilate --host <host> --here`'],
    ['cube init', 'cube-init' as const, '`borg server cube init --host <host>`'],
  ])('keeps non-interactive %s authority guidance byte-identical', async (_label, mode, command) => {
    const deps = makeStubDeps({ isTTY: () => false, defaultAuthority: undefined });
    await expect(runAssimilate({
      role: undefined,
      flags: { yes: true },
      ...(mode ? { mode } : {}),
    }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(
      `No local server selected. Use ${command} to select a local server.\n`,
    );
    expect(deps.detectLocalServer).not.toHaveBeenCalled();
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it('names cube init in saved-seat collision recovery before authority selection', async () => {
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => {
        throw new LegacySessionCredentialCollisionError('https://server.test');
      }),
    });
    await expect(runAssimilate({
      role: undefined,
      flags: {},
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);
    const output = vi.mocked(deps.stderr).mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain(
      'Next: run `borg server cube init --host https://server.test --enroll`.',
    );
    expect(deps.detectLocalServer).not.toHaveBeenCalled();
  });

  it('names cube init after a pin-matched saved-session rejection', async () => {
    const deps = makeStubDeps({
      connectServer: vi.fn(async () => {
        throw new BorgServerError('SESSION_REJECTED', 'superseded');
      }),
    });
    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com' },
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);
    const output = vi.mocked(deps.stderr).mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain(
      'then `borg server cube init --host https://server.example.com --enroll`.',
    );
    expect(output).not.toContain('then borg assimilate');
  });

  it('names cube init when an ordinary client needs an explicit cube grant', async () => {
    const deps = makeStubDeps({
      connectServer: vi.fn(async () => ({
        token: 'ordinary-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
        serverCapabilities: [],
      })),
    });
    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com', yes: true },
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);
    const output = vi.mocked(deps.stderr).mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain(
      "then rerun borg server cube init --host 'https://server.example.com'.",
    );
    expect(output).not.toContain('rerun borg assimilate');
  });
});

describe('runAssimilate: step 8 (launch Claude Code)', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('ensures borg MCP registration for the selected %s CLI before launch', async (cli) => {
    const exec = vi.fn(async () => 0);
    const probeMcpReady = vi.fn(async () => true);
    const deps = makeStubDeps({ exec, probeMcpReady });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, cli } }, deps)).resolves.toBe(0);

    expect(mcpConfigMocks.ensureCliMcpConfigured).toHaveBeenCalledWith(cli);
    expect(mcpConfigMocks.ensureCliMcpConfigured).toHaveBeenCalledBefore(probeMcpReady);
    expect(exec).toHaveBeenCalledWith(cli, expect.any(Array), '/work/myrepo', expect.any(Object));
  });

  it('fails before minting a seat when selected-CLI MCP configuration cannot be ensured', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-x', drone_label: 'drone-1', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'role-default',
    }));
    const exec = vi.fn(async () => 0);
    const probeMcpReady = vi.fn(async () => true);
    mcpConfigMocks.ensureCliMcpConfigured.mockImplementationOnce(() => {
      throw new Error('opencode CLI not found');
    });
    const deps = makeStubDeps({ assimilate, exec, probeMcpReady });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, cli: 'opencode' } }, deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('opencode MCP configuration failed'));
    expect(assimilate).not.toHaveBeenCalled();
    expect(probeMcpReady).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('execs Claude Code at the (post-chdir) project root and sets terminal title', async () => {
    const exec = vi.fn(async () => 0);
    const setTerminalTitle = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, setTerminalTitle, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    expect(setTerminalTitle).toHaveBeenCalledWith('drone-1', 'myrepo');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), '/work/myrepo', expect.objectContaining({ BORG_SESSION: '1' }));
  });

  it.each(['claude', 'opencode', 'codex'] as const)(
    'pre-authorizes only the launched %s worktree and per-seat scratch root',
    async (cli) => {
      const provisionLaunchAccess = vi.fn();
      const mkdirp = vi.fn();
      const exec = vi.fn(async () => 0);
      const deps = makeStubDeps({ provisionLaunchAccess, mkdirp, exec });

      await expect(runAssimilate({ role: undefined, flags: { yes: true, cli } }, deps)).resolves.toBe(0);

      expect(mkdirp).toHaveBeenCalledWith('/home/test/.borg/scratch/drone-1');
      expect(provisionLaunchAccess).toHaveBeenCalledWith(cli, '/work/myrepo', {
        worktree: '/work/myrepo',
        scratch: '/home/test/.borg/scratch/drone-1',
        commonDir: '/work/myrepo/.git',
      });
      const [, launchArgs, launchCwd, launchEnv] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
      expect(launchCwd).toBe('/work/myrepo');
      expect(launchEnv.BORG_LAUNCH_WORKTREE).toBe('/work/myrepo');
      expect(launchEnv.BORG_LAUNCH_SCRATCH).toBe('/home/test/.borg/scratch/drone-1');
      if (cli === 'codex') {
        expect(launchArgs).toEqual(expect.arrayContaining([
          '--add-dir', '/work/myrepo',
          '--add-dir', '/home/test/.borg/scratch/drone-1',
        ]));
        const addDirValues = launchArgs.flatMap((arg, index) =>
          arg === '--add-dir' ? [launchArgs[index + 1]] : []
        );
        expect(addDirValues).not.toContain('/work/myrepo/.git');
      }
    },
  );

  it.each(['claude', 'opencode', 'codex'] as const)(
    'uses the repository root for %s launch access when launched from a subdirectory',
    async (cli) => {
      const provisionLaunchAccess = vi.fn();
      const mkdirp = vi.fn();
      const exec = vi.fn(async () => 0);
      const deps = makeStubDeps({
        cwd: () => '/work/myrepo/packages/client',
        findProjectRoot: () => '/work/myrepo',
        provisionLaunchAccess,
        mkdirp,
        exec,
      });

      await expect(runAssimilate({ role: undefined, flags: { yes: true, cli } }, deps)).resolves.toBe(0);

      expect(provisionLaunchAccess).toHaveBeenCalledWith(cli, '/work/myrepo', {
        worktree: '/work/myrepo',
        scratch: '/home/test/.borg/scratch/drone-1',
        commonDir: '/work/myrepo/.git',
      });
      const [, launchArgs, launchCwd, launchEnv] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
      expect(launchCwd).toBe('/work/myrepo/packages/client');
      expect(launchEnv.BORG_LAUNCH_CLI).toBe(cli);
      expect(launchEnv.BORG_LAUNCH_WORKTREE).toBe('/work/myrepo');
      if (cli === 'codex') {
        expect(launchArgs).toEqual(expect.arrayContaining([
          '--add-dir', '/work/myrepo',
          '--add-dir', '/home/test/.borg/scratch/drone-1',
        ]));
        const addDirValues = launchArgs.flatMap((arg, index) =>
          arg === '--add-dir' ? [launchArgs[index + 1]] : []
        );
        expect(addDirValues).not.toContain('/work/myrepo/packages/client');
      }
    },
  );

  it('adds only the linked repository common directory to the Codex launch argv', async () => {
    const exec = vi.fn(async () => 0);
    const provisionLaunchAccess = vi.fn();
    const deps = makeStubDeps({
      exec,
      provisionLaunchAccess,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/linked tree',
        commonDir: '/work/origin checkout/.git',
        derivedName: 'linked-tree',
        publicRepository: { kind: 'origin', value: 'https://github.com/org/myrepo' },
        publicRepositoryName: 'org/myrepo',
      })),
      cwd: () => '/work/linked tree',
      findProjectRoot: () => '/work/linked tree',
    });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, cli: 'codex' } }, deps)).resolves.toBe(0);

    expect(provisionLaunchAccess).toHaveBeenCalledWith('codex', '/work/linked tree', {
      worktree: '/work/linked tree',
      scratch: '/home/test/.borg/scratch/drone-1',
      commonDir: '/work/origin checkout/.git',
    });
    const [, launchArgs] = exec.mock.calls[0] as [string, string[]];
    expect(launchArgs).toEqual(expect.arrayContaining([
      '--add-dir', '/work/linked tree',
      '--add-dir', '/home/test/.borg/scratch/drone-1',
      '--add-dir', '/work/origin checkout/.git',
    ]));
    expect(launchArgs).not.toContain('/work/origin checkout');
  });

  // CR-PE-F1 regression (drone-2 Phase E review 2026-05-18T04:59Z):
  // kickoff prompt must include the borg-inbox-monitor clause so the
  // new drone wakes on peer log entries during bootstrap. Without
  // this, freshly-assimilated drones miss real-time wake events and
  // self-heal only at the /loop heartbeat.
  it('Claude kickoff passes an explicit worktree-local monitor root with the new drone inbox path', async () => {
    const exec = vi.fn(async () => 0);
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-uuid-1', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r',
    }));
    const getInboxPath = vi.fn((c: string, d: string) => `/test-inboxes/${c}/${d}.log`);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, assimilate, getInboxPath, runSync,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(getInboxPath).toHaveBeenCalledWith('cube-1', 'drone-uuid-1');
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[])[0];
    expect(kickoff).toContain('inbox-monitor');
    expect(kickoff).toContain('/work/myrepo/.borgmcp/inbox-monitor');
    expect(kickoff).toContain('/test-inboxes/cube-1/drone-uuid-1.log');
    expect(kickoff).not.toContain('borg-opencode-correlation:');
  });

  it('keeps OpenCode API and correlation trust in launch env, not argv or prompt text', async () => {
    openCodeDroneMocks.createOpenCodeLaunchKickoff.mockClear();
    openCodeDroneMocks.connectOpenCodeDrone.mockClear();
    openCodeDroneMocks.injectInitialKickoff.mockClear();
    const exec = vi.fn(async () => 0);
    const deps = makeStubDeps({
      exec,
      resolveCliApprovals: vi.fn(async () => ({
        codexArgs: [],
        openCodePermission: '{"borg_borg_regen":"allow"}',
      })),
    });

    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'opencode' } }, deps);
    await Promise.resolve();

    expect(exec).toHaveBeenCalledWith('opencode', expect.any(Array), '/work/myrepo', expect.any(Object));
    const launchArgs = exec.mock.calls[0][1] as string[];
    expect(launchArgs).not.toContain('--auto');
    expect(exec.mock.calls[0][3]).toEqual(expect.objectContaining({
      OPENCODE_PERMISSION: '{"borg_borg_regen":"allow"}',
    }));
    const promptIndex = launchArgs.indexOf('--prompt');
    const openCodePrompt = launchArgs[promptIndex + 1];
    const portIndex = launchArgs.indexOf('--port');
    expect(portIndex).toBeGreaterThanOrEqual(0);
    expect(launchArgs[portIndex + 1]).toBe('15555');
    expect(exec.mock.calls[0][3]).toEqual(expect.objectContaining({ BORG_OPENCODE_PORT: '15555' }));
    expect(exec.mock.calls[0][3]).toEqual(expect.objectContaining({
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'api-password-for-test',
      BORG_OPENCODE_LAUNCH_CORRELATION: 'correlation-for-test',
    }));
    expect(openCodePrompt).toContain('Call borg_regen and follow the playbook');
    expect(openCodePrompt).not.toContain('api-password-for-test');
    expect(openCodePrompt).not.toContain('correlation-for-test');
    expect(launchArgs.join('\0')).not.toContain('api-password-for-test');
    expect(launchArgs.join('\0')).not.toContain('correlation-for-test');
    expect(openCodeDroneMocks.createOpenCodeLaunchKickoff).toHaveBeenCalledWith(
      expect.not.stringContaining('borg-opencode-correlation:'),
    );
    expect(openCodeDroneMocks.injectInitialKickoff).toHaveBeenCalledWith({
      prompt: openCodePrompt,
      apiPassword: 'api-password-for-test',
      correlationIdentity: 'correlation-for-test',
    });
    expect(openCodeDroneMocks.connectOpenCodeDrone).toHaveBeenCalledWith(expect.objectContaining({
      apiPassword: 'api-password-for-test',
    }));
  });

  // BUG-5 / v0.9.3 regression (drone-1 DISPATCH-FIX 2026-05-18T11:43Z):
  // kickoff prompt must telegraph the exact ToolSearch syntax + the three
  // bootstrap tool names so the launched session can recover from the
  // MCP-startup race deterministically (per drone-7 UX-FEEDBACK 11:42:38Z).
  it('kickoff prompt contains exact ToolSearch query + 3 bootstrap tool names (BUG-5 fix)', async () => {
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[])[0];
    expect(kickoff).toContain('ToolSearch({query: "select:');
    expect(kickoff).toContain('mcp__borg__borg_regen');
    expect(kickoff).toContain('mcp__borg__borg_log');
    expect(kickoff).toContain('Monitor');
    expect(kickoff).toContain('max_results: 3');
  });

  // Pedagogical welcome block emitted to stdout before
  // `claude` exec so it lands in the user's terminal scrollback above
  // Claude Code's interactive UI (Ink does not enter alt-screen-buffer per
  // 2026-05-19 PTY probe). Cube-agnostic shape — same render path for all
  // role/cube names per drone-9 UX-LENS refinement.
  it('emits cube-agnostic welcome block to stdout before claude launch', async () => {
    const exec = vi.fn(async () => 0);
    const stdout = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stdout, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'coordinator', is_default: true, is_human_seat: true }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stdoutPayload = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutPayload).toContain('Attached `drone-1`');
    expect(stdoutPayload).toContain('coordinator');
    expect(stdoutPayload).toContain('myrepo');
    expect(stdoutPayload).toContain('borg_whoami');
    expect(stdoutPayload).toContain('borg_roster');
    // Welcome must be emitted before claude exec so it lands above the TUI.
    const stdoutCallOrder = stdout.mock.invocationCallOrder[0];
    const execCallOrder = exec.mock.invocationCallOrder[0];
    expect(stdoutCallOrder).toBeLessThan(execCallOrder);
  });

  it('welcome block renders for any role.name (cube-agnostic; no mapping table)', async () => {
    // Confirms the cube-portability invariant: a custom-template role
    // (e.g. "fact-checker" in a writers-room cube) renders the same shape
    // as software-dev roles. Closes Sprint 14 cube-template-portability
    // contract at the welcome-render layer.
    const exec = vi.fn(async () => 0);
    const stdout = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/writers-room.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stdout, runSync,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/writers-room', commonDir: '/work/writers-room/.git', derivedName: 'writers-room',
        publicRepository: { kind: 'origin', value: 'https://github.com/org/writers-room' },
        publicRepositoryName: 'org/writers-room',
      })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'writers-room' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'writers-room', roles: [{ id: 'r', name: 'fact-checker', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: 'fact-checker', flags: { yes: true } }, deps);
    const stdoutPayload = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutPayload).toContain('fact-checker');
    expect(stdoutPayload).toContain('writers-room');
    expect(stdoutPayload).toContain('borg_whoami');
    expect(stdoutPayload).toContain('borg_roster');
  });

  // BUG-5 / v0.9.3 regression: orchestrator probes MCP readiness before
  // launching claude. Probe success → silent fast-path; probe failure
  // → stderr warning + still-exec (never blocks).
  it('probeMcpReady success → silent fast-path (no warning)', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const probeMcpReady = vi.fn(async () => true);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stderr, probeMcpReady, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(probeMcpReady).toHaveBeenCalled();
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain('readiness probe');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(String), expect.objectContaining({ BORG_SESSION: '1' }));
  });

  it('probeMcpReady failure → stderr warning + still-exec (never blocks)', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const probeMcpReady = vi.fn(async () => false);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stderr, probeMcpReady, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('readiness probe');
    expect(stderrCalls).toContain('launching claude anyway');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(String), expect.objectContaining({ BORG_SESSION: '1' }));
  });

  it('installs the project-local SessionStart hook at the launch root (gh#673 P2)', async () => {
    const installProjectSessionHook = vi.fn();
    let currentCwd = '/work/myrepo';
    const deps = makeStubDeps({
      installProjectSessionHook,
      cwd: () => currentCwd,
      chdir: (path) => { currentCwd = path; },
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    // agentCwd = deps.cwd() at launch time — the spawned worktree
    // (post-chdir) or the in-place root; either way the hook lands in
    // the directory the agent will run from.
    expect(installProjectSessionHook).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/drone');
  });

  it('a hook-install failure never blocks the assimilate (best-effort + launcher re-ensure)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      installProjectSessionHook: vi.fn(() => {
        throw new Error('EACCES');
      }),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    const text = (stderr.mock.calls as unknown as string[][]).map((c) => c[0]).join('');
    expect(text).toContain('project-local SessionStart hook');
  });

  it('supports launching Codex through remote-control wake mode', async () => {
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, runSync,
      resolveCliApprovals: vi.fn(async () => ({
        codexArgs: ['-c', 'mcp_servers.borg.tools."borg:regen".approval_mode="auto"'],
      })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'codex' } }, deps);
    // The launched session carries activation, a durable CLI identity, and
    // the remote-wake transport flag as distinct markers.
    // Note: env now includes full process.env (for gotcha#1 ANTHROPIC_API_KEY removal);
    // use objectContaining to assert the required keys without requiring an exact match.
    expect(exec).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(String), expect.objectContaining({
      BORG_AGENT_KIND: 'codex',
      BORG_CODEX_REMOTE_WAKE: '1',
      BORG_SESSION: '1',
    }));
    const [, kickoffArgs] = exec.mock.calls[0];
    // Codex MCP children only receive pinned `-c` env. Verify session,
    // identity, and transport are all independently present before the TUI
    // remote arguments and kickoff positional.
    expect(kickoffArgs).toEqual(expect.arrayContaining([
      '--add-dir', '/work/myrepo',
      '--add-dir', '/home/test/.borg/scratch/drone-1',
      '-c', 'mcp_servers.borg.tools."borg:regen".approval_mode="auto"',
      '-c', 'mcp_servers.borg.env.BORG_SESSION="1"',
      '-c', 'mcp_servers.borg.env.BORG_AGENT_KIND="codex"',
      '-c', 'mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"',
      '--remote', 'unix:///tmp/codex.sock',
      '--cd', '/work/myrepo',
    ]));
    const kickoff = (kickoffArgs as string[]).at(-1) as string;
    expect(kickoff.startsWith('/loop')).toBe(false);
    expect(kickoff).toContain('Codex wake-path capability check passed');
    expect(kickoff).toContain('Call borg_regen and follow the playbook');
    expect(kickoff).not.toContain('borg-opencode-correlation:');
    expect(kickoff).not.toContain('borg-inbox-monitor');
    expect(kickoff).not.toContain('.borgmcp/inbox-monitor');
    // gh#929: the read-log-triage paragraph is stripped from the kickoff
    // (the playbook owns it); not re-injected on the codex launch path.
    expect(kickoff).not.toContain('On every Monitor wake and every ScheduleWakeup heartbeat, triage');
    expect(kickoff).not.toContain('Never reflexively call borg_regen for routine text-only wakes');
  });

  it('surfaces failed Codex remote-wake capability in the kickoff prompt', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec,
      stderr,
      runSync,
      prepareCodexRemoteLaunch: vi.fn(async () => ({
        args: [],
        env: {},
        warning: 'Codex remote-wake disabled: test failure',
      })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });

    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'codex' } }, deps);

    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('Codex remote-wake disabled');
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[]).at(-1) as string;
    expect(kickoff).toContain('Codex wake-path capability check failed');
    expect(kickoff).toContain('Run borg_regen manually whenever you return');
    const launchEnv = exec.mock.calls[0][3] as Record<string, string | undefined>;
    expect(launchEnv.BORG_AGENT_KIND).toBe('codex');
    expect(launchEnv.BORG_CODEX_REMOTE_WAKE).toBeUndefined();
    expect(kickoffArgs).toContain('mcp_servers.borg.env.BORG_AGENT_KIND="codex"');
    expect(kickoffArgs).not.toContain('mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"');
    // Codex MCP children read their pinned config instead of launchEnv. A
    // no-socket fallback must therefore explicitly override an installed
    // legacy BORG_CODEX_REMOTE_WAKE="1" config rather than merely omit 1.
    expect(kickoffArgs).toContain('mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="0"');
  });

  it('clears a stale Codex transport marker when an existing seat relaunches with Claude', async () => {
    const savedRemoteWake = process.env.BORG_CODEX_REMOTE_WAKE;
    process.env.BORG_CODEX_REMOTE_WAKE = '1';
    try {
      const exec = vi.fn(async () => 0);
      const deps = makeStubDeps({ exec });
      const exit = await runAssimilate({ role: undefined, flags: { yes: true, cli: 'claude' } }, deps);
      expect(exit).toBe(0);
      const launchEnv = exec.mock.calls[0][3] as Record<string, string | undefined>;
      expect(launchEnv.BORG_AGENT_KIND).toBe('claude');
      expect(launchEnv.BORG_CODEX_REMOTE_WAKE).toBeUndefined();
    } finally {
      if (savedRemoteWake === undefined) delete process.env.BORG_CODEX_REMOTE_WAKE;
      else process.env.BORG_CODEX_REMOTE_WAKE = savedRemoteWake;
    }
  });
});

// Sprint 19 (gh#184): assimilate flow reorder + strict rollback.
// Worktree spawn now happens AFTER API success. Assimilate API failure
// no longer creates a worktree (no rollback needed; clean early-exit).
// Worktree rollback narrows to local finalization failures after creation.
describe('runAssimilate: reattach to an EVICTED seat is refused (gh#877 follow-up)', () => {
  const sameCubeSeat = vi.fn(async () => ({ cubeId: 'c', droneId: 'd-prior', name: 'myrepo', droneLabel: 'l', apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY, localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), roleName: 'Drone' }));
  const cubeResolves = {
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  };

  it('a --here reattach whose saved seat was evicted (410) prints the recovery message + exits 1, no worktree created', async () => {
    const runSyncSpy = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }
    );
    const stderr = vi.fn();
    const chdir = vi.fn();
    const assimilate = vi.fn(async () => { throw new DroneEvictedError('Your previous seat in cube "myrepo" was evicted'); });
    const deps = makeStubDeps({
      ...cubeResolves, runSync: runSyncSpy, stderr, chdir, assimilate,
      getActiveCube: sameCubeSeat, // same cube → --here sets reattachPriorId = 'd-prior'
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('was evicted'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('assimilate failed')); // not the generic path
    const worktreeAdds = runSyncSpy.mock.calls.filter((c) => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(worktreeAdds).toHaveLength(0); // clean early-exit, no resurrection FS state
  });

  it('a NON-reattach DroneEvictedError falls through to the generic "assimilate failed" message', async () => {
    const runSyncSpy = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }
    );
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new DroneEvictedError('evicted'); });
    const deps = makeStubDeps({
      ...cubeResolves, runSync: runSyncSpy, stderr, assimilate,
      getActiveCube: vi.fn(async () => null), // no existing seat → reattachPriorId null → generic branch
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unexpected response'));
  });
});

describe('runAssimilate: pin-matched SESSION_REJECTED is PURE DIAGNOSIS (#1082)', () => {
  // Ratified client-seat-reset-state-model clause 1: attach mutates NOTHING on a
  // rejection — it diagnoses and points at the dedicated OFFLINE
  // `borg reset-local-connection` command. No local write happens on the rejected
  // path (clearActiveCube was DELETED — SR-seven (c)).
  const sameCubeSeat = () => vi.fn(async () => ({ cubeId: 'c', droneId: 'd-prior', name: 'myrepo', droneLabel: 'l', apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY, localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), roleName: 'Drone' }));
  const cubeResolves = {
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  };
  // The attach (pinned-TLS) succeeds its identity check, then the server rejects
  // THIS worktree's saved session bearer — a pin-matched SESSION_REJECTED.
  const rejectAttach = () => vi.fn(async () => { throw new BorgServerError('SESSION_REJECTED', 'session bearer no longer accepted'); });

  it('the attach-catch rejection reports the exact superseded diagnosis and mutates nothing', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      isTTY: () => true,
      probeSeat: vi.fn(async () => 'live'),
      getActiveCube: sameCubeSeat(),
      assimilate: rejectAttach(),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      'Local session was superseded by a newer enrollment.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host https://server.test --enroll.\n',
    );
  });

  it('CANONICAL PATH: a pin-matched superseded probe diagnoses before attach with exact copy', async () => {
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('attach must not run after a rejected probe'); });
    const deps = makeStubDeps({
      ...cubeResolves, stderr, assimilate,
      isTTY: () => false,
      probeSeat: vi.fn(async () => 'rejected'),
      getActiveCube: sameCubeSeat(),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(assimilate).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Local session was superseded by a newer enrollment.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host https://server.test --enroll.\n',
    );
  });

  it('the superseded diagnosis is identical whether or not stdin is a TTY', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      isTTY: () => false,
      probeSeat: vi.fn(async () => 'live'),
      getActiveCube: sameCubeSeat(),
      assimilate: rejectAttach(),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      'Local session was superseded by a newer enrollment.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host https://server.test --enroll.\n',
    );
  });

  it('a revoked probe reports the distinct exact diagnosis and does not attach', async () => {
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('attach must not run'); });
    const deps = makeStubDeps({
      ...cubeResolves, stderr, assimilate,
      probeSeat: vi.fn(async () => 'revoked'),
      getActiveCube: sameCubeSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    expect(assimilate).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Local session was revoked.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host https://server.test --enroll.\n',
    );
  });
});

describe('runAssimilate: probe cause is preserved to cause-accurate recovery (CR #6)', () => {
  const savedSeat = () => vi.fn(async () => ({ cubeId: 'c', droneId: 'd-prior', name: 'myrepo', droneLabel: 'l', apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY, localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), sessionToken: 'prior-bearer', roleName: 'Drone' }));
  const cubeResolves = {
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  };

  it("credential-rejected: NON-destructive re-enroll copy, exit 1, no reset diagnosis, no 'restart the server' advice", async () => {
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('attach must not run'); });
    const deps = makeStubDeps({
      ...cubeResolves, stderr, assimilate,
      probeSeat: vi.fn(async () => 'credential-rejected'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    expect(assimilate).not.toHaveBeenCalled();
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('saved enrollment for https://server.test was rejected');
    expect(out).toContain('--enroll');
    // Distinct from the takeover path AND the transient path.
    expect(out).not.toContain('borg reset-local-connection');
    expect(out).not.toMatch(/borg-mcp-server start|Start or restart the server/i);
  });

  it('trust-mismatch: TERMINAL trust copy, exit 1, never restart-the-server advice, never a reset', async () => {
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('attach must not run'); });
    const deps = makeStubDeps({
      ...cubeResolves, stderr, assimilate,
      probeSeat: vi.fn(async () => 'trust-mismatch'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    expect(assimilate).not.toHaveBeenCalled();
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toContain('could not verify the expected server identity');
    expect(out).not.toMatch(/borg-mcp-server start|Start or restart the server/i);
    expect(out).not.toContain('borg reset-local-connection');
  });

  it('indeterminate: STILL the transient restart advice (unchanged, distinct from the terminal causes)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      probeSeat: vi.fn(async () => 'indeterminate'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/could not verify this worktree's saved connection/);
    expect(out).toContain('borg-mcp-server start');
  });

  it('unreachable: transient restart advice (a transport failure/timeout is not terminal)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      probeSeat: vi.fn(async () => 'unreachable'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/could not verify this worktree's saved connection/);
    expect(out).toContain('borg-mcp-server start');
    expect(out).not.toContain('borg reset-local-connection');
  });

  it('endpoint-mismatch (404): a version-mismatch copy — NOT restart advice, NOT a reset', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      probeSeat: vi.fn(async () => 'endpoint-mismatch'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/did not recognize this worktree's drone endpoint|versions? (?:are|is) likely incompatible|versions match/i);
    expect(out).not.toContain('borg reset-local-connection');
  });

  it('server-failure (5xx): a distinct server-error copy — non-destructive, no reset', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      ...cubeResolves, stderr,
      probeSeat: vi.fn(async () => 'server-failure'),
      getActiveCube: savedSeat(),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/returned a server error/i);
    expect(out).not.toContain('borg reset-local-connection');
  });
});

describe('runAssimilate: Sprint 19 (gh#184) strict-rollback semantics', () => {
  it('assimilate API failure: no worktree created (clean early-exit)', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const chdir = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('Cannot assimilate directly into a Queen-class role.'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, assimilate, chdir,
      // Force worktree-want via stale-cubes.json (no worktree should still spawn).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Cannot assimilate'));
    // No worktree-add was attempted (API failure stopped flow BEFORE worktree step).
    const worktreeAddCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
    // No chdir was performed.
    expect(chdir).not.toHaveBeenCalled();
    // No rollback needed: no worktree-remove called.
    const removeCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'remove'
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('local seat finalization failure (post-worktree-spawn) rolls back the spawned worktree', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const finalizeServerSeat = vi.fn(async () => { throw new Error('seat store write failed'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, finalizeServerSeat,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      chdir: vi.fn(),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('finalizeServerSeat failed: seat store write failed'));
    // Rollback called: worktree-remove on the spawned worktree path.
    const rollbackCall = runSyncSpy.mock.calls.find(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'remove'
    );
    expect(rollbackCall).toBeDefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rolled back spawned worktree'));
  });

  it('worktree-remove failure on rollback surfaces manual-cleanup hint to stderr', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 128, stdout: '', stderr: 'fatal: cannot remove' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const finalizeServerSeat = vi.fn(async () => { throw new Error('seat store write failed'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, finalizeServerSeat,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      chdir: vi.fn(),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('manual cleanup needed'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('git worktree remove --force'));
  });

  it('gh#184 canonical: unknown role arg → role-resolution fails → no worktree created', async () => {
    // The original gh#184 bug: `borg assimilate frobnicate` (no matching
    // role) created an orphan worktree at ~/myrepo-frobnicate/ before
    // failing on role-match. The reorder eliminates this class
    // structurally — role resolution happens BEFORE worktree spawn.
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, chdir,
      // Trigger worktree-want via stale-cubes.json (would have created
      // worktree under pre-Sprint-19 flow).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
      ]})),
    });
    const exit = await runAssimilate({ role: 'frobnicate', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('role matching "frobnicate"'));
    // No worktree-add — gh#184 canonical assertion.
    const worktreeAddCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
    expect(chdir).not.toHaveBeenCalled();
  });

  it('fuzzy-match suggestion: misspelled role surfaces "Did you mean" nudge', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:Org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr,
      runSync,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    // "buidler" (lowercase typo) → Levenshtein distance 2 from "builder"
    // (case-folded comparison) → match. Suggestion returns the original
    // cube-defined "Builder" casing.
    const exit = await runAssimilate({ role: 'buidler', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('Did you mean "Builder"?');
  });

  it('fuzzy-match suggestion absent when no close match (distance > 2)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    // "xyzzy" → far from "Builder" → no suggestion.
    const exit = await runAssimilate({ role: 'xyzzy', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('role matching "xyzzy"');
    expect(stderrCalls).not.toContain('Did you mean');
  });
});

// Sprint 18: when `borg assimilate` spawned a sibling worktree, the user's
// terminal cwd resets to the pre-spawn directory after Claude exits (the
// borg process's chdir doesn't propagate to the parent shell). Print a
// stderr nudge after exec returns so the user knows how to get back into
// the worktree.
describe('runAssimilate: Sprint 18 (post-exit shell-cd hint)', () => {
  // Build a stateful cwd/chdir pair: chdir mutates a local cell so cwd()
  // reflects the worktree path after chdir (matches real process behavior).
  function makeCwdPair(initialCwd: string): { cwd: () => string; chdir: (p: string) => void } {
    let current = initialCwd;
    return { cwd: () => current, chdir: (p: string) => { current = p; } };
  }

  it('emits post-exit hint to stderr when a sibling worktree was spawned', async () => {
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      // Trigger worktree spawn via stale active-cube (worktree branch path).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).toContain('Agent exited');
    expect(stderrPayload).toContain('You were working in /home/test/.borg/worktrees/myrepo/drone');
    expect(stderrPayload).toContain('your shell is back in /work/myrepo');
    expect(stderrPayload).toContain('To return:');
    // Spawned worktree path appears verbatim (no <placeholder> tokens) — Sprint 15 N1 invariant.
    expect(stderrPayload).toContain('/home/test/.borg/worktrees/myrepo/drone');
    // Original cwd referenced so user can orient on where they are now.
    expect(stderrPayload).toContain('/work/myrepo');
    expect(stderrPayload).not.toContain('<spawnedWorktreePath>');
    expect(stderrPayload).not.toContain('<originalCwd>');
  });

  it('quotes the cd path with single-quotes to handle spaces + shell metachars', async () => {
    // Real-user case: macOS user with capitalized name like "Jane Doe" causes
    // the spawn path to contain a space. Bare `cd /Users/Jane Doe/...` would fail.
    // gh#556 Part 1: the worktree path now derives from homedir (~/.borg/worktrees/...),
    // so the space is injected via the homedir seam (not the parent dir).
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/Users/Jane Doe/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      homedir: () => '/Users/Jane Doe',
      findProjectRoot: () => '/Users/Jane Doe/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    // cd line uses single-quotes wrapping the path so spaces parse as one arg.
    expect(stderrPayload).toMatch(/cd '\/Users\/Jane Doe\/\.borg\/worktrees\/myrepo\/drone'/);
  });

  it('does NOT emit hint when no sibling worktree was spawned (--here-style flow)', async () => {
    // User in existing cube root → no chdir → spawnedWorktreePath is null.
    const stderr = vi.fn();
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync,
      // No existing active cube + no --worktree flag → no spawn.
      getActiveCube: vi.fn(async () => null),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).not.toContain('Session ended');
    expect(stderrPayload).not.toContain('To return to the worktree');
  });

  it('does NOT emit hint when originalCwd equals spawnedWorktreePath (defensive case)', async () => {
    // Pathological edge case drone-9 UX-LANE flagged: if for any reason
    // originalCwd happens to match the worktree path, the "you're back in X"
    // message would be confusing ("back in X; worktree is at X"). Skip the hint.
    const stderr = vi.fn();
    // Stateless cwd that always returns the same path even after chdir —
    // simulates the defensive case where the cwd doesn't actually change.
    const cwd = vi.fn(() => '/work/myrepo');
    const chdir = vi.fn();
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).not.toContain('Session ended');
  });

  it('defangs shell metachars in pathological paths (drone-11 SR-axis injection-class test)', async () => {
    // SR-axis (cube entry 10:44:35Z): paths can legally contain $VAR /
    // backticks / $(cmd). Single-quote-with-escape MUST defang every
    // shell metachar so paste-execution can't inject arbitrary commands.
    const stderr = vi.fn();
    // gh#556 Part 1: the worktree path now derives from homedir, so the pathological
    // metachars are injected via the homedir seam (the realistic injection vector for
    // the relocated ~/.borg/worktrees/... path). shellEscape must still defang them.
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      homedir: () => '/work/$HOME-evil/`whoami`/$(curl evil)',
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    // Emitted cd line wraps the literal pathological string in single-quotes.
    // The $HOME / backticks / $() appear as literal characters inside single-
    // quotes; POSIX shells do not expand inside single-quotes.
    expect(stderrPayload).toContain(`cd '/work/$HOME-evil/\`whoami\`/$(curl evil)/.borg/worktrees/myrepo/drone'`);
  });

  it('hint is emitted AFTER claude exec returns (so user sees it post-session)', async () => {
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    // Find the post-session stderr call vs exec call ordering.
    const agentExitedCall = stderr.mock.calls.find((c) => String(c[0]).includes('Agent exited'));
    expect(agentExitedCall).toBeDefined();
    const sessionEndedOrder = stderr.mock.invocationCallOrder[stderr.mock.calls.indexOf(agentExitedCall!)];
    const execOrder = exec.mock.invocationCallOrder[0];
    expect(sessionEndedOrder).toBeGreaterThan(execOrder);
  });
});

describe('runAssimilate: step 7 (assimilate + persist)', () => {
  it('calls assimilate with cube + role IDs and finalizes the local seat', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) },
      role_id: 'r',
      finalize: { activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}) },
    }));
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, finalizeServerSeat, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalled();
    expect(finalizeServerSeat).toHaveBeenCalledWith(expect.objectContaining({ active: expect.objectContaining({
      cubeId: 'c',
      droneId: 'd',
      name: 'myrepo',
      droneLabel: 'drone-1',
    }) }));
  });
});

describe('runAssimilate: Step 8 COMPOSITE FINALIZE (Race 2, part C)', () => {
  const REF = 'borg-server-session:' + 'a'.repeat(64);
  const localResultWithFinalize = (activate: () => Promise<unknown>, scrubPending: () => Promise<unknown>) =>
    vi.fn(async () => ({
      cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const,
      local_session: { credential_ref: REF },
      role_id: 'r',
      finalize: { activate, scrubPending },
    }));
  const getCube = () => vi.fn(async () => ({
    id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }],
  }));

  it('a fresh attach drives finalizeServerSeat with an ABSENT expectation + the deferred thunks', async () => {
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(activate, scrubPending),
      getCube: getCube(), finalizeServerSeat,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(0);
    expect(finalizeServerSeat).toHaveBeenCalledTimes(1);
    const call = finalizeServerSeat.mock.calls[0][0];
    expect(call.expected).toEqual({ kind: 'absent' });
    expect(call.active).toMatchObject({ cubeId: 'c', droneId: 'd', localSessionCredentialRef: REF });
    expect(call.commonDir).toBe('/work/myrepo/.git');
    expect(call.repositoryOrigin).toBe('https://github.com/org/myrepo');
    expect(call.activate).toBe(activate);
    expect(call.scrubPending).toBe(scrubPending);
  });

  it('C2: warns when the same public repository has an active seat from a different clone family', async () => {
    const stderr = vi.fn();
    const hasActiveSeatInDifferentCloneFamily = vi.fn(async () => true);
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(),
      stderr,
      hasActiveSeatInDifferentCloneFamily,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps, { launch: false })).toBe(0);
    expect(hasActiveSeatInDifferentCloneFamily).toHaveBeenCalledWith(
      'c',
      'https://github.com/org/myrepo',
      '/work/myrepo/.git',
    );
    expect(stderr).toHaveBeenCalledWith(
      'warning: this cube already has a seat from a different clone family. ' +
      'All seats for a repository use worktrees from the same clone family, sharing its object database and refs.\n',
    );
  });

  it('stays silent when public-repository seats use the same clone family', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(),
      stderr,
      hasActiveSeatInDifferentCloneFamily: vi.fn(async () => false),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps, { launch: false })).toBe(0);
    expect(stderr.mock.calls.flat().join('\n')).not.toContain('clone family');
  });

  it('does not compare clone families for repositories without a remote', async () => {
    const stderr = vi.fn();
    const hasActiveSeatInDifferentCloneFamily = vi.fn(async () => true);
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(),
      stderr,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/myrepo',
        commonDir: '/work/myrepo/.git',
        derivedName: 'myrepo',
        publicRepository: null,
        publicRepositoryName: null,
      })),
      hasActiveSeatInDifferentCloneFamily,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps, { launch: false })).toBe(0);
    expect(hasActiveSeatInDifferentCloneFamily).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join('\n')).not.toContain('clone family');
  });

  it('C6: a failed advisory clone-family comparison never blocks assimilation', async () => {
    const stderr = vi.fn();
    const hasActiveSeatInDifferentCloneFamily = vi.fn(async () => {
      throw new Error('seat store unavailable');
    });
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(),
      stderr,
      hasActiveSeatInDifferentCloneFamily,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps, { launch: false })).toBe(0);
    expect(hasActiveSeatInDifferentCloneFamily).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.flat().join('\n')).not.toContain('clone family');
  });

  it('a --here reattach declares EXACT with the prior live-bearer digest', async () => {
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const existingSeat = vi.fn(async () => ({
      cubeId: 'c', droneId: 'd-prior', name: 'myrepo', droneLabel: 'l',
      apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: REF, sessionToken: 'prior-bearer', roleName: 'Drone',
    }));
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(activate, scrubPending),
      getCube: getCube(), finalizeServerSeat,
      getActiveCube: existingSeat,
      probeSeat: vi.fn(async () => 'live'),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      cwd: () => '/work/myrepo', findProjectRoot: () => '/work/myrepo',
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(0);
    // CR #3: the FULL prior binding — its drone id AND live-bearer digest — is pinned.
    expect(finalizeServerSeat.mock.calls[0][0].expected).toEqual({
      kind: 'exact',
      credentialRef: REF,
      droneId: 'd-prior',
      sessionDigest: createHashDigest('prior-bearer'),
    });
  });

  it('a --here reattach reuses the selected seat stored operation instead of reconstructing current-worktree', async () => {
    const siblingOperation = {
      projectRoot: '/work/source',
      kind: 'sibling' as const,
      operationKey: 'implicit-sibling:survivor',
    };
    const assimilate = localResultWithFinalize(
      vi.fn(async () => {}),
      vi.fn(async () => {}),
    );
    const deps = makeStubDeps({
      assimilate,
      getCube: getCube(),
      finalizeServerSeat: vi.fn(async () => ({ committed: true as const })),
      getActiveCube: vi.fn(async () => ({
        cubeId: 'c',
        droneId: 'd-prior',
        name: 'myrepo',
        droneLabel: 'l',
        apiUrl: 'https://server.test',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: REF,
        sessionToken: 'prior-bearer',
        roleName: 'Drone',
        operation: siblingOperation,
      })),
      probeSeat: vi.fn(async () => 'live'),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      cwd: () => '/work/sibling',
      findProjectRoot: () => '/work/sibling',
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).toBe(0);
    expect(assimilate.mock.calls[0][2].session_operation).toEqual(siblingOperation);
  });

  it('an expectation-mismatch abort fails closed (exit 1), rolls back nothing to overwrite, and never audits success', async () => {
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'expectation-mismatch' as const }));
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(), finalizeServerSeat, stderr,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/changed during attach/);
    expect(out).not.toMatch(/re-attached|no new drone minted/);
  });

  it('a finalize throw fails closed (exit 1)', async () => {
    const finalizeServerSeat = vi.fn(async () => { throw new Error('keychain locked'); });
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(), finalizeServerSeat, stderr,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(1);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(/finalizeServerSeat failed: keychain locked/);
  });

  // CR #5: a spawned-sibling worktree OWNS the persisted binding once FINALIZE
  // has written it. An activation failure after that must NOT delete the worktree.
  const spyRunSync = () => {
    const calls: string[][] = [];
    const runSync = vi.fn((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' };
    });
    return { calls, runSync };
  };
  const removedWorktree = (calls: string[][]) =>
    calls.some((c) => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'remove');

  // A finalize handle exposing the CR#2 bind-pending thunk with a chosen outcome.
  const localResultWithBind = (bindPending: () => Promise<unknown>) =>
    vi.fn(async () => ({
      cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const,
      local_session: { credential_ref: REF },
      role_id: 'r',
      finalize: { activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}), bindPending },
    }));

  it('CR#4: activation-failure with a BOUND pending record PRESERVES the worktree + claims convergence', async () => {
    const { calls, runSync } = spyRunSync();
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'activation-failed' as const }));
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate: localResultWithBind(vi.fn(async () => 'bound' as const)),
      getCube: getCube(), finalizeServerSeat, stderr, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
    // The worktree owns a durable locator (bound-pending) → NOT removed.
    expect(removedWorktree(calls)).toBe(false);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/PRESERVED here|resumable seat state/i);
    expect(out).toMatch(/NOT removed/i);
    expect(out).toMatch(/converge/i);
  });

  it('CR#4: activation-failure with a MISSING/replaced bind makes NO convergence claim + ROLLS BACK the worktree', async () => {
    for (const outcome of ['missing', 'replaced'] as const) {
      const { calls, runSync } = spyRunSync();
      const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'activation-failed' as const }));
      const stderr = vi.fn();
      const deps = makeStubDeps({
        assimilate: localResultWithBind(vi.fn(async () => outcome)),
        getCube: getCube(), finalizeServerSeat, stderr, runSync,
        listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      });
      expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
      // No durable locator → the spawned worktree is rolled back.
      expect(removedWorktree(calls), `${outcome} should roll back`).toBe(true);
      const out = stderr.mock.calls.map((c) => String(c[0])).join('');
      const recovery = out.slice(out.lastIndexOf("This worktree's secure session"));
      // Truthful FAILURE — never the false-success "converge / identical seat reused" claim.
      expect(recovery).toMatch(new RegExp(outcome, 'i'));
      expect(recovery).toMatch(/no client-only command/i);
      expect(recovery).not.toMatch(/reset-local-connection|re-run `borg assimilate/i);
      expect(recovery).not.toMatch(/converge|identical seat is reused/i);
    }
  });

  it('CR#4: activation-failure where bindPending THROWS makes NO convergence claim + rolls back', async () => {
    const { calls, runSync } = spyRunSync();
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'activation-failed' as const }));
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate: localResultWithBind(vi.fn(async () => { throw new Error('store busy'); })),
      getCube: getCube(), finalizeServerSeat, stderr, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
    expect(removedWorktree(calls)).toBe(true);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/private store could not be read or written/i);
    expect(out).toMatch(/no client-only command/i);
    expect(out).not.toMatch(/converge|identical seat is reused/i);
  });

  it('CR#2: a spawned-sibling activation-failure BINDS the surviving pending record to the preserved worktree (rerun locator)', async () => {
    const { calls, runSync } = spyRunSync();
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'activation-failed' as const }));
    const bindPending = vi.fn(async () => 'bound' as const);
    // A finalize handle that also exposes the CR#2 bind-pending thunk.
    const assimilate = vi.fn(async () => ({
      cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const,
      local_session: { credential_ref: REF },
      role_id: 'r',
      finalize: { activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}), bindPending },
    }));
    const deps = makeStubDeps({
      assimilate, getCube: getCube(), finalizeServerSeat, stderr: vi.fn(), runSync,
      cwd: () => '/home/test/.borg/worktrees/myrepo/drone-2',
      findProjectRoot: () => '/home/test/.borg/worktrees/myrepo/drone-2',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
    // The preserved worktree now OWNS a discoverable, resumable pending record.
    expect(bindPending).toHaveBeenCalledTimes(1);
    expect(bindPending.mock.calls[0][0]).toMatchObject({ worktree: '/home/test/.borg/worktrees/myrepo/drone-2' });
    // ...and the worktree that owns it was NOT removed.
    expect(removedWorktree(calls)).toBe(false);
  });

  it('CR #5: an expectation-mismatch on a spawned sibling DOES roll it back (the binding was never written)', async () => {
    const { calls, runSync } = spyRunSync();
    const finalizeServerSeat = vi.fn(async () => ({ committed: false as const, reason: 'expectation-mismatch' as const }));
    const deps = makeStubDeps({
      assimilate: localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {})),
      getCube: getCube(), finalizeServerSeat, stderr: vi.fn(), runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
    expect(removedWorktree(calls)).toBe(true);
  });

  it('CR #1: a PREPARE abort (reset won before PREPARE) exits cleanly BEFORE any worktree spawn or finalize', async () => {
    const { calls, runSync } = spyRunSync();
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const stderr = vi.fn();
    // deps.assimilate signals the cube-lock PREPARE revalidation aborted before mint/send.
    const assimilate = vi.fn(async () => ({
      cube_id: 'c', drone_id: '', drone_label: '', role_id: 'r', prepareAborted: true as const,
    }));
    const deps = makeStubDeps({
      assimilate, getCube: getCube(), finalizeServerSeat, stderr, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'drone-2' } }, deps)).toBe(1);
    const out = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(out).toMatch(/changed before the attach/);
    expect(out).toMatch(/no credential was created or sent/);
    // No FINALIZE, and no worktree was ever spawned (so none to roll back).
    expect(finalizeServerSeat).not.toHaveBeenCalled();
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'worktree' && c[2] === 'add')).toBe(false);
    expect(removedWorktree(calls)).toBe(false);
  });

  it('CR #1: a fresh attach uses an implicit sibling operation and revalidates ABSENT at PREPARE', async () => {
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const assimilate = localResultWithFinalize(vi.fn(async () => {}), vi.fn(async () => {}));
    const deps = makeStubDeps({
      assimilate, getCube: getCube(), finalizeServerSeat,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(0);
    const params = assimilate.mock.calls[0][2];
    expect(params.session_operation!.kind).toBe('sibling');
    expect(params.session_operation!.operationKey).toMatch(/^implicit-sibling:/);
    expect(params.session_expected).toEqual({ kind: 'absent' });
    expect(params.revalidate_at_prepare).toBe(true);
  });

  it('CR #1: an implicit sibling gets a COLLISION-SAFE (distinct-per-run) operation key and revalidates ABSENT at PREPARE', async () => {
    const existingCube = {
      cubeId: 'cube-1', droneId: 'drone-prior', name: 'myrepo', droneLabel: 'drone-1',
      apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), roleName: 'Drone',
      operation: { projectRoot: '/work/myrepo', kind: 'seat' as const, operationKey: 'current-worktree' },
    };
    const runOnce = async () => {
      const assimilate = vi.fn(async () => ({
        cube_id: 'cube-1', drone_id: 'drone-x', drone_label: 'drone-2', role_id: 'role-default',
        result: 'created' as const,
        local_session: {
          credential_ref: 'borg-server-session:' + 'b'.repeat(64),
        },
      }));
      const deps = makeStubDeps({
        assimilate,
        getActiveCube: vi.fn(async () => existingCube),
        listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
        getCube: vi.fn(async () => ({
          id: 'cube-1', name: 'myrepo',
          roles: [{ id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false }],
        })),
      });
      // Plain assimilation from a legacy in-place seat creates a managed sibling.
      expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(0);
      return assimilate.mock.calls[0][2];
    };
    const p1 = await runOnce();
    const p2 = await runOnce();
    expect(p1.session_operation!.kind).toBe('sibling');
    expect(p1.session_operation!.operationKey).toMatch(/^implicit-sibling:/);
    expect(p1.revalidate_at_prepare).toBe(true);
    // CR1(a): two implicit siblings mint DISTINCT keys — they never collide on one seat.
    expect(p1.session_operation!.operationKey).not.toBe(p2.session_operation!.operationKey);
  });

  it('CR#3: an implicit sibling ADOPTS an in-flight attempt (recovered op + role, ABSENT pending-reuse)', async () => {
    const existingCube = {
      cubeId: 'cube-1', droneId: 'drone-prior', name: 'myrepo', droneLabel: 'drone-1',
      apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), roleName: 'Drone',
    };
    // A persisted crash-orphaned unbound pending sibling: its EXACT operation (a stable
    // operationKey) + role must be adopted so the rerun re-derives the same seat.
    const recoveredOp = { projectRoot: '/orig/repo', kind: 'sibling' as const, operationKey: 'implicit-sibling:PERSISTED' };
    const findIncompleteSiblingAttempt = vi.fn(async () => ({
      operation: recoveredOp, roleId: 'role-default', credentialRef: 'borg-server-session:' + 'c'.repeat(64),
    }));
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-x', drone_label: 'drone-2', role_id: 'role-default',
      result: 'reused' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'c'.repeat(64) },
    }));
    const deps = makeStubDeps({
      assimilate,
      findIncompleteSiblingAttempt,
      getActiveCube: vi.fn(async () => existingCube),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1', name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false }],
      })),
    });
    expect(await runAssimilate({ role: undefined, flags: { yes: true } }, deps)).toBe(0);
    expect(findIncompleteSiblingAttempt).toHaveBeenCalledTimes(1);
    const params = assimilate.mock.calls[0][2];
    // The EXACT recovered operation is re-sent (same operationKey → same seat ref),
    // NOT a fresh per-invocation UUID.
    expect(params.session_operation).toEqual(recoveredOp);
    // The recovered role is adopted (role_id from the stored attempt).
    expect(params.role_id).toBe('role-default');
    // A PENDING resume → ABSENT/pending-reuse so prepareSeat re-sends the identical bearer.
    expect(params.session_expected).toEqual({ kind: 'absent' });
  });
});

describe('runAssimilate: step 6 (role resolution)', () => {
  it('first drone with no role → human-seat role', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-coord' }));
    const createCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ assimilate, createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coord' }),
      expect.any(String),
    );
  });

  it('falls through to the default worker once the mandatory Coordinator seat is occupied', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-build' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
      drones: [{ role_id: 'r-coord' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-build' }),
      expect.any(String),
    );
  });

  // Task 2 (occupancy-aware bare assimilate): default role Builder already
  // has an active drone seated; Reviewer is a free worker role. A bare
  // assimilate (non-first-drone path — cube already has a drone) must skip
  // the occupied default and pick the unoccupied worker role instead.
  it('bare assimilate skips the occupied default and picks the next worker role', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-reviewer' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      // non-first-drone path: cube already exists (has a seat)
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-reviewer' }),
      expect.any(String),
    );
  });

  it('bare assimilate treats a presumed-abandoned role as fillable', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-builder' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder', presumed_abandoned: true }],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-builder' }),
      expect.any(String),
    );
  });

  it('a live occupant still blocks its role when abandoned rows are also present', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-3', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-reviewer' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [
        { role_id: 'r-builder', presumed_abandoned: true },
        { role_id: 'r-builder', presumed_abandoned: false },
      ],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-reviewer' }),
      expect.any(String),
    );
  });

  it('bare assimilate refills a mandatory role past the give-up advisory', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-coordinator' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-coordinator', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-coordinator', presumed_abandoned: true }],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coordinator' }),
      expect.any(String),
    );
  });

  it('bare assimilate fills an unoccupied mandatory Coordinator before worker roles', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-coordinator' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-coordinator', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coordinator' }),
      expect.any(String),
    );
  });

  it('explicit displayed role name matches case- and separator-insensitively', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-3', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-cr' }));
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [
        { id: 'r-cr', name: 'Code Reviewer', is_default: false, is_human_seat: false },
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    await runAssimilate({ role: 'Code Reviewer', flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-cr' }),
      expect.any(String),
    );
  });

  it('accepts the capitalized single-word role shown by the product', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-3', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-build' }));
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [{ id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });

    await runAssimilate({ role: 'Builder', flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-build' }),
      expect.any(String),
    );
  });

  it('errors when role name does not match', async () => {
    const stderr = vi.fn();
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [{ id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    const exit = await runAssimilate({ role: 'nonexistent', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('role matching'));
  });
});

describe('runAssimilate: step 5 (first-drone bootstrap)', () => {
  it('creates the cube with the software-development template on the guided bootstrap path', async () => {
    const createCube = vi.fn(async () => ({
      id: 'c-new',
      name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        name: 'myrepo',
        workingRepoName: 'myrepo',
        repository: { kind: 'origin', value: 'https://github.com/org/myrepo' },
        template: 'software-dev',
      }),
      expect.any(String),
    );
  });

  it('rejects a template outside the guided creation contract', async () => {
    const stderr = vi.fn();
    const createCube = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ stderr, createCube: createCube as any, runSync, listCubes: vi.fn(async () => []) });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, template: 'research' } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown template 'research'"));
    expect(createCube).not.toHaveBeenCalled();
  });
});

describe('runAssimilate: step 4 (cube existence + detail)', () => {
  it('discovers an exact-name legacy cube and refuses to auto-adopt it with --yes', async () => {
    const listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'myrepo' }]);
    const createCube = vi.fn();
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ stderr, listCubes, createCube, runSync, getActiveCube: vi.fn(async () => null) });
    await expect(runAssimilate({ role: undefined, flags: { yes: true } }, deps)).resolves.toBe(1);
    expect(listCubes).toHaveBeenCalledOnce();
    expect(createCube).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      "Found existing cube 'myrepo' on https://server.test.\n" +
      'Linking a repository to an existing cube requires one interactive confirmation.\n' +
      "Run borg assimilate --host 'https://server.test' --cube-name 'myrepo' once in an interactive terminal to link it; scripted runs work from then on.\n" +
      'No cube, repository binding, or drone was created.\n',
    );
  });
});

describe('runAssimilate: step 3 (worktree decision)', () => {
  it('first assimilation spawns a managed sibling and leaves the main checkout untouched', async () => {
    let currentCwd = '/work/myrepo';
    const calls: string[][] = [];
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[3] === 'refs/heads/wt-drone') return { status: 1, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn((path: string) => { currentCwd = path; });
    const deps = makeStubDeps({
      runSync,
      chdir,
      cwd: () => currentCwd,
      getActiveCube: vi.fn(async () => null),
    });
    await expect(runAssimilate({ role: undefined, flags: { yes: true } }, deps)).resolves.toBe(0);
    expect(calls).toContainEqual([
      'worktree', 'add', '-b', 'wt-drone',
      '/home/test/.borg/worktrees/myrepo/drone', 'origin/main',
    ]);
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/drone');
    expect(calls).not.toContainEqual(['fetch', 'origin', '--prune']);
    expect(calls.some((args) => args[0] === 'switch')).toBe(false);
  });

  it('auto-creates sibling worktree on collision', async () => {
    let currentCwd = '/work/myrepo';
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // gh#864: no lingering per-worktree branch → localBranchExists false → -b path.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn((path: string) => { currentCwd = path; });
    const stderr = vi.fn();
    const pathExists = vi.fn(() => false);
    const setCliPreferenceForWorktree = vi.fn(async () => {});
    const deps = makeStubDeps({
      runSync, setCliPreferenceForWorktree,
      chdir, stderr,
      pathExists,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => currentCwd,
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    // gh#556 Part 1: NEW worktree at ~/.borg/worktrees/<repo>/<name> (homedir stub = /home/test).
    // gh#33: named per-worktree branch (wt-<suffix>) UNAFFECTED by the relocation, NOT detached HEAD.
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-builder', '/home/test/.borg/worktrees/myrepo/builder', 'origin/main'], expect.any(String));
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/builder');
    expect(setCliPreferenceForWorktree).toHaveBeenCalledWith(
      'claude',
      '/home/test/.borg/worktrees/myrepo/builder',
    );
    // gh#556 Part 1: the intermediate ~/.borg/worktrees/<repo>/ is mkdir-p'd before `git worktree add`.
    expect(deps.mkdirp).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo');
    const stderrPayload = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrPayload).toContain('WORKTREE STEERING');
    expect(stderrPayload).toContain('You are in worktree /home/test/.borg/worktrees/myrepo/builder on branch wt-builder');
    expect(stderrPayload).toContain('Do ALL work HERE');
    expect(stderrPayload).toContain('NEVER `git -C /work/myrepo`');
    expect(stderrPayload).toContain('work created in the primary won\'t reach your wt-branch without manual surgery (cherry-pick/merge)');
  });

  it('rolls back a sibling when saving its CLI preference fails', async () => {
    const spawnedPath = '/home/test/.borg/worktrees/myrepo/builder';
    let currentCwd = '/work/myrepo';
    let spawnedWorktreePresent = false;
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        spawnedWorktreePresent = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        spawnedWorktreePresent = false;
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[3]?.startsWith('refs/heads/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: 'head', stderr: '' };
    });
    const chdir = vi.fn((path: string) => { currentCwd = path; });
    const pathExists = vi.fn((path: string) => path === spawnedPath && spawnedWorktreePresent);
    const stderr = vi.fn();
    const provisionLaunchAccess = vi.fn();
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const setCliPreferenceForWorktree = vi.fn(async () => {
      throw new Error('preference write failed');
    });
    const deps = makeStubDeps({
      runSync,
      chdir,
      cwd: () => currentCwd,
      pathExists,
      stderr,
      provisionLaunchAccess,
      finalizeServerSeat,
      setCliPreferenceForWorktree,
      getActiveCube: vi.fn(async () => null),
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ] })),
    });

    await expect(runAssimilate({ role: 'builder', flags: { yes: true, worktree: 'builder' } }, deps)).resolves.toBe(1);

    expect(setCliPreferenceForWorktree).toHaveBeenCalledWith('claude', spawnedPath);
    expect(runSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', spawnedPath],
      '/work/myrepo',
    );
    expect(spawnedWorktreePresent).toBe(false);
    expect(pathExists(spawnedPath)).toBe(false);
    expect(provisionLaunchAccess).not.toHaveBeenCalled();
    expect(finalizeServerSeat).not.toHaveBeenCalled();

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(`could not save the claude preference for sibling worktree ${spawnedPath}: preference write failed`);
    expect(output).toContain(`rolled back spawned worktree at ${spawnedPath}`);
  });

  it('uses the common repository namespace and bumps duplicate worktree names across fragmented paths', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/borg-mcp.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          status: 0,
          stdout:
            'worktree /work/borg-mcp\nHEAD abc\nbranch refs/heads/main\n\n' +
            'worktree /home/test/.borg/worktrees/product-strategy/builder\nHEAD def\nbranch refs/heads/wt-builder\n',
          stderr: '',
        };
      }
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync,
      stderr,
      cwd: () => '/home/test/.borg/worktrees/product-strategy',
      findProjectRoot: () => '/home/test/.borg/worktrees/product-strategy',
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/home/test/.borg/worktrees/product-strategy',
        commonDir: '/work/borg-mcp/.git',
        derivedName: 'product-strategy',
        publicRepository: { kind: 'origin', value: 'https://github.com/org/borg-mcp' },
        publicRepositoryName: 'org/borg-mcp',
      })),
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'borg-mcp', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'borg-mcp' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'borg-mcp', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });

    const exit = await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'builder' } }, deps);
    expect(exit, stderr.mock.calls.map((call) => String(call[0])).join('')).toBe(0);

    expect(runSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'wt-builder-2', '/home/test/.borg/worktrees/borg-mcp/builder-2', 'origin/main'],
      '/home/test/.borg/worktrees/product-strategy',
    );
    expect(deps.chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/borg-mcp/builder-2');
  });

  it('starts a sibling from local HEAD when the repository has no usable origin', async () => {
    const calls: string[][] = [];
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { status: 2, stdout: '', stderr: 'error: No such remote origin' };
      }
      if (args.join(' ') === 'rev-parse --is-bare-repository') {
        return { status: 0, stdout: 'false\n', stderr: '' };
      }
      if (args.join(' ') === 'rev-parse --verify HEAD') {
        return { status: 0, stdout: '16c1405abcdef0123456789\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const deps = makeStubDeps({
      runSync,
      stderr,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { yes: true, worktree: 'builder' },
    }, deps)).resolves.toBe(0);

    expect(calls).not.toContainEqual(['fetch', 'origin']);
    expect(calls).not.toContainEqual(['rev-parse', '--verify', 'origin/main']);
    expect(runSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'wt-builder', '/home/test/.borg/worktrees/myrepo/builder', 'HEAD'],
      '/work/myrepo',
    );
    expect(stderr).toHaveBeenCalledWith(
      'note: no usable origin; new worktree will start on local HEAD (16c1405)\n',
    );
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).not.toContain(
      'the original dir keeps its active drone binding',
    );
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).not.toContain('active seat');
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).not.toContain('that seat binding');
  });

  // BUG-4 / gh#150 regression (Sprint 3): step 3 must detect unborn-HEAD
  // before calling `git worktree add --detach` and surface an actionable
  // error rather than git's cryptic "fatal: not a valid object name: 'HEAD'".
  // Sprint 4 / gh#147 — verify the wt.stderr interpolation site
  // applies safeStderr so a hostile .git/config can't corrupt the
  // operator's terminal via ANSI escapes in git's stderr output.
  it('Sprint 4: worktree-add failure stderr is safeStderr-stripped (gh#147)', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        // git returns stderr containing an ANSI escape (clear-screen + cursor move).
        return { status: 128, stdout: '', stderr: 'fatal: \x1b[2Jmalicious\x00\x07' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync, stderr,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    // Original control chars are gone.
    expect(stderrCalls).not.toContain('\x1b[2J');
    expect(stderrCalls).not.toContain('\x00');
    expect(stderrCalls).not.toContain('\x07');
    // Printable remainder of the git message is preserved.
    expect(stderrCalls).toContain('Borg could not create sibling worktree');
    expect(stderrCalls).toContain('fatal: [2Jmalicious');
    expect(stderrCalls).toContain('git worktree list');
    expect(stderrCalls).toContain('git status');
    expect(stderrCalls).toContain(
      'A local drone reservation was created and remains pending; rerunning after fixing the worktree issue resumes that reservation.',
    );
    expect(stderrCalls).not.toContain('resumes that seat');
  });

  it('BUG-4 / unborn HEAD: fails fast with actionable error before git worktree add', async () => {
    const stderr = vi.fn();
    const assimilate = vi.fn();
    const createCube = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      // unborn HEAD: git rev-parse --verify HEAD exits non-zero.
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 128, stdout: '', stderr: "fatal: Needed a single revision\n" };
      }
      // If we got here for worktree add, the guard failed.
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('worktree add called despite unborn-HEAD guard');
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync, stderr, assimilate, createCube,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('sibling worktree spawn requires HEAD pointing at a commit');
    expect(stderrCalls).toContain('git commit --allow-empty');
    expect(stderrCalls).not.toContain('--here');
    expect(createCube).not.toHaveBeenCalled();
    expect(assimilate).not.toHaveBeenCalled();
    // Crucially, `worktree add` was never invoked — runSync would have thrown.
    const worktreeAddCalls = runSync.mock.calls.filter(
      (c) => c[1][0] === 'worktree' && c[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it('BUG-4 / born HEAD: rev-parse --verify HEAD succeeds → worktree add proceeds normally', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync, chdir,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/builder');
  });

  it('--here errors out on collision instead of spawning', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const deps = makeStubDeps({
      runSync,
      stderr,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('already hosts an active drone'));
  });

  it('--here collision aborts BEFORE the API assimilate — no orphan drone row minted (gh#780)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const assimilateSpy = vi.fn(async () => {
      throw new Error('should never be reached: the collision check must precede the mint');
    });
    const deps = makeStubDeps({
      runSync,
      stderr: vi.fn(),
      assimilate: assimilateSpy as any,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    // Pre-gh#780, Step 6 minted the drone row server-side and Step 7 then
    // aborted without ever persisting the mapping — orphaning the row.
    expect(assimilateSpy).not.toHaveBeenCalled();
  });

  it('--here resumes a legacy in-place seat without spawning a sibling (gh#780 PR-D)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const assimilateSpy = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-prior',
      drone_label: 'one-of-one-builder',
      role_id: 'role-builder',
      result: 'reused' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'b'.repeat(64) },
    }));
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const deps = makeStubDeps({
      runSync,
      stderr,
      finalizeServerSeat,
      assimilate: assimilateSpy as any,
      // Saved identity for THIS worktree, SAME cube + server authority as the target.
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-1', droneId: 'drone-prior', name: 'myrepo', droneLabel: 'one-of-one-builder',
        apiUrl: 'https://server.test', serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64), roleName: 'Builder',
        operation: { projectRoot: '/work/myrepo', kind: 'seat', operationKey: 'current-worktree' },
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(0);
    expect(assimilateSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ prior_drone_id: 'drone-prior' }),
      expect.any(String),
    );
    const params = (assimilateSpy.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    expect(params.session_operation).toEqual({
      projectRoot: '/work/myrepo', kind: 'seat', operationKey: 'current-worktree',
    });
    expect(finalizeServerSeat).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({
        droneId: 'drone-prior',
        localSessionCredentialRef: 'borg-server-session:' + 'b'.repeat(64),
      }),
    }));
    // In-place recovery: no sibling worktree spawned.
    expect(runSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['worktree']), expect.anything());
    // The recovery is announced; the gh#700 "didn't grant" note is NOT
    // (the seat's role is authoritative on reattach).
    const stderrText = (stderr.mock.calls as unknown as string[][]).map((c) => c[0]).join('');
    expect(stderrText).toMatch(/re-?attached/i);
    expect(stderrText).not.toContain("didn't grant");
  });

  it('refuses --here reattach before mutation when the saved seat monitor is already live (#56)', async () => {
    const assimilateSpy = vi.fn();
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      assimilate: assimilateSpy as any,
      inspectLiveInboxMonitor: vi.fn(() => ({ pid: 4242, heartbeat: 'fresh' })),
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-1',
        droneId: 'drone-prior',
        name: 'myrepo',
        droneLabel: 'one-of-one-builder',
        apiUrl: 'https://server.test',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
        roleName: 'Builder',
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false }],
      })),
    });

    await expect(runAssimilate({
      role: 'builder',
      flags: { yes: true, here: true },
    }, deps)).resolves.toBe(1);
    expect(assimilateSpy).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('pid 4242'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--force'));
  });

  it('--force explicitly permits --here reattach to a seat whose monitor PID is live (#56)', async () => {
    const assimilateSpy = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-prior',
      drone_label: 'one-of-one-builder',
      role_id: 'role-builder',
      result: 'reused' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'b'.repeat(64) },
    }));
    const deps = makeStubDeps({
      assimilate: assimilateSpy as any,
      inspectLiveInboxMonitor: vi.fn(() => ({ pid: 4242, heartbeat: 'fresh' })),
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-1',
        droneId: 'drone-prior',
        name: 'myrepo',
        droneLabel: 'one-of-one-builder',
        apiUrl: 'https://server.test',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
        roleName: 'Builder',
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false }],
      })),
    });

    await expect(runAssimilate({
      role: 'builder',
      flags: { yes: true, here: true, force: true },
    }, deps)).resolves.toBe(0);
    expect(assimilateSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ['main checkout', '/work/myrepo', '/work/myrepo/.git'],
    ['hand-made linked worktree', '/work/manual', '/work/myrepo/.git/worktrees/manual'],
  ])('refuses --here without a saved seat in a %s before cube or drone creation', async (_label, root, commonDir) => {
    const assimilate = vi.fn();
    const createCube = vi.fn();
    const stderr = vi.fn();
    const deps = makeStubDeps({
      assimilate,
      createCube,
      stderr,
      cwd: () => root,
      findProjectRoot: () => root,
      resolveRepositoryContext: vi.fn(async () => ({
        root,
        commonDir,
        derivedName: 'myrepo',
        publicRepository: { kind: 'origin', value: 'https://github.com/org/myrepo' },
        publicRepositoryName: 'org/myrepo',
      })),
    });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps)).resolves.toBe(1);
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain('borg assimilate');
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).not.toContain('Run `borg assimilate --here`');
    expect(createCube).not.toHaveBeenCalled();
    expect(assimilate).not.toHaveBeenCalled();
  });
});

describe('runAssimilate: step 2 (cube-name derivation)', () => {
  it('uses --cube-name flag override', async () => {
    const prompt = vi.fn();
    const createCube = vi.fn(async () => ({ id: 'c', name: 'override', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ prompt, createCube });
    await runAssimilate({ role: undefined, flags: { server: 'localhost:8787', cubeName: 'override', yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ name: 'override' }),
      SERVER_TRUST_IDENTITY,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects a local --cube-name outside the closed create contract before enrollment', async () => {
    const connectServer = vi.fn();
    const deps = makeStubDeps({ connectServer });
    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, cubeName: '../escape' },
    }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid cube name.'));
    expect(connectServer).not.toHaveBeenCalled();
    expect(deps.promptSecret).not.toHaveBeenCalled();
  });

  it('derives from git remote origin', async () => {
    const runSync = vi.fn((cmd, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { status: 0, stdout: 'git@github.com:Org/cool-repo.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const createCube = vi.fn(async () => ({ id: 'c', name: 'cool-repo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      runSync, createCube,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/cool-repo', commonDir: '/work/cool-repo/.git', derivedName: 'cool-repo',
        publicRepository: { kind: 'origin', value: 'https://github.com/Org/cool-repo' },
        publicRepositoryName: 'Org/cool-repo',
      })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'cool-repo' }), expect.any(String));
  });

  it('uses the sanitized repository basename with --yes when no origin exists', async () => {
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args.join(' ') === 'rev-parse --verify HEAD'
        ? { status: 0, stdout: 'abc123\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'fatal: No such remote' }
    );
    const prompt = vi.fn();
    const createCube = vi.fn(async () => ({ id: 'c', name: 'my-repo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      runSync, prompt, createCube, cwd: () => '/work/My_Repo', findProjectRoot: () => '/work/My_Repo',
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/My_Repo', commonDir: '/work/My_Repo/.git', derivedName: 'my-repo',
        publicRepository: null, publicRepositoryName: null,
      })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'my-repo' }), expect.any(String));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('uses the editable guided name for a no-origin repository', async () => {
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      if (args.join(' ') === 'rev-parse --verify HEAD') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'fatal: No such remote' };
    });
    const prompt = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('y');
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const createCube = vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      runSync, prompt, connectServer, createCube,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/myrepo', commonDir: '/work/myrepo/.git', derivedName: 'myrepo',
        publicRepository: null, publicRepositoryName: null,
      })),
    });
    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).resolves.toBe(0);
    expect(prompt).toHaveBeenCalledWith('Cube name [myrepo]: ');
    expect(createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ name: 'myrepo' }),
      SERVER_TRUST_IDENTITY,
    );
  });

  it('does not create when the user declines the guided confirmation', async () => {
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args.join(' ') === 'rev-parse --verify HEAD'
        ? { status: 0, stdout: 'abc123\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'fatal: No such remote' }
    );
    const prompt = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('n');
    const connectServer = vi.fn(async () => ({
      token: 'server-token', trustIdentity: SERVER_TRUST_IDENTITY, serverCapabilities: ['create_cube'],
    }));
    const createCube = vi.fn();
    const deps = makeStubDeps({
      runSync, prompt, connectServer, createCube,
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/myrepo', commonDir: '/work/myrepo/.git', derivedName: 'myrepo',
        publicRepository: null, publicRepositoryName: null,
      })),
    });
    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787', enroll: true } }, deps)).resolves.toBe(0);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Cube creation cancelled.'));
    expect(createCube).not.toHaveBeenCalled();
  });

  it('requires --cube-name or --yes for a non-interactive no-origin repository', async () => {
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args.join(' ') === 'rev-parse --verify HEAD'
        ? { status: 0, stdout: 'abc123\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'fatal: No such remote' }
    );
    const createCube = vi.fn();
    const deps = makeStubDeps({ runSync, createCube, isTTY: () => false });
    await expect(runAssimilate({ role: undefined, flags: {} }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('--cube-name <name>'));
    expect(createCube).not.toHaveBeenCalled();
  });

  it('fails closed when a no-origin repository is bare', async () => {
    const runSync = vi.fn((_cmd: string, commandArgs: string[]) => {
      if (commandArgs[0] === 'rev-parse') {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'fatal: No such remote' };
    });
    const createCube = vi.fn();
    const deps = makeStubDeps({
      runSync, createCube, cwd: () => '/work/repo.git', findProjectRoot: () => '/work/repo.git',
      resolveRepositoryContext: vi.fn(async () => { throw new Error('BARE_REPOSITORY'); }),
    });
    await expect(runAssimilate({ role: undefined, flags: { yes: true } }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('requires a non-bare repository worktree'));
    expect(createCube).not.toHaveBeenCalled();
  });
});

// v0.9.2 hotfix regression tests (drone-1 DISPATCH-FIX 2026-05-18T10:48Z).
describe('runAssimilate: BUG-1 — UX-F4 stderr false positive', () => {
  it('does not emit basename-fallback nudge when remote parses to same name as basename', async () => {
    const stderr = vi.fn();
    // remote parses → 'myrepo' (real success), cwd basename → 'myrepo'.
    // The prior `cubeName === deriveCubeName(projectRoot, null)` proxy
    // produced a false positive here; the v0.9.2 fix calls parseGitRemote
    // directly so this case is silent.
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:Org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, runSync,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain("couldn't parse git remote");
  });

  it('uses the local repository identity when the origin remote is unparseable', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'not-a-url', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const createCube = vi.fn(async () => ({ id: 'c', name: 'somerepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      stderr, runSync, createCube,
      cwd: () => '/work/somerepo',
      findProjectRoot: () => '/work/somerepo',
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/somerepo', commonDir: '/work/somerepo/.git', derivedName: 'somerepo',
        publicRepository: null, publicRepositoryName: null,
      })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain('not-a-url');
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'somerepo' }), expect.any(String));
  });
});

describe('runAssimilate: BUG-2 — wire shape unwrap', () => {
  // The bug was that the orchestrator received the wrapped `{cube, roles}`
  // shape, but stub-based Phase E tests hid the mismatch by returning a
  // pre-unwrapped shape. The v0.9.2 fix moved the unwrap to remote-client.
  // These tests stub the WIRE-shape `{cube, roles}` returned by remote-client
  // to exercise the orchestrator's expected flat-shape contract end-to-end.
  it('orchestrator step 5 → step 6 transitions correctly with createCube returning flat shape', async () => {
    const createCube = vi.fn(async () => ({
      // Flat shape per the v0.9.2 remote-client unwrap contract.
      id: 'c-new',
      name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const assimilate = vi.fn(async () => ({
      cube_id: 'c-new', drone_id: 'd', drone_label: 'drone-1', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-coord',
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, assimilate, runSync, listCubes: vi.fn(async () => []) });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    // Step 6 reached cubeDetail.roles.find without "Cannot read properties of undefined".
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.objectContaining({ role_id: 'r-coord' }),
      expect.any(String),
    );
  });

  it('orchestrator handles getCube returning flat shape on existing-cube path', async () => {
    const getCube = vi.fn(async () => ({
      id: 'c-existing',
      name: 'myrepo',
      roles: [{ id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false }],
      drones: [],
    }));
    const assimilate = vi.fn(async () => ({
      cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', result: 'created' as const, local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) }, role_id: 'r-build',
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      getCube, assimilate, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.objectContaining({ role_id: 'r-build' }),
      expect.any(String),
    );
  });
});

describe('runAssimilate: #1015 authority selection', () => {
  it('connects directly to an explicit local server and finalizes its endpoint-bound seat', async () => {
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const listCubes = vi.fn(async () => []);
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const prompt = vi.fn(async () => 'must-not-prompt');
    const deps = makeStubDeps({
      connectServer,
      listCubes,
      finalizeServerSeat,
      prompt,
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'localhost:8787', yes: true } }, deps)).toBe(0);

    expect(connectServer).toHaveBeenCalledWith('https://localhost:8787');
    expect(deps.ensureLocalServerInstalled).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(listCubes).toHaveBeenCalledWith(
      'https://localhost:8787',
      'local-token',
      SERVER_TRUST_IDENTITY,
    );
    expect(finalizeServerSeat).toHaveBeenCalledWith(expect.objectContaining({
      active: expect.objectContaining({
        apiUrl: 'https://localhost:8787',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
      }),
    }));
  });

  it.each([
    ['declined', 1],
    ['non-interactive', 1],
    ['failed', 1],
    ['installed', 0],
  ] as const)(
    'stops before private-state mutation when first-run server installation is %s',
    async (serverInstall, expectedExit) => {
      const preparePrivateRoot = vi.fn(async () => {});
      const connectServer = vi.fn();
      const ensureLocalServerInstalled = vi.fn(async () => serverInstall);
      const deps = makeStubDeps({
        defaultAuthority: undefined,
        preparePrivateRoot,
        connectServer,
        ensureLocalServerInstalled,
      });

      expect(await runAssimilate({ role: undefined, flags: {} }, deps)).toBe(expectedExit);

      expect(ensureLocalServerInstalled).toHaveBeenCalledWith(
        'borg assimilate --host <host>',
      );
      expect(preparePrivateRoot).not.toHaveBeenCalled();
      expect(connectServer).not.toHaveBeenCalled();
    },
  );

  it('passes the cube-init recovery command into the pre-core first-run helper', async () => {
    const preparePrivateRoot = vi.fn(async () => {});
    const ensureLocalServerInstalled = vi.fn(async () => 'non-interactive' as const);
    const deps = makeStubDeps({
      defaultAuthority: undefined,
      preparePrivateRoot,
      ensureLocalServerInstalled,
    });

    await expect(runAssimilate({
      role: undefined,
      flags: {},
      mode: 'cube-init',
    }, deps)).resolves.toBe(1);

    expect(ensureLocalServerInstalled).toHaveBeenCalledWith(
      'borg server cube init --host <host>',
    );
    expect(preparePrivateRoot).not.toHaveBeenCalled();
  });

  it('gives an endpoint-bound recovery command when a local role is unavailable', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
    });

    expect(await runAssimilate({
      role: 'reviewer',
      flags: { server: 'localhost:8787', yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('`borg assimilate --host https://localhost:8787 <role>`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound recovery command when a local cube has no default role', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      getRepositoryAssociation: vi.fn(async () => ({
        cubeId: 'cube-1',
        name: 'myrepo',
        workingRepoName: 'myrepo',
        template: 'software-dev',
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [],
      })),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('`borg assimilate --host https://localhost:8787 <role>`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound recovery command when local MCP setup fails', async () => {
    const stderr = vi.fn();
    mcpConfigMocks.ensureCliMcpConfigured.mockImplementationOnce(() => {
      throw new Error('opencode CLI not found');
    });
    const deps = makeStubDeps({
      stderr,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cli: 'opencode' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain(
      '`borg assimilate --host https://localhost:8787 --cli opencode`',
    );
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound fresh-worktree command when a local seat was evicted', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-1',
        droneId: 'drone-prior',
        droneLabel: 'builder-1',
        name: 'myrepo',
        roleName: 'Builder',
        apiUrl: 'https://localhost:8787',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
        localSessionGeneration: 1,
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
      assimilate: vi.fn(async () => {
        throw new DroneEvictedError('evicted');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, here: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('from a fresh worktree');
    expect(output).toContain('`borg assimilate --host https://localhost:8787`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('reads an explicitly requested enrollment invitation through the hidden-input seam', async () => {
    const invitation = TEST_ARTIFACT;
    const prompt = vi.fn(async () => 'must-not-prompt');
    const promptSecret = vi.fn(async () => invitation);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
      serverCapabilities: ['create_cube'],
    }));
    const deps = makeStubDeps({ prompt, promptSecret, connectServer });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(0);

    expect(promptSecret).toHaveBeenCalledWith(
      'Enrollment invitation (single-use; hidden input):',
    );
    expect(connectServer).toHaveBeenCalledWith(
      'https://localhost:8787',
      { invitation, artifact: expect.any(Object), confirmReplacement: expect.any(Function) },
    );
    const confirmReplacement = connectServer.mock.calls[0][1].confirmReplacement;
    prompt.mockResolvedValueOnce('');
    await expect(confirmReplacement?.()).resolves.toBe(false);
    prompt.mockResolvedValueOnce('yes');
    await expect(confirmReplacement?.()).resolves.toBe(true);
    expect(deps.stderr).toHaveBeenCalledWith(
      'Owner client enrolled with `https://localhost:8787`. ' +
        'Creating or joining this repository’s cube next.\n',
    );
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('rejects an explicit-host artifact contradiction before private state, trust, credentials, or network', async () => {
    const stderr = vi.fn();
    const preparePrivateRoot = vi.fn(async () => {});
    const getActiveCube = vi.fn(async () => null);
    const hasPersistedActiveCube = vi.fn(async () => false);
    const resumeServerEnrollment = vi.fn(async () => null);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const promptSecret = vi.fn(async () => artifactForEndpoint('https://server.example.com'));
    const peekPendingServerEnrollment = vi.fn(async () => null);
    const deps = makeStubDeps({
      stderr,
      preparePrivateRoot,
      getActiveCube,
      hasPersistedActiveCube,
      resumeServerEnrollment,
      connectServer,
      promptSecret,
      peekPendingServerEnrollment,
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(1);

    expect(stderr.mock.calls.flat().join('')).toContain(
      'does not match the selected `--host`',
    );
    expect(promptSecret).toHaveBeenCalledTimes(1);
    expect(peekPendingServerEnrollment).not.toHaveBeenCalled();
    expect(preparePrivateRoot).not.toHaveBeenCalled();
    expect(getActiveCube).not.toHaveBeenCalled();
    expect(hasPersistedActiveCube).not.toHaveBeenCalled();
    expect(resumeServerEnrollment).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
  });

  it('gives an ordinary enrolled client a distinct next step without owner wording', async () => {
    const invitation = TEST_ARTIFACT;
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      promptSecret: vi.fn(async () => invitation),
      connectServer: vi.fn(async () => ({
        token: 'ordinary-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
        serverCapabilities: [],
      })),
      createCube: vi.fn(async () => {
        throw new BorgServerError(
          'CREATE_CUBE_DENIED',
          'This Borg server client is not authorized to create cubes',
        );
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(
      'Ordinary client enrolled with `https://localhost:8787`. ' +
        'Checking for an accessible repository cube next.',
    );
    expect(output).toContain(
      'This enrolled client cannot create a cube on https://localhost:8787.',
    );
    expect(output).not.toContain('Owner client enrolled');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('validates the explicit-host invitation before resuming a durable pending enrollment', async () => {
    const promptSecret = vi.fn(async () => TEST_ARTIFACT);
    const connectServer = vi.fn(async () => {
      throw new Error('must not start a new enrollment');
    });
    const resumeServerEnrollment = vi.fn(async (_apiUrl: string, onPending?: () => void) => {
      onPending?.();
      return {
        token: 'resumed-server-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
        serverCapabilities: ['create_cube'],
      };
    });
    const deps = makeStubDeps({
      promptSecret,
      connectServer,
      resumeServerEnrollment,
      peekPendingServerEnrollment: vi.fn(async () => ({
        origin: 'https://localhost:8787',
        invitation: TEST_ARTIFACT,
      })),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(0);

    expect(resumeServerEnrollment).toHaveBeenCalledWith(
      'https://localhost:8787',
      expect.any(Function),
    );
    expect(promptSecret).toHaveBeenCalledWith('Enrollment invitation (single-use; hidden input):');
    expect(connectServer).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      'Resuming the pending enrollment for `https://localhost:8787`; do not enter another invitation unless the server certificate was reissued; if it was, request a current invitation and rerun this command.\n',
    );
    expect(deps.createCube).toHaveBeenCalledWith(
      'https://localhost:8787',
      'resumed-server-token',
      expect.objectContaining({ name: 'myrepo', template: 'software-dev' }),
      SERVER_TRUST_IDENTITY,
    );
  });

  it('refuses enrollment without a TTY before reading or sending a secret', async () => {
    const stderr = vi.fn();
    const promptSecret = vi.fn(async () => 'i'.repeat(43));
    const resumeServerEnrollment = vi.fn(async () => null);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      stderr,
      promptSecret,
      connectServer,
      resumeServerEnrollment,
      isTTY: () => false,
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true },
    }, deps)).toBe(1);

    expect(promptSecret).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(resumeServerEnrollment).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Local enrollment requires an interactive operator terminal. ' +
        'Re-run `borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
  });

  it('fails closed when an explicit server cannot connect', async () => {
    const stderr = vi.fn();
    const listCubes = vi.fn(async () => []);
    const deps = makeStubDeps({
      stderr,
      listCubes,
      connectServer: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'server.example.com' } }, deps)).toBe(1);

    expect(listCubes).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Could not reach Borg server at https://server.example.com. ' +
        'Start or restart it with `borg-mcp-server start`, then rerun ' +
        '`borg assimilate --host https://server.example.com`.\n',
    );
  });

  it('uses dedicated recovery copy while another Borg process owns the local seat store', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('Borg private store is busy');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      "Borg's private store is busy for https://localhost:8787 because another Borg process is " +
        'creating or resuming saved connection state. Wait for it to finish, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
    // RQ: a transient store-busy lock exhaustion must render the RETRY copy — never
    // the misleading version-compatibility fall-through.
    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(output).not.toMatch(/versions? (?:are|is) compatible|version compatibility/i);
    expect(output).not.toMatch(/unexpected response/i);
  });

  it('renders fail-closed stale-lock guidance (dead holder) naming the lockfile path — never busy/retry', async () => {
    const stderr = vi.fn();
    const lockPath = '/home/op/.config/borgmcp/seats.json.lock';
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        // RULED option (b): a lock whose recorded holder is DEAD fails closed with a
        // message naming the exact lockfile path and the delete-only-if-no-borg copy.
        throw new Error(
          `Borg private store lock file ${lockPath} is stale: its recorded owner process ` +
            '(pid 1073741824, started 2020-01-01T00:00:00.000Z) is no longer running. ' +
            'Borg will NOT remove it automatically. If no borg process is running on this ' +
            `machine, delete ${lockPath} and retry; otherwise wait for the other borg process to finish.`,
        );
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((c) => String(c[0])).join('');
    // The operator sees the exact lockfile path and the fail-closed 'stale' guidance…
    expect(output).toContain(lockPath);
    expect(output).toMatch(/stale/i);
    expect(output).toMatch(/delete .*seats\.json\.lock/i);
    // …never the transient busy/retry copy, and never the version fall-through.
    expect(output).not.toMatch(/is busy for .*because another Borg process/i);
    expect(output).not.toMatch(/versions? (?:are|is) compatible|unexpected response/i);
  });

  it('distinguishes an unavailable local seat store from trust, auth, and connectivity failures', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('local private store is not accessible');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Borg could not access its private store for https://localhost:8787. ' +
        'Ensure its directory on this machine is readable and writable, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
  });

  it('uses identity recovery only for Borg server trust failures', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('Borg server CA certificate does not match its pinned identity');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Borg could not verify the expected server identity for https://localhost:8787. ' +
        'Verify that this is the expected server. If it was re-initialized, ask the server ' +
        'operator to restore the expected identity. For a local server on this machine, use ' +
        '`borg server setup` and `borg server start`, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
  });

  it('gives a distinct local-wrapper recovery when this machine has no server trust material', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('Borg server trust files were not found');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'This machine has no trust material for Borg server https://localhost:8787. ' +
        'For a local server on this machine, run `borg server setup`, then run ' +
        '`borg server start`, and rerun `borg assimilate --host https://localhost:8787`. ' +
        'A server on another machine requires a supported trust-bootstrap step before enrollment; ' +
        'an invitation alone cannot establish server identity.\n',
    );
    expect(stderr.mock.calls.flat().join('')).not.toContain('borg-mcp-server');
  });

  it('tells an enrolled ordinary client to request a grant or join an accessible cube', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      createCube: vi.fn(async () => {
        throw new BorgServerError(
          'CREATE_CUBE_DENIED',
          'This Borg server client is not authorized to create cubes',
        );
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'This enrolled client cannot create a cube on https://localhost:8787. ' +
        'Ask the server operator to grant access to a cube, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).not.toMatch(/invitation|connectivity|borgmcp\.ai/i);
  });

  it('uses an ordinary client repository association without listing by name or prompting', async () => {
    const prompt = vi.fn();
    const listCubes = vi.fn();
    const deps = makeStubDeps({
      prompt,
      listCubes,
      connectServer: vi.fn(async () => ({
        token: 'ordinary-token', trustIdentity: SERVER_TRUST_IDENTITY, serverCapabilities: [],
      })),
      getRepositoryAssociation: vi.fn(async () => ({
        cubeId: 'cube-associated', name: 'associated', workingRepoName: 'myrepo', template: 'starter',
      })),
      getCube: vi.fn(async () => ({
        id: 'cube-associated', name: 'associated',
        roles: [{ id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false }],
      })),
    });

    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).resolves.toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(listCubes).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'borg assimilate', mode: undefined },
    { label: 'borg server cube init', mode: 'cube-init' as const },
  ])('does not associate unassociated repo B with active repo A through $label', async ({ mode }) => {
    const repositoryB = { kind: 'origin' as const, value: 'https://github.com/org/repo-b' };
    const getRepositoryAssociation = vi.fn(async () => null);
    const saveRepositoryAssociation = vi.fn();
    const getCube = vi.fn();
    const createCube = vi.fn(async () => {
      throw new BorgServerError('CREATE_CUBE_DENIED', 'stop after repository resolution');
    });
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-a',
        droneId: 'drone-a',
        name: 'repo-a',
        droneLabel: 'builder-a',
        apiUrl: 'https://localhost:8787',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
        roleName: 'Drone',
      })),
      resolveRepositoryContext: vi.fn(async () => ({
        root: '/work/repo-b',
        commonDir: '/work/repo-b/.git',
        derivedName: 'repo-b',
        publicRepository: repositoryB,
        publicRepositoryName: 'org/repo-b',
      })),
      getRepositoryIdentity: vi.fn(async () => repositoryB),
      getRepositoryAssociation,
      saveRepositoryAssociation,
      getCube,
      createCube,
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true },
      ...(mode ? { mode } : {}),
    }, deps)).resolves.toBe(1);

    expect(getRepositoryAssociation).toHaveBeenCalledWith(SERVER_TRUST_IDENTITY, repositoryB);
    expect(createCube).toHaveBeenCalledWith(
      'https://localhost:8787',
      'server-token',
      expect.objectContaining({ repository: repositoryB, name: 'repo-b' }),
      SERVER_TRUST_IDENTITY,
    );
    expect(getCube).not.toHaveBeenCalled();
    expect(saveRepositoryAssociation).not.toHaveBeenCalled();
  });

  it('fails closed when an ordinary client has ambiguous same-name grants', async () => {
    const assimilate = vi.fn();
    const deps = makeStubDeps({
      assimilate: assimilate as any,
      connectServer: vi.fn(async () => ({
        token: 'ordinary-token', trustIdentity: SERVER_TRUST_IDENTITY, serverCapabilities: [],
      })),
      listCubes: vi.fn(async () => [
        { id: 'cube-a', name: 'myrepo' },
        { id: 'cube-b', name: 'myrepo' },
      ]),
    });

    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787', yes: true } }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('More than one accessible cube'));
    expect(assimilate).not.toHaveBeenCalled();
  });

  it('does not claim nothing changed or ambiguous when association persistence fails after creation', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      saveRepositoryAssociation: vi.fn(async () => { throw new Error('disk full'); }),
    });

    await expect(runAssimilate({ role: undefined, flags: { yes: true } }, deps)).resolves.toBe(1);
    const output = stderr.mock.calls.map(([text]) => String(text)).join('');
    expect(output).toContain('The repository cube was confirmed');
    expect(output).toContain('No drone was created');
    expect(output).not.toContain('may already exist');
    expect(output).not.toContain('Nothing was changed');
    expect(deps.assimilate).not.toHaveBeenCalled();
  });

  it('redacts token-shaped and terminal-control data from generic server failures', async () => {
    const stderr = vi.fn();
    const secret = 's'.repeat(43);
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error(`request failed for ${secret}\u001b[2J`);
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('\u001b');
  });

  it('does not mistake an endpoint mismatch for a missing enrollment', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new BorgServerError('NOT_ENROLLED', 'not enrolled');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Borg could not find a saved enrollment for https://localhost:8787. ' +
        'This can mean that this client has not enrolled with the server, or that its enrollment ' +
        'is saved for a different endpoint. Confirm that the host, port, and IPv4 or IPv6 ' +
        'loopback form in https://localhost:8787 match the endpoint used during enrollment. ' +
        'If this client has never enrolled with that server, run ' +
        '`borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
  });

  it('distinguishes a rejected saved enrollment without exposing a credential', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new BorgServerError('CREDENTIAL_REJECTED', 'credential rejected');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'The saved enrollment for https://server.example.com was rejected. Re-run ' +
        '`borg assimilate --host https://server.example.com --enroll` from the operator’s terminal.\n',
    );
  });

  it('surfaces a pin-matched SESSION_REJECTED as the exact superseded diagnosis', async () => {
    const stderr = vi.fn();
    const connectServer = vi.fn(async () => {
      throw new BorgServerError('SESSION_REJECTED', 'session bearer no longer accepted');
    });
    const deps = makeStubDeps({ stderr, connectServer });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Local session was superseded by a newer enrollment.\n' +
        'Next: run borg reset-local-connection, then borg assimilate --host https://server.example.com --enroll.\n',
    );
  });

  it('explains how the operator replaces a rejected enrollment invitation', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      promptSecret: vi.fn(async () => TEST_ARTIFACT),
      connectServer: vi.fn(async () => {
        throw new BorgServerError('INVITATION_REJECTED', 'invitation rejected');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('replacement invitation');
    expect(output).toContain('`borg-mcp-server owner-invite`');
    expect(output).toContain('`borg-mcp-server client-invite`');
    expect(output).toContain(
      '`borg assimilate --host https://localhost:8787 --enroll`',
    );
    // Live-safe: the server stays running — never tell the operator to stop/restart it.
    expect(output).toContain('server can stay running');
    expect(output).not.toMatch(/stop the server|restart it/i);
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it.each([
    ['no saved enrollment', new BorgServerError('NOT_ENROLLED', 'not enrolled')],
    ['saved credential rejected', new BorgServerError('CREDENTIAL_REJECTED', 'credential rejected')],
    ['session revoked', new BorgServerError('SESSION_REVOKED', 'session revoked')],
    ['session rejected takeover', new BorgServerError('SESSION_REJECTED', 'session rejected')],
    ['private store busy', new Error('Borg private store is busy')],
    ['private store unavailable', new Error('local private store is not accessible')],
    ['trust mismatch', new Error('Borg server CA certificate does not match its pinned identity')],
    ['server unreachable', new Error('connect ECONNREFUSED')],
    ['unexpected protocol', new Error('protocol response shape changed')],
  ])('keeps the %s recovery local, endpoint-specific, and actionable', async (_label, failure) => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => { throw failure; }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toMatch(/borg assimilate --host https:\/\/localhost:8787|borg-mcp-server start/);
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('offers a detected local server before the general authority choice', async () => {
    const prompt = vi.fn(async () => '');
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      detectLocalServer: vi.fn(async () => 'localhost:8787'),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {} }, deps)).toBe(0);

    expect(prompt).toHaveBeenCalledTimes(4); // authority, name, template, confirmation
    expect(String(prompt.mock.calls[0][0])).toContain('Local Borg server detected');
    expect(connectServer).toHaveBeenCalledWith('https://localhost:8787');
    expect(deps.promptSecret).not.toHaveBeenCalled();
    expect(deps.createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        template: 'software-dev',
        workingRepoName: 'myrepo',
        repository: { kind: 'origin', value: 'https://github.com/org/myrepo' },
      }),
      SERVER_TRUST_IDENTITY,
    );
  });

  it.each([
    ['assimilate', undefined, 'borg assimilate'],
    ['cube init', 'cube-init' as const, 'borg server cube init'],
  ])('explains a missing default server before the %s host prompt', async (_label, mode, rerunCommand) => {
    const expectedPrompt =
      'No running Borg server was found at https://127.0.0.1:7091 (the default).\n' +
      '- If your server runs on another host or port, enter it below (e.g. 127.0.0.1:7091 or https://server.local:7091; bare hosts default to HTTPS).\n' +
      `- If your server is installed but stopped, run \`borg server start\`, then rerun \`${rerunCommand}\`.\n` +
      '- If you do not have a server yet, cancel (Ctrl-C) and run `borg server setup`.\n' +
      'Borg server host or URL: ';
    const prompt = vi.fn(async (message: string) => {
      if (message === expectedPrompt) return 'server.example.com';
      if (message.startsWith('Cube name')) return '';
      if (message.startsWith('Template')) return '1';
      if (message.startsWith('Create cube')) return 'y';
      return '1';
    });
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      detectLocalServer: vi.fn(async () => null),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {}, ...(mode ? { mode } : {}) }, deps)).toBe(0);

    expect(prompt.mock.calls[0][0]).toBe(expectedPrompt);
    expect(connectServer).toHaveBeenCalledWith('https://server.example.com');
  });

  it.each([
    ['assimilate', undefined],
    ['cube init', 'cube-init' as const],
  ])('adds input context after the operator declines a detected server in %s mode', async (_label, mode) => {
    const detectedPrompt =
      'Local Borg server detected at https://localhost:8787.\nConnect this project to it? [Y/n]: ';
    const alternatePrompt =
      'Enter another Borg server host or URL (e.g. 127.0.0.1:7091 or https://server.local:7091; bare hosts default to HTTPS).\n' +
      'Borg server host or URL: ';
    const prompt = vi.fn(async (message: string) => {
      if (message === detectedPrompt) return 'n';
      if (message === alternatePrompt) return 'server.example.com';
      if (message.startsWith('Cube name')) return '';
      if (message.startsWith('Template')) return '1';
      if (message.startsWith('Create cube')) return 'y';
      return '1';
    });
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      detectLocalServer: vi.fn(async () => 'localhost:8787'),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {}, ...(mode ? { mode } : {}) }, deps)).toBe(0);

    expect(prompt.mock.calls[0][0]).toBe(detectedPrompt);
    expect(prompt.mock.calls[1][0]).toBe(alternatePrompt);
    expect(connectServer).toHaveBeenCalledWith('https://server.example.com');
  });

  it('rejects an unsafe explicit endpoint before network access', async () => {
    const stderr = vi.fn();
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({ stderr, connectServer });

    expect(await runAssimilate({ role: undefined, flags: { server: 'http://server.example.com' } }, deps)).toBe(1);

    expect(connectServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must use https://'));
  });

  it('fails closed on a selected server auth error from the first API call', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => ({
        token: 'local-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
      })),
      createCube: vi.fn(async () => {
        throw new BorgServerError('CREDENTIAL_REJECTED', 'invalid server credential');
      }),
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'The saved enrollment for https://localhost:8787 was rejected. Re-run ' +
        '`borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
  });

  it('non-TTY --yes --enroll without --host/--server remains fail-closed with zero server calls', async () => {
    const stderr = vi.fn();
    const connectServer = vi.fn();
    const listCubes = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer,
      listCubes,
      defaultAuthority: undefined,
      isTTY: () => false,
    });

    expect(await runAssimilate({ role: undefined, flags: { yes: true, enroll: true } }, deps)).toBe(1);

    expect(connectServer).not.toHaveBeenCalled();
    expect(listCubes).not.toHaveBeenCalled();
    expect(deps.ensureLocalServerInstalled).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Local enrollment requires an interactive operator terminal. ' +
        'Re-run `borg assimilate --enroll` from the operator’s terminal.\n',
    );
  });

  it('uses only the selected local server authority', async () => {
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const createCube = vi.fn(async () => ({
      id: 'cube-1', name: 'myrepo',
      roles: [{ id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false }],
    }));
    const detectLocalServer = vi.fn(async () => 'https://localhost:8787');
    const answers = ['Y', '', '', ''];
    const prompt = vi.fn(async () => answers.shift() ?? '');
    const stderr = vi.fn();
    const deps = makeStubDeps({
      connectServer,
      createCube,
      detectLocalServer,
      prompt,
      stderr,
      isTTY: () => true,
      defaultAuthority: undefined,
    });

    await runAssimilate(
      { role: undefined, flags: {} },
      deps,
    );

    expect(detectLocalServer).toHaveBeenCalled();
    expect(connectServer).toHaveBeenCalled();
    expect(createCube).toHaveBeenCalled();
  });
});

describe('runAssimilate: local saved-seat idempotency', () => {
  const localActive = (overrides: Partial<ActiveCube> = {}): ActiveCube => ({
    cubeId: 'cube-1',
    droneId: 'drone-saved',
    name: 'myrepo',
    sessionToken: 'saved-local-session',
    droneLabel: 'one-of-one-drone',
    apiUrl: 'https://localhost:8787',
    serverTrustIdentity: SERVER_TRUST_IDENTITY,
    localSessionCredentialRef: 'borg-server-session:' + 'b'.repeat(64),
    roleName: 'Drone',
    roleClass: 'worker',
    isHumanSeat: false,
    ...overrides,
  });

  const localCube = (occupied = false) => ({
    id: 'cube-1',
    name: 'myrepo',
    roles: [
      { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false, role_class: 'worker' as const },
      { id: 'role-other', name: 'Other', is_default: false, is_human_seat: false, role_class: 'worker' as const },
    ],
    drones: occupied ? [{ role_id: 'role-default' }] : [],
  });

  it('reattaches an identical rerun after restart without minting another drone', async () => {
    let active: ActiveCube | null = null;
    let droneCount = 0;
    const getActiveCube = vi.fn(async () => active);
    const finalizeServerSeat = vi.fn(async ({ active: next }: { active: AssimilationActiveCube }) => {
      active = { ...next, sessionToken: 'saved-local-session' };
      return { committed: true as const };
    });
    const probeSeat = vi.fn(async () => 'live' as const);
    const assimilate = vi.fn(async (
      _apiUrl: string,
      _token: string,
      params: { prior_drone_id?: string },
    ) => {
      if (!params.prior_drone_id) droneCount += 1;
      return {
        cube_id: 'cube-1',
        drone_id: 'drone-saved',
        drone_label: 'one-of-one-drone',
        role_id: 'role-default',
        result: (params.prior_drone_id === 'drone-saved' ? 'reused' : 'created') as 'created' | 'reused',
        local_session: {
          credential_ref: 'borg-server-session:' + 'c'.repeat(64),
        },
      };
    });
    const deps = makeStubDeps({
      getActiveCube,
      finalizeServerSeat,
      probeSeat,
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube(active !== null)),
    });
    const createArgs = {
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cubeName: 'myrepo' },
    };
    const resumeArgs = {
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    };

    await expect(runAssimilate(createArgs, deps)).resolves.toBe(0);
    await expect(runAssimilate(resumeArgs, deps)).resolves.toBe(0);

    expect(droneCount).toBe(1);
    expect(assimilate).toHaveBeenCalledTimes(2);
    expect(assimilate.mock.calls[1][2]).toMatchObject({
      cube_id: 'cube-1',
      role_id: 'role-default',
      prior_drone_id: 'drone-saved',
    });
    expect(probeSeat).toHaveBeenCalledWith(expect.objectContaining({
      sessionToken: 'saved-local-session',
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: SERVER_TRUST_IDENTITY,
      droneId: 'drone-saved',
    }));
    expect(active).toMatchObject({ droneId: 'drone-saved' });
  });

  it('remints only after the saved seat is authoritatively evicted', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-replacement',
      drone_label: 'one-of-one-drone',
      role_id: 'role-default',
      reattached: false,
      local_attach_completion: {
        binding: {
          origin: 'https://localhost:8787',
          trustIdentity: SERVER_TRUST_IDENTITY,
          cubeId: 'cube-1',
          roleId: 'role-default',
        },
        operation: {
          projectRoot: '/work/myrepo',
          kind: 'seat' as const,
          operationKey: 'current-worktree',
        },
        retryKey: '55555555-5555-4555-8555-555555555555',
      },
      local_session: {
        credential_ref: 'borg-server-session:' + 'd'.repeat(64),
        generation: 1,
      },
    }));
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => localActive()),
      probeSeat: vi.fn(async () => 'evicted'),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(0);

    expect(assimilate.mock.calls[0][2]).toMatchObject({
      prior_drone_id: 'drone-saved',
      remint_invalid_prior: true,
      role_id: 'role-default',
    });
  });

  it('never mints when saved-seat liveness is ambiguous', async () => {
    const assimilate = vi.fn();
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => localActive()),
      probeSeat: vi.fn(async () => 'indeterminate'),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(1);

    expect(assimilate).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('could not verify'));
  });

  const persistedRawSeat = () => ({
    cubeId: 'cube-1',
    droneId: 'drone-saved',
    name: 'myrepo',
    droneLabel: 'one-of-one-drone',
    apiUrl: 'https://localhost:8787',
    serverTrustIdentity: SERVER_TRUST_IDENTITY,
    localSessionCredentialRef: 'borg-server-session:' + 'b'.repeat(64),
    roleName: 'Drone',
    roleClass: 'worker' as const,
    isHumanSeat: false,
    // CR#2: a resumable record carries its STORED operation + state. A bound-PENDING
    // record resumes with an ABSENT/pending-reuse expectation (re-send the identical
    // bearer) — an EXACT expectation would be rejected by prepareSeat's active-only guard.
    operation: { projectRoot: '/work/myrepo', kind: 'seat' as const, operationKey: 'current-worktree' },
    state: 'pending' as const,
  });

  it('RECORD-ABSENT: binding present but NO session record → truthful local-seat-load error, never a new seat', async () => {
    const assimilate = vi.fn();
    const peekServerSessionRecord = vi.fn(async () => false); // genuine local-seat-load failure
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      hasPersistedActiveCube: vi.fn(async () => true),
      readPersistedLocalSeat: vi.fn(async () => persistedRawSeat()),
      peekServerSessionRecord,
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(1);

    expect(peekServerSessionRecord).toHaveBeenCalled();
    expect(assimilate).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining('local session credential could not be loaded'),
    );
  });

  it('never treats persisted local metadata with a missing local session credential as a new seat', async () => {
    const assimilate = vi.fn();
    // No raw seat readable → cannot resume → truthful error, unchanged.
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      hasPersistedActiveCube: vi.fn(async () => true),
      readPersistedLocalSeat: vi.fn(async () => null),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(1);

    expect(assimilate).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      expect.stringContaining('local session credential could not be loaded'),
    );
  });

  it('CRASH-IN-GAP RESUME: binding present + a resumable PENDING record → resumes (no local-seat-load error), FINALIZE converges with EXACT-ref, exit 0', async () => {
    const REF = 'borg-server-session:' + 'b'.repeat(64);
    const activate = vi.fn(async () => {});
    const scrubPending = vi.fn(async () => {});
    // The re-sent attach resolves the SAME seat (bearer digest is the correlator);
    // the composite FINALIZE flips the pending record to ACTIVE.
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-saved', drone_label: 'one-of-one-drone',
      result: 'reused' as const, role_id: 'role-default',
      local_session: { credential_ref: REF },
      finalize: { activate, scrubPending },
    }));
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      getActiveCube: vi.fn(async () => null),                       // PENDING is non-hydratable
      hasPersistedActiveCube: vi.fn(async () => true),
      readPersistedLocalSeat: vi.fn(async () => persistedRawSeat()),
      peekServerSessionRecord: vi.fn(async () => true),             // resumable record present
      assimilate,
      finalizeServerSeat,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    // A fresh `borg assimilate` — no --here needed.
    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cubeName: 'myrepo' },
    }, deps)).toBe(0);

    // NOT misdiagnosed as a local-seat-load failure.
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toMatch(/local session credential could not be loaded/);
    // The identical seat is re-sent (resume), not a fresh mint.
    expect(assimilate).toHaveBeenCalled();
    // CR#2: a bound-PENDING resume declares ABSENT (pending-reuse) — prepareSeat REUSES
    // the pending record and re-sends the identical bearer. An EXACT expectation would
    // be rejected by prepareSeat's `prior.state==='active'` guard and abort convergence.
    expect(finalizeServerSeat).toHaveBeenCalledTimes(1);
    expect(finalizeServerSeat.mock.calls[0][0].expected).toEqual({ kind: 'absent' });
    expect(finalizeServerSeat.mock.calls[0][0].active).toMatchObject({ cubeId: 'cube-1', localSessionCredentialRef: REF });
  });

  it('CR#2: a bound-PENDING SIBLING resume OVERRIDES session_operation from the stored record and declares ABSENT (re-derives the exact original ref)', async () => {
    const REF = 'borg-server-session:' + 'b'.repeat(64);
    // The stored record is a sibling whose activation failed, bound to THIS worktree.
    // Its operation is the ORIGINAL sibling op (projectRoot = the source repo), NOT
    // this worktree's derived current-worktree seat op.
    const siblingOperation = { projectRoot: '/work/original', kind: 'sibling' as const, operationKey: 'implicit-sibling:run-1' };
    const boundPendingSibling = () => ({
      cubeId: 'cube-1', name: 'myrepo', droneLabel: 'one-of-one-drone',
      apiUrl: 'https://localhost:8787', serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: REF, roleName: 'Drone', roleClass: 'worker' as const, isHumanSeat: false,
      operation: siblingOperation, state: 'pending' as const,
    });
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-saved', drone_label: 'one-of-one-drone',
      result: 'reused' as const, role_id: 'role-default',
      local_session: { credential_ref: REF },
      finalize: { activate: vi.fn(async () => {}), scrubPending: vi.fn(async () => {}) },
    }));
    const finalizeServerSeat = vi.fn(async () => ({ committed: true as const }));
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      hasPersistedActiveCube: vi.fn(async () => true),
      readPersistedLocalSeat: vi.fn(async () => boundPendingSibling()),
      peekServerSessionRecord: vi.fn(async () => true),
      assimilate,
      finalizeServerSeat,
      cwd: () => '/work/myrepo', findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cubeName: 'myrepo' },
    }, deps)).toBe(0);

    // The rerun re-derives the EXACT original sibling operation from the stored
    // record (override) — NOT this worktree's current-worktree seat op.
    const params = assimilate.mock.calls[0][2] as { session_operation?: unknown; session_expected?: unknown };
    expect(params.session_operation).toEqual(siblingOperation);
    // A PENDING record resumes with ABSENT/pending-reuse (never EXACT).
    expect(params.session_expected).toEqual({ kind: 'absent' });
    expect(finalizeServerSeat.mock.calls[0][0].expected).toEqual({ kind: 'absent' });
  });

});

// Phase G Task 19 — fills coverage gap on spec scenarios 5 + 12.
// Other 10 scenarios already covered by the Phase E tests; see the
// REVIEW-READY post for the full mapping.
describe('runAssimilate: integration scenario 5 (--worktree force-create)', () => {
  it('--worktree <name> force-creates a sibling even when no cubes.json collision', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // gh#864: no lingering per-worktree branch → localBranchExists false → -b path.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync: runSyncSpy, chdir,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => null), // NO cubes.json collision
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({
      role: undefined,
      flags: { yes: true, server: 'localhost:8787', worktree: 'review-1' },
    }, deps);
    // --worktree forces sibling spawn regardless of collision state.
    // gh#556 Part 1: NEW worktree at ~/.borg/worktrees/<repo>/<name> (homedir stub = /home/test).
    // gh#33: named per-worktree branch (wt-<suffix>) UNAFFECTED, NOT detached HEAD.
    expect(runSyncSpy).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-review-1', '/home/test/.borg/worktrees/myrepo/review-1', 'origin/main'], expect.any(String));
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1');
    expect(deps.assimilate).toHaveBeenCalledWith(
      'https://localhost:8787',
      'server-token',
      expect.objectContaining({
        session_operation: {
          projectRoot: '/work/myrepo',
          kind: 'sibling',
          operationKey: 'named-sibling:review-1',
        },
      }),
      SERVER_TRUST_IDENTITY,
    );
  });
});

// gh#864 — `git worktree add -b` hard-fails on a lingering wt-<suffix> branch
// whose old worktree was pruned. Adopt a MERGED lingering branch; bump the
// suffix past an UNMERGED one (never reuse/clobber un-merged work).
describe('runAssimilate: gh#864 worktree branch-collision dedup', () => {
  const baseDeps = (runSync: any) => makeStubDeps({
    runSync,
    chdir: vi.fn(),
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    getActiveCube: vi.fn(async () => null),
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  });

  it('adopts a lingering MERGED wt-<suffix> branch (no -b, SAME suffix)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // wt-review-1 already exists (lingering)...
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 0, stdout: 'abc123\n', stderr: '' };
      // ...and is fully merged into origin/main → adoptable.
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps);
    // Adopt form: `git worktree add <path> wt-review-1` — no -b, no startRef, SAME suffix.
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '/home/test/.borg/worktrees/myrepo/review-1', 'wt-review-1'], expect.any(String));
    expect(deps.chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1');
    // The failing -b create on the colliding branch is NEVER attempted.
    const dashBcreates = runSync.mock.calls.filter(
      (c: any[]) => c[1][0] === 'worktree' && c[1][1] === 'add' && c[1][2] === '-b'
    );
    expect(dashBcreates).toHaveLength(0);
  });

  it('bumps the suffix past a lingering UNMERGED wt-<suffix> branch (-b on the fresh suffix)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // wt-review-1 exists; the bumped wt-review-1-2 does not.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return args[3] === 'refs/heads/wt-review-1'
          ? { status: 0, stdout: 'abc123\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      // wt-review-1 carries commits NOT on origin/main → unmerged → must not reuse.
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps);
    // Bumped to review-1-2, freshly created at startRef with -b (its ref is absent).
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-review-1-2', '/home/test/.borg/worktrees/myrepo/review-1-2', 'origin/main'], expect.any(String));
    expect(deps.chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1-2');
    // The unmerged wt-review-1 is never adopted (no add of that path/branch).
    const adoptReview1 = runSync.mock.calls.filter(
      (c: any[]) => c[1][0] === 'worktree' && c[1][1] === 'add' && c[1][2] === '/home/test/.borg/worktrees/myrepo/review-1'
    );
    expect(adoptReview1).toHaveLength(0);
  });

  it('retries with a unique name when another process claims the branch during creation', async () => {
    let raced = false;
    const stderr = vi.fn();
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') {
        return raced
          ? { status: 0, stdout: 'worktree /work/myrepo\nbranch refs/heads/main\n\nworktree /legacy/slot\nbranch refs/heads/wt-review-1\n', stderr: '' }
          : { status: 0, stdout: 'worktree /work/myrepo\nbranch refs/heads/main\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        if (!raced) {
          raced = true;
          return { status: 128, stdout: '', stderr: "fatal: a branch named 'wt-review-1' already exists" };
        }
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return raced && args[3] === 'refs/heads/wt-review-1'
          ? { status: 0, stdout: 'abc123\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    deps.stderr = stderr;

    await expect(runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps)).resolves.toBe(0);

    expect(runSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'wt-review-1-2', '/home/test/.borg/worktrees/myrepo/review-1-2', 'origin/main'],
      '/work/myrepo',
    );
    expect(stderr.mock.calls.map((call) => String(call[0])).join('')).not.toContain('Borg could not create sibling worktree');
  });

  it('terminates when git creates the branch before a residual worktree failure', async () => {
    let failedBranch: string | null = null;
    let addCalls = 0;
    const stderr = vi.fn();
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: 'worktree /work/myrepo\nbranch refs/heads/main\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        addCalls++;
        if (addCalls > 1) throw new Error('residual failure was incorrectly retried');
        failedBranch = String(args[3]);
        return { status: 128, stdout: '', stderr: 'fatal: could not create leading directories: Permission denied' };
      }
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return args[3] === `refs/heads/${failedBranch}`
          ? { status: 0, stdout: 'abc123\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    deps.stderr = stderr;

    await expect(runAssimilate({ role: undefined, flags: { yes: true, worktree: 'residual' } }, deps)).resolves.toBe(1);

    expect(addCalls).toBe(1);
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Permission denied');
    expect(output).toContain('Git left branch wt-residual without a registered worktree; Borg preserved it.');
    expect(output).toContain(
      'A local drone reservation was created and remains pending; rerunning after fixing the worktree issue resumes that reservation.',
    );
    expect(output).not.toContain('resumes that seat');
  });
});

// Helper: runSync stub that returns a git remote URL so cube name = 'myrepo'.
const gitRemoteRunSync = vi.fn((_cmd: string, args: string[]) =>
  args[0] === 'remote'
    ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
    : { status: 0, stdout: '', stderr: '' }
);

describe('runAssimilate: temporary Claude model compatibility', () => {
  const successDeps = (overrides: Partial<AssimilateDeps> = {}) =>
    makeStubDeps({
      exec: vi.fn(async () => 0),
      assimilate: vi.fn(async () => ({
        cube_id: 'cube-1',
        drone_id: 'drone-x',
        drone_label: 'drone-1',
        result: 'created' as const,
        local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) },
        role_id: 'role-builder',
      })),
      runSync: gitRemoteRunSync,
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-builder', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      ...overrides,
    });

  it('prepares and persists a drone without terminal handoff for quickstart composition', async () => {
    const exec = vi.fn(async () => 0);
    const onPrepared = vi.fn();
    const deps = successDeps({ exec });

    expect(await runAssimilate(
      { role: 'builder', flags: { yes: true } },
      deps,
      { launch: false, onPrepared },
    )).toBe(0);

    expect(exec).not.toHaveBeenCalled();
    expect(deps.probeMcpReady).not.toHaveBeenCalled();
    expect(deps.installProjectSessionHook).toHaveBeenCalled();
    expect(onPrepared).toHaveBeenCalledWith(expect.objectContaining({
      cubeId: 'cube-1',
      droneId: 'drone-x',
      roleName: 'Builder',
    }));
  });

  it('forwards an explicit Claude descriptor and sets only ANTHROPIC_MODEL', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      result: 'created' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) },
      role_id: 'role-builder',
    }));
    const exec = vi.fn(async () => 0);
    const deps = successDeps({ assimilate, exec });

    expect(await runAssimilate(
      { role: 'builder', flags: { model: 'claude:claude-opus-4-8', yes: true } },
      deps
    )).toBe(0);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        model: 'claude:claude-opus-4-8',
        agent_kind: 'claude',
        working_repo: expect.any(Object),
      }),
      expect.any(String),
    );
    const [, , , envArg] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
    expect(envArg.ANTHROPIC_MODEL).toBe('claude-opus-4-8');
    expect(envArg).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(envArg).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('does not inherit a role default model when no flag is provided', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      result: 'created' as const,
      local_session: { credential_ref: 'borg-server-session:' + 'a'.repeat(64) },
      role_id: 'role-builder',
    }));
    const deps = successDeps({
      assimilate,
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{
          id: 'role-builder',
          name: 'Builder',
          is_default: true,
          is_human_seat: false,
          default_model: 'claude:configured-elsewhere',
        }],
      })),
    });

    expect(await runAssimilate({ role: 'builder', flags: { yes: true } }, deps)).toBe(0);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: null }),
      expect.any(String),
    );
  });

  it('leaves provider-specific environment variables untouched without a Borg override', async () => {
    const exec = vi.fn(async () => 0);
    const deps = successDeps({ exec });
    const priorBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_BASE_URL = 'http://agent-cli.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'agent-cli-owned';
    try {
      expect(await runAssimilate({ role: 'builder', flags: { yes: true } }, deps)).toBe(0);
      const [, , , envArg] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
      expect(envArg.ANTHROPIC_BASE_URL).toBe('http://agent-cli.example');
      expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe('agent-cli-owned');
    } finally {
      if (priorBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = priorBaseUrl;
      if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    }
  });
});
