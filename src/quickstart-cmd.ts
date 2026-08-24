import {
  NEW_CUBE_TEMPLATE_PRESENTATIONS,
  getTemplate,
  type TemplateRole,
} from 'borgmcp-shared/templates';
import type { AssimilateDeps, PreparedAssimilation } from './assimilate-cmd.js';
import { runAssimilate } from './assimilate-cmd.js';
import { buildDefaultAssimilateDeps } from './assimilate-deps.js';
import type { ActiveCube } from './cubes.js';
import { readAllProjectIdentities } from './cubes.js';
import { buildDefaultLaunchAllDeps, type LaunchAllDeps } from './launch-all-deps.js';
import { LAUNCH_ALL_NO_DISPATCH_EXIT_CODE, runLaunchAll } from './launch-all-cmd.js';
import type { QuickstartArgs } from './parse-quickstart-args.js';
import { roleSlug, type Role } from './role-resolver.js';
import { DEFAULT_LOCAL_SERVER_ORIGIN } from './server-handshake.js';
import { repositoryDiscoveryFailureMessage } from './repository-identity.js';

interface PlannedRole {
  name: string;
  slug: string;
  isHumanSeat: boolean;
}

interface ExistingPlan {
  cubeId: string;
  cubeName: string;
  template: string;
  roles: PlannedRole[];
}

