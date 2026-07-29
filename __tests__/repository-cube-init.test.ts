import { describe, expect, it, vi } from 'vitest';
import {
  initializeRepositoryCube,
  PromptInterruptedError,
  type RepositoryCubeInitDeps,
} from '../src/repository-cube-init.js';
import { NEW_CUBE_TEMPLATE_PRESENTATIONS } from 'borgmcp-shared/templates';
import type { GitRepositoryContext } from '../src/repository-identity.js';

const context: GitRepositoryContext = {
  root: '/repo',
  commonDir: '/repo/.git',
  derivedName: 'repo',
  publicRepository: { kind: 'origin', value: 'https://github.com/org/repo' },
  publicRepositoryName: 'org/repo',
};

function deps(overrides: Partial<RepositoryCubeInitDeps> = {}): RepositoryCubeInitDeps {
  const repository = context.publicRepository!;
  let resolved: Awaited<ReturnType<RepositoryCubeInitDeps['resolveAssociation']>> = { result: 'none' };
  const defaultCreate: RepositoryCubeInitDeps['createCube'] = async (input) => ({
    response: {
      result: 'created',
      cube_id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: input.name,
      working_repo_name: input.workingRepoName,
      repository: input.repository,
      template: input.template,
      human_seat_role_id: '8c02328a-59f0-472e-b071-f7417405528f',
      default_worker_role_id: 'b567bf44-f28c-44d2-8927-c67746603029',
      access: 'manage',
    },
    cube: {
      id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: input.name,
      roles: [
        { id: '8c02328a-59f0-472e-b071-f7417405528f', is_human_seat: true },
        { id: 'b567bf44-f28c-44d2-8927-c67746603029', is_default: true },
      ],
    },
  });
  const createImpl = overrides.createCube ?? defaultCreate;
  const associateImpl = overrides.associateCube ?? (async (input) => ({
    result: 'resolved' as const,
    cube_id: input.cubeId,
    name: context.derivedName,
    working_repo_name: input.workingRepoName,
    repository: input.repository,
    template: 'default' as const,
    human_seat_role_id: '8c02328a-59f0-472e-b071-f7417405528f',
    default_worker_role_id: 'b567bf44-f28c-44d2-8927-c67746603029',
    access: 'manage' as const,
  }));
  const result: RepositoryCubeInitDeps = {
    isTTY: () => true,
    prompt: vi.fn(async () => ''),
    write: vi.fn(),
    getIdentity: vi.fn(async () => repository),
    getAssociation: vi.fn(async () => null),
    saveAssociation: vi.fn(async () => {}),
    resolveAssociation: overrides.resolveAssociation ?? vi.fn(async () => resolved),
    listCubes: vi.fn(async () => []),
    associateCube: vi.fn(async (input) => {
      const response = await associateImpl(input);
      resolved = response;
      return response;
    }),
    getCube: vi.fn(async (id) => ({
      id,
      name: 'repo',
      roles: [
        { id: '8c02328a-59f0-472e-b071-f7417405528f', is_human_seat: true },
        { id: 'b567bf44-f28c-44d2-8927-c67746603029', is_default: true },
      ],
    })),
    createCube: vi.fn(async (input) => {
      const creation = await createImpl(input);
      resolved = { ...creation.response, result: 'resolved' };
      return creation;
    }),
    ...overrides,
  };
  if (overrides.resolveAssociation === undefined) result.resolveAssociation = vi.fn(async () => resolved);
  result.associateCube = vi.fn(async (input) => {
    const response = await associateImpl(input);
    resolved = response;
    return response;
  });
  result.createCube = vi.fn(async (input) => {
    const creation = await createImpl(input);
    resolved = { ...creation.response, result: 'resolved' };
    return creation;
  });
  return result;
}

