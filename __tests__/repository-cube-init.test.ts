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
  return {
    isTTY: () => true,
    prompt: vi.fn(async () => ''),
    write: vi.fn(),
    getIdentity: vi.fn(async () => repository),
    getAssociation: vi.fn(async () => null),
    saveAssociation: vi.fn(async () => {}),
    getCube: vi.fn(async (id) => ({ id, name: 'repo', roles: [] })),
    createCube: vi.fn(async (input) => ({
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
      cube: { id: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826', name: input.name, roles: [] },
    })),
    ...overrides,
  };
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
      'Cube name [repo]: ', 'Template [1]: ', 'Create cube? [Y/n]: ',
    ]);
    expect(createCube).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Product API', template: 'starter', workingRepoName: 'repo',
    }));
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
      flags: { cubeName: 'ignored', template: 'starter' },
    }, inputDeps);

    expect(result).toMatchObject({ kind: 'success', existing: true });
    expect(prompt).not.toHaveBeenCalled();
    expect(createCube).not.toHaveBeenCalled();
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('Creation options were not used'));
    expect(inputDeps.write).toHaveBeenCalledWith(expect.stringContaining('No drone was created.'));
  });

  it('uses the authoritative cube name and refreshes a stale association', async () => {
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
    expect(saveAssociation).toHaveBeenCalledWith(context.publicRepository, expect.objectContaining({
      name: 'renamed-cube',
    }));
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
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
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
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
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
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
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
    expect(write).toHaveBeenCalledWith('\nCube creation cancelled. Nothing was changed.\n');
    expect(createCube).not.toHaveBeenCalled();
  });
});