export interface QuickstartDeps {
  buildAssimilateDeps: () => AssimilateDeps;
  buildLaunchAllDeps: () => LaunchAllDeps;
  readAllProjectIdentities: () => Promise<Array<{ projectPath: string; cube: ActiveCube }>>;
  isTTY: () => boolean;
  prompt: (message: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  runAssimilate?: typeof runAssimilate;
  runLaunchAll?: typeof runLaunchAll;
}

export type QuickstartCancellation = 'declined' | 'interrupted';

export interface QuickstartRunOptions {
  onCancelled?: (kind: QuickstartCancellation) => void;
}

export function buildDefaultQuickstartDeps(): QuickstartDeps {
  const io = buildDefaultAssimilateDeps();
  return {
    buildAssimilateDeps: buildDefaultAssimilateDeps,
    buildLaunchAllDeps: buildDefaultLaunchAllDeps,
    readAllProjectIdentities,
    isTTY: io.isTTY,
    prompt: io.prompt,
    stdout: io.stdout,
    stderr: io.stderr,
  };
}

function plannedTemplateRoles(templateName: string): PlannedRole[] {
  const template = getTemplate(templateName);
  if (!template) return [];
  return template.roles.map((role: TemplateRole) => ({
    name: role.name,
    slug: roleSlug(role.name),
    isHumanSeat: role.is_human_seat === true,
  }));
}

function plannedServerRoles(roles: readonly Role[]): PlannedRole[] {
  return roles.map((role) => ({
    name: role.name,
    slug: roleSlug(role.name),
    isHumanSeat: role.is_human_seat,
  }));
}

function templatePresentation(name: string): { label: string; short_description: string } {
  const found = NEW_CUBE_TEMPLATE_PRESENTATIONS.find((candidate) => candidate.name === name);
  return found ?? { label: name, short_description: '' };
}

function renderTemplateMenu(): string {
  const rows = NEW_CUBE_TEMPLATE_PRESENTATIONS.flatMap((presentation, index) => {
    const words = presentation.short_description.split(/\s+/);
    const lines: string[] = [];
    for (const word of words) {
      const last = lines.at(-1);
      if (!last || `${last} ${word}`.length > 42) lines.push(word);
      else lines[lines.length - 1] = `${last} ${word}`;
    }
    return lines.map((line, lineIndex) => lineIndex === 0
      ? `            ${index + 1}) ${presentation.label.padEnd(22)}${line}`
      : `                                     ${line}`);
  });
  rows[0] = `Template    ${rows[0].trimStart()}`;
  return `${rows.join('\n')}\n`;
}

function reportCancellation(
  kind: QuickstartCancellation,
  deps: QuickstartDeps,
  options: QuickstartRunOptions,
): void {
  if (options.onCancelled) {
    options.onCancelled(kind);
  } else if (kind === 'interrupted') {
    deps.stderr('\nborg quickstart: cancelled before anything was created.\n');
  } else {
    deps.stdout('Cancelled. Nothing was created.\n');
  }
}

async function selectTemplate(
  args: QuickstartArgs,
  deps: QuickstartDeps,
  options: QuickstartRunOptions,
): Promise<string | null> {
  if (args.template) return args.template;
  if (!deps.isTTY()) return NEW_CUBE_TEMPLATE_PRESENTATIONS[0].name;
  deps.stdout(renderTemplateMenu());
  while (true) {
    let answer: string;
    try {
      answer = (await deps.prompt('Choose [1]: ')).trim();
    } catch {
      reportCancellation('interrupted', deps, options);
      return null;
    }
    const index = answer === '' ? 0 : /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
    const selected = NEW_CUBE_TEMPLATE_PRESENTATIONS[index];
    if (selected) return selected.name;
    deps.stdout(`Choose 1-${NEW_CUBE_TEMPLATE_PRESENTATIONS.length}.\n`);
  }
}

function aggregateRequestedRoles(args: QuickstartArgs, available: readonly PlannedRole[]): PlannedRole[] | string {
  if (args.roles.length === 0) return [...available];
  const bySlug = new Map(available.map((role) => [role.slug, role]));
  const requested: PlannedRole[] = [];
  for (const request of args.roles) {
    const role = bySlug.get(request.slug);
    if (!role) return `no role '${request.slug}' exists in this cube; available: ${available.map((item) => item.slug).join(', ')}`;
    for (let i = 0; i < request.count; i += 1) requested.push(role);
  }
  return requested;
}

function renderRoleList(label: string, roles: readonly PlannedRole[]): string {
  const prefix = label.padEnd(12);
  const continuation = ' '.repeat(12);
  const lines: string[] = [];
  for (let index = 0; index < roles.length; index += 1) {
    const token = `${roles[index].slug}${index === roles.length - 1 ? '' : ','}`;
    const candidate = lines.length === 0 ? token : `${lines.at(-1)} ${token}`;
    if (lines.length === 0 || candidate.length <= 64) {
      if (lines.length === 0) lines.push(token);
      else lines[lines.length - 1] = candidate;
    } else {
      lines.push(token);
    }
  }
  return lines.map((line, index) => `${index === 0 ? prefix : continuation}${line}`).join('\n');
}

function affirmative(value: string): boolean {
  const answer = value.trim().toLowerCase();
  return answer === '' || answer === 'y' || answer === 'yes';
}

export async function runQuickstart(
  args: QuickstartArgs,
  deps: QuickstartDeps,
  options: QuickstartRunOptions = {},
): Promise<number> {
  const assimilate = deps.buildAssimilateDeps();
  let context;
  try {
    context = await assimilate.resolveRepositoryContext(assimilate.cwd());
  } catch (error) {
    if (error instanceof Error && error.message === 'BARE_REPOSITORY') {
      context = null;
    } else {
      deps.stderr(
        `borg quickstart: could not inspect this Git repository: ${repositoryDiscoveryFailureMessage(error)}\n`,
      );
      return 1;
    }
  }
  if (!context) {
    deps.stderr('borg quickstart: run this command inside a non-bare Git repository.\n');
    return 1;
  }

  let serverOrigin: string | null = null;
  try {
    serverOrigin = await assimilate.detectLocalServer();
  } catch {
    serverOrigin = null;
  }
  if (!serverOrigin) {
    deps.stderr(
      `borg quickstart: no Borg server is running at ${DEFAULT_LOCAL_SERVER_ORIGIN}.\n` +
      'Start it in another terminal and leave it open:\n' +
      '  borg server start\n' +
      'Then run `borg quickstart` again.\n',
    );
    return 1;
  }

  let connection;
  try {
    connection = await assimilate.connectServer(serverOrigin);
  } catch (error) {
    deps.stderr(`borg quickstart: could not use the Borg server at ${serverOrigin}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let existing: ExistingPlan | null = null;
  try {
    const repository = await assimilate.getRepositoryIdentity(context);
    const saved = await assimilate.getRepositoryAssociation(connection.trustIdentity, repository);
    if (saved) {
      const cube = await assimilate.getCube(serverOrigin, connection.token, saved.cubeId, connection.trustIdentity);
      existing = { cubeId: cube.id, cubeName: cube.name, template: saved.template, roles: plannedServerRoles(cube.roles) };
    } else {
      const resolved = await assimilate.resolveRepositoryCube(
        serverOrigin,
        connection.token,
        { repository, workingRepoName: context.derivedName },
        connection.trustIdentity,
      );
      if (resolved.result === 'resolved') {
        const cube = await assimilate.getCube(serverOrigin, connection.token, resolved.cube_id, connection.trustIdentity);
        existing = { cubeId: cube.id, cubeName: cube.name, template: resolved.template, roles: plannedServerRoles(cube.roles) };
      }
    }
  } catch (error) {
    deps.stderr(`borg quickstart: could not inspect this repository's cube: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  deps.stdout(`Repository  ${context.derivedName}${context.publicRepository ? ` (origin: ${context.publicRepository.value})` : ''}\n`);
  const template = existing?.template ?? await selectTemplate(args, deps, options);
  if (!template) return 130;
  const availableRoles = existing?.roles ?? plannedTemplateRoles(template);
  const humanSeatRole = availableRoles.find((role) => role.isHumanSeat);
  const requested = aggregateRequestedRoles(args, availableRoles);
  if (typeof requested === 'string') {
    deps.stderr(`borg quickstart: ${requested}.\n`);
    return 1;
  }

  // Resolve any multi-CLI choice before the whole-plan confirmation. Every
  // assimilate call then receives the explicit choice and cannot prompt after
  // the operator has approved the plan.
  let selectedCli;
  try {
    selectedCli = await assimilate.resolveCli(undefined);
  } catch (error) {
    deps.stderr(`borg quickstart: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let identities: Array<{ projectPath: string; cube: ActiveCube }> = [];
  try {
    identities = existing ? await deps.readAllProjectIdentities() : [];
  } catch (error) {
    deps.stderr(`borg quickstart: could not read the local drone registry: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const existingByRole = new Map<string, Array<{ projectPath: string; cube: ActiveCube }>>();
  for (const identity of identities) {
    if (identity.cube.cubeId !== existing?.cubeId || !identity.cube.roleName) continue;
    const slug = roleSlug(identity.cube.roleName);
    const list = existingByRole.get(slug) ?? [];
    list.push(identity);
    existingByRole.set(slug, list);
  }

  const usedByRole = new Map<string, number>();
  const targets: Array<{ role: PlannedRole; existing?: { projectPath: string; cube: ActiveCube } }> = [];
  for (const role of requested) {
    const used = usedByRole.get(role.slug) ?? 0;
    const match = existingByRole.get(role.slug)?.[used];
    targets.push({ role, ...(match ? { existing: match } : {}) });
    usedByRole.set(role.slug, used + 1);
  }
  const have = targets.filter((target) => target.existing).map((target) => target.role);
  const missing = targets.filter((target) => !target.existing).map((target) => target.role);

  if (existing) {
    deps.stdout(`Cube        ${existing.cubeName} (existing)\n`);
    if (have.length > 0) deps.stdout(`${renderRoleList('Have', have)}\n`);
    deps.stdout(missing.length > 0
      ? `${renderRoleList('Will create', missing)}\n`
      : 'Will create nothing; every requested drone already exists\n');
  } else {
    deps.stdout(`Cube        ${context.derivedName} (new, template: ${templatePresentation(template).label})\n`);
    deps.stdout(`${renderRoleList('Drones', requested)}\n`);
  }

  if (!args.yes) {
    if (!deps.isTTY()) {
      deps.stderr('borg quickstart: confirmation requires an interactive terminal; rerun with --yes.\n');
      return 1;
    }
    const prompt = existing
      ? 'Continue? [Y/n] '
      : `Create and launch these ${requested.length} ${requested.length === 1 ? 'drone' : 'drones'}? [Y/n] `;
    let answer: string;
    try {
      answer = await deps.prompt(prompt);
    } catch {
      reportCancellation('interrupted', deps, options);
      return 130;
    }
    if (!affirmative(answer)) {
      reportCancellation('declined', deps, options);
      return 0;
    }
  }

  const runAssimilateImpl = deps.runAssimilate ?? runAssimilate;
  for (const target of targets) {
    if (target.existing) continue;
    let prepared: PreparedAssimilation | undefined;
    let diagnostic = '';
    const inner = deps.buildAssimilateDeps();
    let code = 1;
    try {
      code = await runAssimilateImpl({
        role: target.role.slug,
        flags: {
          server: serverOrigin,
          yes: true,
          cubeName: context.derivedName,
          template,
          cli: selectedCli,
        },
      }, {
        ...inner,
        stdout: (text) => { diagnostic += text; },
        stderr: (text) => { diagnostic += text; },
      }, {
        launch: false,
        onPrepared: (value) => { prepared = value; },
      });
    } catch (error) {
      diagnostic += `${error instanceof Error ? error.message : String(error)}\n`;
    }
    const assignedRoleSlug = prepared ? roleSlug(prepared.roleName) : null;
    const roleMismatch = assignedRoleSlug !== null && assignedRoleSlug !== target.role.slug;
    if (code !== 0 || !prepared || roleMismatch) {
      deps.stderr(`✗ ${target.role.slug}\n`);
      if (diagnostic) deps.stderr(diagnostic);
      if (roleMismatch) {
        deps.stderr(
          `borg quickstart: requested ${target.role.slug}, but the server assigned ${assignedRoleSlug}. ` +
          `The assigned drone was kept; it does not fill the requested ${target.role.slug} slot.\n`,
        );
      }
      const completed = targets.filter((item) => item.existing).length;
      const remaining = targets.filter((item) => !item.existing).map((item) => item.role);
      deps.stderr(
        `Stopped. ${completed} of ${requested.length} drones exist; ${remaining.map((role) => role.slug).join(', ')} ${remaining.length === 1 ? 'is' : 'are'} missing.\n` +
        `Fix the cause above, then run \`borg quickstart\` again — it continues from here and does not touch the drones that already exist.\n`,
      );
      return 1;
    }
    target.existing = {
      projectPath: prepared.worktree,
      cube: {
        cubeId: prepared.cubeId,
        droneId: prepared.droneId,
        name: prepared.cubeName,
        droneLabel: prepared.droneLabel,
        apiUrl: serverOrigin,
        sessionToken: '',
        roleName: prepared.roleName,
      },
    };
    deps.stdout(`✓ ${target.role.slug.padEnd(20)}${prepared.worktree}\n`);
  }

  const droneIds = targets.flatMap((target) => target.existing ? [target.existing.cube.droneId] : []);
  const firstTarget = targets.find((target) => target.existing)?.existing?.cube;
  const cubeName = firstTarget?.name ?? existing?.cubeName ?? context.derivedName;
  const cubeId = firstTarget?.cubeId ?? existing?.cubeId;
  if (!cubeId) {
    deps.stderr('borg quickstart: the staffed cube identity could not be confirmed; run `borg quickstart` again.\n');
    return 1;
  }
  deps.stdout(`Launching ${droneIds.length} sessions.\n`);
  let launchOutput = '';
  const launchDeps = deps.buildLaunchAllDeps();
  let launchCode = 1;
  try {
    launchCode = await (deps.runLaunchAll ?? runLaunchAll)(
      { cubeName, flags: { yes: true } },
      {
        ...launchDeps,
        stdout: (text) => { launchOutput += text; },
        stderr: (text) => { launchOutput += text; },
      },
      { droneIds, requireAllRequested: true, targetCube: { cubeId, name: cubeName }, humanSeatLast: true },
    );
  } catch (error) {
    launchOutput += `${error instanceof Error ? error.message : String(error)}\n`;
  }
  if (launchCode !== 0) {
    if (launchOutput) deps.stderr(launchOutput);
    deps.stderr(launchCode === LAUNCH_ALL_NO_DISPATCH_EXIT_CODE
      ? 'No sessions were launched: this environment has no terminal or tmux backend. Run `borg launch-all` to print the commands, then paste them.\n'
      : 'The drones were created, but one or more sessions did not launch. Fix the cause above, then run `borg launch-all`.\n');
    return 1;
  }

  deps.stdout(`✓ Cube \`${cubeName}\` is staffed. ${droneIds.length} ${droneIds.length === 1 ? 'drone' : 'drones'} launched.\n`);
  const human = targets.find((target) => target.role.isHumanSeat && target.existing);
  if (human?.existing) {
    deps.stdout(
      `Start in the ${human.role.slug} session (\`${human.existing.cube.droneLabel}\`) and tell it what\n` +
      'you want built. It dispatches the rest.\n',
    );
  } else if (humanSeatRole) {
    deps.stdout(`Start a ${humanSeatRole.name} session later with: borg assimilate ${humanSeatRole.slug}\n`);
  }
  return 0;
}
