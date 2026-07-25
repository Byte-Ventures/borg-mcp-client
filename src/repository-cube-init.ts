import {
  NEW_CUBE_TEMPLATE_PRESENTATIONS,
  LEGACY_DEFAULT_TEMPLATE_LABEL,
} from 'borgmcp-shared/templates';
import type {
  AssociateRepositoryCubeResponse,
  CreateCubeRepository,
  CreateCubeResponse,
  CubeTemplate,
  ResolvedRepositoryCube,
  ResolveRepositoryCubeResponse,
} from 'borgmcp-shared/protocol';
import { shellEscape } from './shell-escape.js';
import type {
  GitRepositoryContext,
  RepositoryAssociation,
} from './repository-identity.js';
import { CubeCreationConfirmationError } from './server-errors.js';

export interface RepositoryCubeDetail {
  id: string;
  name: string;
  roles: any[];
  drones?: Array<{ role_id: string }>;
}

export interface RepositoryCubeCreation {
  response: CreateCubeResponse;
  cube: RepositoryCubeDetail;
}

export type RepositoryCubeResolution = ResolveRepositoryCubeResponse;

export interface RepositoryCubeInitFlags {
  cubeName?: string;
  template?: string;
  noTemplate?: boolean;
  yes?: boolean;
}

export interface RepositoryCubeInitDeps {
  isTTY(): boolean;
  prompt(message: string): Promise<string>;
  write(text: string): void;
  getIdentity(context: GitRepositoryContext): Promise<CreateCubeRepository>;
  getAssociation(repository: CreateCubeRepository): Promise<RepositoryAssociation | null>;
  saveAssociation(repository: CreateCubeRepository, association: RepositoryAssociation): Promise<void>;
  resolveAssociation(repository: CreateCubeRepository, workingRepoName: string): Promise<RepositoryCubeResolution>;
  listCubes(): Promise<Array<{ id: string; name: string }>>;
  associateCube(input: {
    cubeId: string;
    workingRepoName: string;
    repository: CreateCubeRepository;
  }): Promise<AssociateRepositoryCubeResponse>;
  getCube(cubeId: string): Promise<RepositoryCubeDetail>;
  createCube(input: {
    name: string;
    workingRepoName: string;
    repository: CreateCubeRepository;
    template: Exclude<CubeTemplate, 'default'>;
  }): Promise<RepositoryCubeCreation>;
}

export type RepositoryCubeInitResult =
  | { kind: 'success'; creation: RepositoryCubeCreation; existing: boolean }
  | { kind: 'stop'; code: number };

export class RepositoryAssociationSaveError extends Error {
  constructor() {
    super('repository association could not be saved');
    this.name = 'RepositoryAssociationSaveError';
  }
}

export class RepositoryAssociationConfirmationError extends Error {
  constructor() {
    super('The Borg server did not confirm the repository cube association.');
    this.name = 'RepositoryAssociationConfirmationError';
  }
}

export class PromptInterruptedError extends Error {
  constructor() {
    super('prompt interrupted');
    this.name = 'PromptInterruptedError';
  }
}

const NAME_ERROR = 'Use 1-120 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.';

export function validRepositoryCubeName(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= 120 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value);
}

function presentation(template: CubeTemplate) {
  if (template === 'default') {
    return { name: template, label: LEGACY_DEFAULT_TEMPLATE_LABEL };
  }
  return NEW_CUBE_TEMPLATE_PRESENTATIONS.find((candidate) => candidate.name === template)!;
}

async function ask(
  deps: RepositoryCubeInitDeps,
  message: string,
  operation: 'creation' | 'adoption' = 'creation',
): Promise<{ value: string } | { stop: number }> {
  try {
    return { value: await deps.prompt(message) };
  } catch (error) {
    if (error instanceof PromptInterruptedError) {
      deps.write(`\nCube ${operation} cancelled. Nothing was changed.\n`);
      return { stop: 130 };
    }
    deps.write(`Input ended before cube ${operation}. Nothing was changed.\n`);
    return { stop: 1 };
  }
}

