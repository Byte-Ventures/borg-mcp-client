import {
  NEW_CUBE_TEMPLATE_PRESENTATIONS,
  getTemplate,
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
import {
  BorgServerError,
  CubeCreationConfirmationError,
  CubeCreationOutcomeUnknownError,
} from './server-errors.js';

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

type NewCubeTemplate = CubeTemplate;

const NEW_CUBE_TEMPLATE_NAMES: readonly NewCubeTemplate[] =
  NEW_CUBE_TEMPLATE_PRESENTATIONS.map(({ name }) => name);
const NEW_CUBE_TEMPLATE_OPTIONS = NEW_CUBE_TEMPLATE_NAMES.join('|');
const NEW_CUBE_TEMPLATE_LIST = NEW_CUBE_TEMPLATE_NAMES.join(', ');

function parseNewCubeTemplate(value: string): NewCubeTemplate | undefined {
  return NEW_CUBE_TEMPLATE_PRESENTATIONS.find(({ name }) => name === value)?.name;
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
  writeResult?(text: string): void;
  useColor?(): boolean;
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
    template: NewCubeTemplate;
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
  return getTemplate(template)!;
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
      deps.write(`\nCube ${operation} cancelled. No cube, repository binding, or drone was created.\n`);
      return { stop: 130 };
    }
    deps.write(`Input ended before cube ${operation}. No cube, repository binding, or drone was created.\n`);
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
  const resultWriter = deps.writeResult ?? deps.write;
  const heading = input.adopted
    ? 'Existing cube associated with this repository.'
    : input.existing
      ? 'Cube already initialized.'
      : 'Cube created.';
  const lines = [
    input.mode === 'cube-init'
      ? `${deps.useColor?.() ? '\u001b[32m✓\u001b[0m' : '✓'} ${heading}`
      : heading,
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
    lines.push('Continuing with role and connection setup…');
  }
  resultWriter(`${lines.join('\n')}\n`);
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
    deps.write(`Checking for this repository's cube on ${input.serverOrigin}…\n`);
    const cube = await deps.getCube(association.cubeId);
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

  deps.write(`Checking for this repository's cube on ${input.serverOrigin}…\n`);
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
    const normalizedName = name.trim().toLowerCase();
    const matches = accessibleCubes.filter((cube) => cube.name.trim().toLowerCase() === normalizedName);
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      deps.write(`More than one accessible cube is named '${name}'. No cube, repository binding, or drone was created. Ask the server operator for an unambiguous repository cube grant.\n`);
      return { kind: 'stop', code: 1 };
    }
    if (!deps.isTTY() || input.flags.yes) {
      const retryCommand = input.mode === 'cube-init'
        ? `borg server cube init --host ${shellEscape(input.serverOrigin)}`
        : `borg assimilate --host ${shellEscape(input.serverOrigin)}`;
      deps.write(
        `Found existing cube '${matches[0].name}' on ${input.serverOrigin}.\n` +
        'Linking a repository to an existing cube requires one interactive confirmation.\n' +
        `Run ${retryCommand} --cube-name ${shellEscape(matches[0].name)} once in an interactive terminal to link it; scripted runs work from then on.\n` +
        'No cube, repository binding, or drone was created.\n',
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
      const answer = await ask(deps, 'Link this repository to that cube? [Y/n]: ', 'adoption');
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      const confirmation = answer.value.trim().toLowerCase();
      if (confirmation === '' || confirmation === 'y' || confirmation === 'yes') break;
      if (confirmation === 'n' || confirmation === 'no') {
        deps.write('No cube, repository binding, or drone was created.\n');
        return { kind: 'stop', code: 0 };
      }
      deps.write('Enter y or n.\n');
    }
    deps.write(`Linking this repository to cube '${matches[0].name}'…\n`);
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
      return await saveResolvedAssociation(confirmed, {
        adopted: true,
        creationOptionsUnused: input.flags.template !== undefined ||
          input.flags.noTemplate === true,
      });
    } catch (error) {
      if (error instanceof RepositoryAssociationSaveError) throw error;
      throw new RepositoryAssociationConfirmationError();
    }
  };

  const proposedAdoption = await adoptExactMatch(proposedName);
  if (proposedAdoption) return proposedAdoption;

  if (input.canCreate === false) {
    const retryCommand = input.mode === 'cube-init'
      ? `borg server cube init --host ${shellEscape(input.serverOrigin)}`
      : `borg assimilate --host ${shellEscape(input.serverOrigin)}`;
    deps.write(
      `This enrolled client cannot create a cube on ${input.serverOrigin}. Ask the server operator to grant access to a cube, then rerun ${retryCommand}.\n`,
    );
    return { kind: 'stop', code: 1 };
  }

  if (input.flags.noTemplate) {
    deps.write(`--no-template is not supported for repository cube creation. Use --template ${NEW_CUBE_TEMPLATE_OPTIONS}.\n`);
    return { kind: 'stop', code: 1 };
  }
  const requestedTemplate = input.flags.template === undefined
    ? undefined
    : parseNewCubeTemplate(input.flags.template);
  if (input.flags.template !== undefined && requestedTemplate === undefined) {
    const safe = input.flags.template.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 120);
    deps.write(`Unknown template '${safe}'. Available templates: ${NEW_CUBE_TEMPLATE_LIST}.\n`);
    return { kind: 'stop', code: 1 };
  }
  if (!deps.isTTY() && !input.flags.yes && (!input.flags.cubeName || !input.flags.template)) {
    deps.write(`Non-interactive cube creation requires --cube-name <name> and --template ${NEW_CUBE_TEMPLATE_OPTIONS}, or --yes to use repository defaults.\n`);
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

  let template = requestedTemplate;
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
      const selectedIndex = selected === ''
        ? 0
        : /^[1-9]\d*$/.test(selected) ? Number(selected) - 1 : -1;
      const selectedPresentation = NEW_CUBE_TEMPLATE_PRESENTATIONS[selectedIndex];
      if (selectedPresentation) template = selectedPresentation.name;
      else deps.write(`Choose 1-${NEW_CUBE_TEMPLATE_PRESENTATIONS.length}.\n`);
    }
  }
  template ??= NEW_CUBE_TEMPLATE_PRESENTATIONS[0].name;

  if (deps.isTTY() && !input.flags.yes) {
    let confirmed = false;
    while (!confirmed) {
      const answer = await ask(
        deps,
        `Create cube '${name}' (${presentation(template).label}) on ${input.serverOrigin}? [Y/n]: `,
      );
      if ('stop' in answer) return { kind: 'stop', code: answer.stop };
      const confirmation = answer.value.trim().toLowerCase();
      if (confirmation === '' || confirmation === 'y' || confirmation === 'yes') {
        confirmed = true;
        break;
      }
      if (confirmation === 'n' || confirmation === 'no') {
        deps.write('Cube creation cancelled. No cube, repository binding, or drone was created.\n');
        return { kind: 'stop', code: 0 };
      }
      deps.write('Enter y or n.\n');
    }
  }

  deps.write(`Creating cube '${name}'…\n`);
  const workingRepoName = input.context.derivedName;
  let creation: RepositoryCubeCreation;
  try {
    creation = await deps.createCube({ name, workingRepoName, repository, template });
  } catch (error) {
    if (
      error instanceof BorgServerError ||
      error instanceof CubeCreationConfirmationError ||
      error instanceof CubeCreationOutcomeUnknownError
    ) {
      throw error;
    }
    throw new CubeCreationOutcomeUnknownError();
  }
  let confirmed: RepositoryCubeResolution;
  try {
    confirmed = await deps.resolveAssociation(repository, workingRepoName);
  } catch {
    throw new CubeCreationConfirmationError('The server did not return authoritative repository association state.');
  }
  if (
    confirmed.result !== 'resolved' ||
    confirmed.repository.kind !== repository.kind ||
    confirmed.repository.value !== repository.value ||
    confirmed.working_repo_name !== workingRepoName ||
    confirmed.cube_id !== creation.response.cube_id ||
    confirmed.name !== creation.response.name ||
    creation.cube.id !== confirmed.cube_id ||
    creation.cube.name !== confirmed.name ||
    !creation.cube.roles.some((role) => role.id === confirmed.human_seat_role_id) ||
    !creation.cube.roles.some((role) => role.id === confirmed.default_worker_role_id)
  ) {
    throw new CubeCreationConfirmationError('The server did not confirm the created cube through authoritative repository resolution.');
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