describe('guided repository cube initialization', () => {
  it('collects name and template, then asks for exactly one confirmation', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('Product API')
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('y');
    const createCube = vi.fn(deps().createCube);
    const inputDeps = deps({ prompt, createCube });

    const result = await initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result.kind).toBe('success');
    expect(prompt.mock.calls.map(([message]) => message)).toEqual([
      'Cube name [repo]: ',
      'Template [1]: ',
      `Create cube 'Product API' (${NEW_CUBE_TEMPLATE_PRESENTATIONS[1].label}) on https://borg.test? [Y/n]: `,
    ]);
    expect(createCube).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Product API', template: 'starter', workingRepoName: 'repo',
    }));
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining(
      'Continuing with role and seat setup...',
    ));
  });

  it('does not prompt or create when an association already exists', async () => {
    const prompt = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({
      prompt,
      createCube,
      getAssociation: vi.fn(async () => ({
        cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
        name: 'repo', workingRepoName: 'org/repo', template: 'software-dev',
      })),
    });

    const result = await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test',
      flags: { cubeName: 'other-name' },
    }, inputDeps);

    expect(result).toMatchObject({ kind: 'success', existing: true });
    expect(prompt).not.toHaveBeenCalled();
    expect(createCube).not.toHaveBeenCalled();
    expect(inputDeps.resolveAssociation).not.toHaveBeenCalled();
    expect(inputDeps.listCubes).not.toHaveBeenCalled();
    expect(inputDeps.write).toHaveBeenNthCalledWith(
      1,
      "Checking this repository's cube on https://borg.test…\n",
    );
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('Creation options were not used'));
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('No drone was created.'));
  });

  it('renders the all-default fresh-create transcript checkpoints', async () => {
    const prompt = vi.fn(async () => '');
    const write = vi.fn();
    const inputDeps = deps({ prompt, write });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toMatchObject({ kind: 'success', existing: false });

    expect(prompt.mock.calls.map(([message]) => message)).toEqual([
      'Cube name [repo]: ',
      'Template [1]: ',
      `Create cube 'repo' (${NEW_CUBE_TEMPLATE_PRESENTATIONS[0].label}) on https://borg.test? [Y/n]: `,
    ]);
    expect(write.mock.calls.map(([text]) => text)).toEqual([
      "Checking this repository's cube on https://borg.test…\n",
      'Create a cube for this repository\nRepository: /repo\nServer: https://borg.test\n',
      expect.stringContaining('Choose a template:\n'),
      "Creating cube 'repo'…\n",
      expect.stringContaining('Cube created.\n  Name: repo\n'),
    ]);
  });

  it('uses the authoritative cube name without rewriting a trusted local association from partial readback', async () => {
    const saveAssociation = vi.fn(async () => {});
    const inputDeps = deps({
      saveAssociation,
      getAssociation: vi.fn(async () => ({
        cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
        name: 'old-name', workingRepoName: 'repo', template: 'starter',
      })),
      getCube: vi.fn(async (id) => ({ id, name: 'renamed-cube', roles: [] })),
    });

    await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('Name: renamed-cube'));
    expect(saveAssociation).not.toHaveBeenCalled();
  });

  it('reports a typed failure when server creation succeeds but association persistence fails', async () => {
    const inputDeps = deps({
      isTTY: () => false,
      saveAssociation: vi.fn(async () => { throw new Error('disk full'); }),
    });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test',
      flags: { yes: true },
    }, inputDeps)).rejects.toMatchObject({ name: 'RepositoryAssociationSaveError' });
  });

  it('classifies an uncategorized create dependency failure as post-dispatch uncertainty', async () => {
    const saveAssociation = vi.fn();
    const inputDeps = deps({
      isTTY: () => false,
      createCube: vi.fn(async () => { throw new Error('malformed post-dispatch response'); }),
      saveAssociation,
    });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test',
      flags: { yes: true }, canCreate: true,
    }, inputDeps)).rejects.toMatchObject({ name: 'CubeCreationOutcomeUnknownError' });
    expect(saveAssociation).not.toHaveBeenCalled();
  });

  it('fails closed when more than one accessible cube has the proposed name', async () => {
    const associateCube = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({
      listCubes: vi.fn(async () => [
        { id: 'cube-a', name: 'repo' },
        { id: 'cube-b', name: 'repo' },
      ]),
      associateCube,
      createCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 1 });

    expect(associateCube).not.toHaveBeenCalled();
    expect(createCube).not.toHaveBeenCalled();
    expect(inputDeps.saveAssociation).not.toHaveBeenCalled();
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('More than one accessible cube'));
  });

  it('does not save local state when the confirmed association operation fails', async () => {
    const associateCube = vi.fn(async () => { throw new Error('association denied'); });
    const createCube = vi.fn();
    const inputDeps = deps({
      prompt: vi.fn(async () => 'yes'),
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]),
      associateCube,
      createCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).rejects.toThrow('association denied');

    expect(createCube).not.toHaveBeenCalled();
    expect(inputDeps.saveAssociation).not.toHaveBeenCalled();
  });

  it('adopts an exact legacy match when the operator accepts the default', async () => {
    const prompt = vi.fn(async () => '');
    const write = vi.fn();
    const associateCube = vi.fn(deps().associateCube);
    const inputDeps = deps({
      prompt,
      write,
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]),
      associateCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toMatchObject({ kind: 'success', existing: true });

    expect(prompt).toHaveBeenCalledWith('Link this repository to that cube? [Y/n]: ');
    expect(associateCube).toHaveBeenCalledTimes(1);
    expect(write.mock.calls.map(([text]) => text)).toEqual([
      "Checking this repository's cube on https://borg.test…\n",
      'Found an existing cube matching this repository:\n' +
        '  cube:       repo\n' +
        '  repository: /repo\n' +
        '  server:     https://borg.test\n',
      "Linking this repository to cube 'repo'…\n",
      expect.stringContaining('Existing cube associated with this repository.\n  Name: repo\n'),
    ]);
  });

  it('declines an exact legacy match only on an explicit negative answer', async () => {
    const associateCube = vi.fn();
    const prompt = vi.fn(async () => 'no');
    const write = vi.fn();
    const inputDeps = deps({
      prompt,
      write,
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]),
      associateCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 0 });

    expect(associateCube).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledWith('Link this repository to that cube? [Y/n]: ');
    expect(write.mock.calls.map(([text]) => text)).toEqual([
      "Checking this repository's cube on https://borg.test…\n",
      'Found an existing cube matching this repository:\n' +
        '  cube:       repo\n' +
        '  repository: /repo\n' +
        '  server:     https://borg.test\n',
      'No cube, repository binding, or drone was created.\n',
    ]);
  });

  it.each([
    ['assimilate', "borg assimilate --host 'https://borg.test'"],
    ['cube-init', "borg server cube init --host 'https://borg.test'"],
  ] as const)('keeps --yes adoption fail-closed in %s mode with an interactive rerun', async (mode, command) => {
    const associateCube = vi.fn();
    const inputDeps = deps({
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]),
      associateCube,
    });

    await expect(initializeRepositoryCube({
      mode, context, serverOrigin: 'https://borg.test', flags: { yes: true }, canCreate: true,
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 1 });

    expect(associateCube).not.toHaveBeenCalled();
    expect(inputDeps.write).toHaveBeenLastCalledWith(
      "Found existing cube 'repo' on https://borg.test.\n" +
        'Linking a repository to an existing cube requires one interactive confirmation.\n' +
        `Run ${command} --cube-name 'repo' once in an interactive terminal to link it; scripted runs work from then on.\n` +
        'No cube, repository binding, or drone was created.\n',
    );
  });

  it.each([
    ['assimilate', "borg assimilate --host 'https://borg.test'"],
    ['cube-init', "borg server cube init --host 'https://borg.test'"],
  ] as const)('preserves a mismatched legacy cube name across the %s interactive retry', async (mode, command) => {
    const mismatchContext = { ...context, derivedName: 'worktree-seat' };
    const listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'Legacy Cube' }]);
    const failClosedDeps = deps({ listCubes });

    await expect(initializeRepositoryCube({
      mode,
      context: mismatchContext,
      serverOrigin: 'https://borg.test',
      flags: { cubeName: 'Legacy Cube', yes: true },
      canCreate: true,
    }, failClosedDeps)).resolves.toEqual({ kind: 'stop', code: 1 });

    expect(failClosedDeps.write).toHaveBeenLastCalledWith(
      "Found existing cube 'Legacy Cube' on https://borg.test.\n" +
        'Linking a repository to an existing cube requires one interactive confirmation.\n' +
        `Run ${command} --cube-name 'Legacy Cube' once in an interactive terminal to link it; scripted runs work from then on.\n` +
        'No cube, repository binding, or drone was created.\n',
    );

    const createCube = vi.fn();
    const write = vi.fn();
    const retryDeps = deps({
      prompt: vi.fn(async () => ''),
      write,
      listCubes,
      createCube,
      associateCube: vi.fn(async (input) => ({
        result: 'resolved' as const,
        cube_id: input.cubeId,
        name: 'Legacy Cube',
        working_repo_name: input.workingRepoName,
        repository: input.repository,
        template: 'default' as const,
        human_seat_role_id: 'role-human',
        default_worker_role_id: 'role-default',
        access: 'manage' as const,
      })),
      getCube: vi.fn(async () => ({
        id: 'cube-existing',
        name: 'Legacy Cube',
        roles: [
          { id: 'role-human', is_human_seat: true },
          { id: 'role-default', is_default: true },
        ],
      })),
    });

    await expect(initializeRepositoryCube({
      mode,
      context: mismatchContext,
      serverOrigin: 'https://borg.test',
      flags: { cubeName: 'Legacy Cube' },
      canCreate: true,
    }, retryDeps)).resolves.toMatchObject({ kind: 'success', existing: true });

    expect(retryDeps.associateCube).toHaveBeenCalledTimes(1);
    expect(createCube).not.toHaveBeenCalled();
    expect(write.mock.calls.map(([text]) => text).join('')).not.toContain(
      'Creation options were not used because this repository is already initialized.',
    );
  });

  it('keeps non-TTY adoption fail-closed without attempting mutation', async () => {
    const associateCube = vi.fn();
    const prompt = vi.fn();
    const inputDeps = deps({
      isTTY: () => false,
      prompt,
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'repo' }]),
      associateCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 1 });

    expect(associateCube).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(inputDeps.write).toHaveBeenLastCalledWith(
      "Found existing cube 'repo' on https://borg.test.\n" +
        'Linking a repository to an existing cube requires one interactive confirmation.\n' +
        "Run borg assimilate --host 'https://borg.test' --cube-name 'repo' once in an interactive terminal to link it; scripted runs work from then on.\n" +
        'No cube, repository binding, or drone was created.\n',
    );
  });

  it('rejects a resolved association whose authoritative role IDs are absent from cube readback', async () => {
    const inputDeps = deps({
      resolveAssociation: vi.fn(async () => ({
        result: 'resolved',
        cube_id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
        name: 'repo',
        working_repo_name: 'repo',
        repository: context.publicRepository!,
        template: 'default',
        human_seat_role_id: '8c02328a-59f0-472e-b071-f7417405528f',
        default_worker_role_id: '99999999-9999-4999-8999-999999999999',
        access: 'manage',
      })),
    });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).rejects.toMatchObject({ name: 'RepositoryAssociationConfirmationError' });

    expect(inputDeps.saveAssociation).not.toHaveBeenCalled();
    expect(inputDeps.listCubes).not.toHaveBeenCalled();
  });

  it('rechecks an edited guided name before template selection or creation', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('Product API')
      .mockResolvedValueOnce('yes');
    const associateCube = vi.fn(async (input) => ({
      result: 'resolved' as const,
      cube_id: input.cubeId,
      name: 'Product API',
      working_repo_name: input.workingRepoName,
      repository: input.repository,
      template: 'default' as const,
      human_seat_role_id: 'role-human',
      default_worker_role_id: 'role-default',
      access: 'manage' as const,
    }));
    const createCube = vi.fn();
    const inputDeps = deps({
      prompt,
      listCubes: vi.fn(async () => [{ id: 'cube-existing', name: 'Product API' }]),
      associateCube,
      getCube: vi.fn(async () => ({
        id: 'cube-existing',
        name: 'Product API',
        roles: [
          { id: 'role-human', is_human_seat: true },
          { id: 'role-default', is_default: true },
        ],
      })),
      createCube,
    });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: true,
    }, inputDeps)).resolves.toMatchObject({ kind: 'success', existing: true });

    expect(prompt.mock.calls.map(([message]) => message)).toEqual([
      'Cube name [repo]: ',
      'Link this repository to that cube? [Y/n]: ',
    ]);
    expect(inputDeps.write).toHaveBeenCalledWith(
      'Found an existing cube matching this repository:\n' +
      '  cube:       Product API\n' +
      '  repository: /repo\n' +
      '  server:     https://borg.test\n',
    );
    expect(associateCube).toHaveBeenCalledWith(expect.objectContaining({ cubeId: 'cube-existing' }));
    expect(createCube).not.toHaveBeenCalled();
  });

  it('does not enter the creation guide for an ordinary client with no matching cube', async () => {
    const prompt = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({ prompt, createCube });

    await expect(initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {}, canCreate: false,
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 1 });

    expect(prompt).not.toHaveBeenCalled();
    expect(createCube).not.toHaveBeenCalled();
    expect(inputDeps.saveAssociation).not.toHaveBeenCalled();
  });

  it('requires explicit creation inputs in non-interactive mode', async () => {
    const createCube = vi.fn();
    const inputDeps = deps({ isTTY: () => false, createCube });

    await expect(initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps)).resolves.toEqual({ kind: 'stop', code: 1 });
    expect(createCube).not.toHaveBeenCalled();
  });

  it('renders template menu labels from shared NEW_CUBE_TEMPLATE_PRESENTATIONS', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('y');
    const write = vi.fn();
    const createCube = vi.fn(deps().createCube);
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result.kind).toBe('success');
    const menuLines = write.mock.calls
      .filter(([text]) => text.includes('Choose a template:'))
      .map(([text]) => text);
    expect(menuLines.length).toBeGreaterThan(0);
    const fullMenu = menuLines.join('');
    for (const presentation of NEW_CUBE_TEMPLATE_PRESENTATIONS) {
      expect(fullMenu).toContain(presentation.label);
      expect(fullMenu).toContain(presentation.short_description);
    }
    expect(fullMenu).toContain('(recommended)');
  });

  it('re-prompts on invalid name without false EOF', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('!!!')
      .mockResolvedValueOnce('!!!')
      .mockResolvedValueOnce('Valid Name')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('y');
    const createCube = vi.fn(deps().createCube);
    const inputDeps = deps({ prompt, createCube });

    const result = await initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result.kind).toBe('success');
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Cube name'));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Template'));
    expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Create cube'));
  });

  it('re-prompts on invalid template without false EOF', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('bad')
      .mockResolvedValueOnce('99')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('y');
    const write = vi.fn();
    const createCube = vi.fn(deps().createCube);
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result.kind).toBe('success');
    expect(write).toHaveBeenCalledWith('Choose 1 or 2.\n');
    expect(write).not.toContain('Input ended before cube creation');
  });

  it('re-prompts on invalid confirmation without false EOF', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('maybe')
      .mockResolvedValueOnce('yes');
    const write = vi.fn();
    const createCube = vi.fn(deps().createCube);
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result.kind).toBe('success');
    expect(write).toHaveBeenCalledWith('Enter y or n.\n');
    expect(write).not.toContain('Input ended before cube creation');
  });

  it('maps SIGINT to typed interruption with exact copy and exit 130', async () => {
    const prompt = vi.fn()
      .mockRejectedValue(new PromptInterruptedError());
    const write = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'cube-init', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result).toEqual({ kind: 'stop', code: 130 });
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. No cube, repository binding, or drone was created.\n');
    expect(createCube).not.toHaveBeenCalled();
  });

  it('maps SIGINT during name prompt to typed interruption with exit 130', async () => {
    const prompt = vi.fn()
      .mockRejectedValue(new PromptInterruptedError());
    const write = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result).toEqual({ kind: 'stop', code: 130 });
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. No cube, repository binding, or drone was created.\n');
    expect(createCube).not.toHaveBeenCalled();
  });

  it('maps SIGINT during template prompt to typed interruption with exit 130', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('Product API')
      .mockRejectedValue(new PromptInterruptedError());
    const write = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result).toEqual({ kind: 'stop', code: 130 });
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. No cube, repository binding, or drone was created.\n');
    expect(createCube).not.toHaveBeenCalled();
  });

  it('maps SIGINT during confirmation prompt to typed interruption with exit 130', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce('Product API')
      .mockResolvedValueOnce('2')
      .mockRejectedValue(new PromptInterruptedError());
    const write = vi.fn();
    const createCube = vi.fn();
    const inputDeps = deps({ prompt, write, createCube });

    const result = await initializeRepositoryCube({
      mode: 'assimilate', context, serverOrigin: 'https://borg.test', flags: {},
    }, inputDeps);

    expect(result).toEqual({ kind: 'stop', code: 130 });
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. No cube, repository binding, or drone was created.\n');
    expect(createCube).not.toHaveBeenCalled();
  });
});