function renderResult(
  deps: RepositoryCubeInitDeps,
  input: {
    existing: boolean;
    response: Pick<CreateCubeResponse, 'name' | 'working_repo_name' | 'template'>;
    root: string;
    serverOrigin: string;
    mode: 'assimilate' | 'cube-init';
    creationOptionsUnused: boolean;
    adopted?: boolean;
  },
): void {
  const lines = [
    input.adopted ? 'Existing cube associated with this repository.' : input.existing ? 'Cube already initialized.' : 'Cube created.',
    `  Name: ${input.response.name}`,
    `  Template: ${presentation(input.response.template).label}`,
    `  Repository: ${input.root}`,
    `  Server: ${input.serverOrigin}`,
  ];
  if (input.creationOptionsUnused) {
    lines.push('Creation options were not used because this repository is already initialized.');
  }
  if (input.mode === 'cube-init') {
    lines.push(
      'No drone was created.',
      `Next: borg assimilate --host ${shellEscape(input.serverOrigin)}`,
    );
  } else {
    lines.push('Continuing with role and seat setup...');
  }
  deps.write(`${lines.join('\n')}\n`);
}

export async function initializeRepositoryCube(input: {
  mode: 'assimilate' | 'cube-init';
  context: GitRepositoryContext;
  serverOrigin: string;
  flags: RepositoryCubeInitFlags;
  canCreate?: boolean;
}, deps: RepositoryCubeInitDeps): Promise<RepositoryCubeInitResult> {
  const repository = await deps.getIdentity(input.context);
  const association = await deps.getAssociation(repository);
  const creationOptionsRequested = input.flags.cubeName !== undefined ||
    input.flags.template !== undefined || input.flags.noTemplate === true || input.flags.yes === true;
  const creationOptionsUnused = association !== null && creationOptionsRequested;
  if (association) {
    const cube = await deps.getCube(association.cubeId);
    const authoritativeAssociation = { ...association, name: cube.name };
    if (cube.name !== association.name) {
      try {
        await deps.saveAssociation(repository, authoritativeAssociation);
      } catch {
        throw new RepositoryAssociationSaveError();
      }
    }
    const response: CreateCubeResponse = {
      result: 'resolved',
      cube_id: association.cubeId,
      name: cube.name,
      working_repo_name: association.workingRepoName,
      repository,
      template: association.template,
      human_seat_role_id: cube.roles.find((role) => role.is_human_seat)?.id ?? '',
      default_worker_role_id: cube.roles.find((role) => role.is_default)?.id ?? '',
      access: 'manage',
    };
    renderResult(deps, {
      existing: true,
      response,
      root: input.context.root,
      serverOrigin: input.serverOrigin,
      mode: input.mode,
      creationOptionsUnused,
    });
    return { kind: 'success', creation: { response, cube }, existing: true };
  }

  const saveResolvedAssociation = async (
    response: ResolvedRepositoryCube,
    options: { adopted: boolean; creationOptionsUnused: boolean },
  ): Promise<RepositoryCubeInitResult> => {
    if (
      response.repository.kind !== repository.kind ||
      response.repository.value !== repository.value ||
      response.working_repo_name !== input.context.derivedName
    ) {
      throw new RepositoryAssociationConfirmationError();
    }
    const cube = await deps.getCube(response.cube_id);
    if (
      cube.id !== response.cube_id ||
      cube.name !== response.name ||
      !cube.roles.some((role) => role.id === response.human_seat_role_id) ||
      !cube.roles.some((role) => role.id === response.default_worker_role_id)
    ) {
      throw new RepositoryAssociationConfirmationError();
    }
    try {
      await deps.saveAssociation(repository, {
        cubeId: response.cube_id,
        name: response.name,
        workingRepoName: response.working_repo_name,
        template: response.template,
      });
    } catch {
      throw new RepositoryAssociationSaveError();
    }
    renderResult(deps, {
      existing: true,
      adopted: options.adopted,
      response,
      root: input.context.root,
      serverOrigin: input.serverOrigin,
      mode: input.mode,
      creationOptionsUnused: options.creationOptionsUnused,
    });
    return { kind: 'success', creation: { response, cube }, existing: true };
  };

  const serverAssociation = await deps.resolveAssociation(repository, input.context.derivedName);
  if (serverAssociation.result === 'resolved') {
    return saveResolvedAssociation(serverAssociation, {
      adopted: false,
      creationOptionsUnused: creationOptionsRequested,
    });
  }

  const proposedName = input.flags.cubeName?.trim() ?? input.context.derivedName;
  if (!validRepositoryCubeName(proposedName)) {
    deps.write(`${NAME_ERROR}\n`);
    return { kind: 'stop', code: 1 };
  }
  const accessibleCubes = await deps.listCubes();
  const adoptExactMatch = async (name: string): Promise<RepositoryCubeInitResult | null> => {
    const matches = accessibleCubes.filter((cube) => cube.name === name);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      deps.write(`More than one accessible cube is named '${name}'. Nothing was changed. Ask the server operator for an unambiguous repository cube grant.\n`);
      return { kind: 'stop', code: 1 };
    }
    if (!deps.isTTY() || input.flags.yes) {
      deps.write(
        'Adopting an existing cube requires interactive confirmation; --yes is not accepted here.\n' +
        'Rerun without --yes in an interactive terminal. Nothing was created or changed.\n',
      );
      return { kind: 'stop', code: 1 };
    }
    deps.write(
      `Found an existing cube matching this repository:\n` +
      `  cube:       ${matches[0].name}\n` +
      `  repository: ${input.context.root}\n` +
      `  server:     ${input.serverOrigin}\n`,
    );
    while (true) {
      const answer = await ask(deps, 'Link this repository to that cube? [y/N]: ', 'adoption');
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      const confirmation = answer.value.trim().toLowerCase();
      if (confirmation === 'y' || confirmation === 'yes') break;
      if (confirmation === '' || confirmation === 'n' || confirmation === 'no') {
        deps.write('No changes made.\n');
        return { kind: 'stop', code: 0 };
      }
      deps.write('Enter y or n.\n');
    }
    const associated = await deps.associateCube({
      cubeId: matches[0].id,
      workingRepoName: input.context.derivedName,
      repository,
    });
    if (associated.cube_id !== matches[0].id) {
      throw new RepositoryAssociationConfirmationError();
    }
    try {
      const confirmed = await deps.resolveAssociation(repository, input.context.derivedName);
      if (confirmed.result !== 'resolved' || confirmed.cube_id !== associated.cube_id) {
        throw new RepositoryAssociationConfirmationError();
      }
      return await saveResolvedAssociation(confirmed, { adopted: true, creationOptionsUnused: creationOptionsRequested });
    } catch (error) {
      if (error instanceof RepositoryAssociationSaveError) throw error;
      throw new RepositoryAssociationConfirmationError();
    }
  };

  const proposedAdoption = await adoptExactMatch(proposedName);
  if (proposedAdoption) return proposedAdoption;

  if (input.canCreate === false) {
    deps.write(
      `This enrolled client cannot create a cube on ${input.serverOrigin}. Ask the server operator to grant access to a cube, then rerun borg assimilate --host ${shellEscape(input.serverOrigin)}.\n`,
    );
    return { kind: 'stop', code: 1 };
  }

  if (input.flags.noTemplate) {
    deps.write('--no-template is not supported for repository cube creation. Use --template software-dev or --template starter.\n');
    return { kind: 'stop', code: 1 };
  }
  if (input.flags.template !== undefined && input.flags.template !== 'software-dev' && input.flags.template !== 'starter') {
    const safe = input.flags.template.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
    deps.write(`Unknown template '${safe}'. Use software-dev or starter.\n`);
    return { kind: 'stop', code: 1 };
  }
  if (!deps.isTTY() && !input.flags.yes && (!input.flags.cubeName || !input.flags.template)) {
    deps.write('Non-interactive cube creation requires --cube-name <name> and --template software-dev|starter, or --yes to use repository defaults.\n');
    return { kind: 'stop', code: 1 };
  }

  deps.write(
    `Create a cube for this repository\n` +
    `Repository: ${input.context.root}\n` +
    `Server: ${input.serverOrigin}\n`,
  );

  let name = input.flags.cubeName?.trim() ?? input.context.derivedName;
  if (!input.flags.cubeName && deps.isTTY() && !input.flags.yes) {
    while (true) {
      const answer = await ask(deps, `Cube name [${input.context.derivedName}]: `);
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      name = answer.value.trim() || input.context.derivedName;
      if (validRepositoryCubeName(name)) break;
      deps.write(`${NAME_ERROR}\n`);
    }
  }
  if (!validRepositoryCubeName(name)) {
    deps.write(`${NAME_ERROR}\n`);
    return { kind: 'stop', code: 1 };
  }
  if (name !== proposedName) {
    const editedNameAdoption = await adoptExactMatch(name);
    if (editedNameAdoption) return editedNameAdoption;
  }

  let template = input.flags.template as 'software-dev' | 'starter' | undefined;
  if (!template && deps.isTTY() && !input.flags.yes) {
    let menu = 'Choose a template:\n';
    for (let i = 0; i < NEW_CUBE_TEMPLATE_PRESENTATIONS.length; i += 1) {
      const p = NEW_CUBE_TEMPLATE_PRESENTATIONS[i];
      const suffix = i === 0 ? ' (recommended)' : '';
      menu += `  ${i + 1}. ${p.label}${suffix}\n`;
      menu += `     ${p.short_description}\n`;
    }
    deps.write(menu);
    while (!template) {
      const answer = await ask(deps, 'Template [1]: ');
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      const selected = answer.value.trim();
      if (selected === '' || selected === '1') template = 'software-dev';
      else if (selected === '2') template = 'starter';
      else deps.write('Choose 1 or 2.\n');
    }
  }
  template ??= 'software-dev';

  if (deps.isTTY() && !input.flags.yes) {
    deps.write(
      `Create this cube?\n` +
      `  Name: ${name}\n` +
      `  Template: ${presentation(template).label}\n` +
      `  Repository: ${input.context.root}\n` +
      `  Server: ${input.serverOrigin}\n`,
    );
    let confirmed = false;
    while (!confirmed) {
      const answer = await ask(deps, 'Create cube? [Y/n]: ');
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      const confirmation = answer.value.trim().toLowerCase();
      if (confirmation === '' || confirmation === 'y' || confirmation === 'yes') {
        confirmed = true;
        break;
      }
      if (confirmation === 'n' || confirmation === 'no') {
        deps.write('Cube creation cancelled. Nothing was changed.\n');
        return { kind: 'stop', code: 0 };
      }
      deps.write('Enter y or n.\n');
    }
  }

  deps.write('Creating cube...\n');
  const workingRepoName = input.context.derivedName;
  const creation = await deps.createCube({ name, workingRepoName, repository, template });
  let confirmed: RepositoryCubeResolution;
  try {
    confirmed = await deps.resolveAssociation(repository, workingRepoName);
  } catch {
    throw new CubeCreationConfirmationError('The server did not return authoritative repository association state.');
  }
  if (
    confirmed.result !== 'resolved' ||
    confirmed.cube_id !== creation.response.cube_id ||
    confirmed.name !== creation.response.name
  ) {
    throw new RepositoryAssociationConfirmationError();
  }
  try {
    await deps.saveAssociation(repository, {
      cubeId: confirmed.cube_id,
      name: confirmed.name,
      workingRepoName: confirmed.working_repo_name,
      template: confirmed.template,
    });
  } catch {
    throw new RepositoryAssociationSaveError();
  }
  renderResult(deps, {
    existing: creation.response.result === 'resolved',
    response: confirmed,
    root: input.context.root,
    serverOrigin: input.serverOrigin,
    mode: input.mode,
    creationOptionsUnused: false,
  });
  return {
    kind: 'success',
    creation: { response: confirmed, cube: creation.cube },
    existing: creation.response.result === 'resolved',
  };
}
