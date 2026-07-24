import { NEW_CUBE_TEMPLATE_PRESENTATIONS, LEGACY_DEFAULT_TEMPLATE_LABEL, } from 'borgmcp-shared/templates';
import { shellEscape } from './shell-escape.js';
export class RepositoryAssociationSaveError extends Error {
    constructor() {
        super('repository association could not be saved');
        this.name = 'RepositoryAssociationSaveError';
    }
}
const NAME_ERROR = 'Use 1-120 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit.';
export function validRepositoryCubeName(value) {
    return Buffer.byteLength(value, 'utf8') <= 120 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value);
}
function presentation(template) {
    if (template === 'default') {
        return { name: template, label: LEGACY_DEFAULT_TEMPLATE_LABEL };
    }
    return NEW_CUBE_TEMPLATE_PRESENTATIONS.find((candidate) => candidate.name === template);
}
async function ask(deps, message) {
    try {
        return { value: await deps.prompt(message) };
    }
    catch (error) {
        if (error instanceof Error && error.name === 'PromptInterruptedError') {
            deps.write('\nCube creation cancelled. Nothing was changed.\n');
            return { stop: 130 };
        }
        deps.write('Input ended before cube creation. Nothing was changed.\n');
        return { stop: 1 };
    }
}
function renderResult(deps, input) {
    const lines = [
        input.existing ? 'Cube already initialized.' : 'Cube created.',
        `  Name: ${input.response.name}`,
        `  Template: ${presentation(input.response.template).label}`,
        `  Repository: ${input.root}`,
        `  Server: ${input.serverOrigin}`,
    ];
    if (input.creationOptionsUnused) {
        lines.push('Creation options were not used because this repository is already initialized.');
    }
    if (input.mode === 'cube-init') {
        lines.push('No drone was created.', `Next: borg assimilate --host ${shellEscape(input.serverOrigin)}`);
    }
    else {
        lines.push('Continuing with role and seat setup...');
    }
    deps.write(`${lines.join('\n')}\n`);
}
export async function initializeRepositoryCube(input, deps) {
    const repository = await deps.getIdentity(input.context);
    const association = await deps.getAssociation(repository);
    const creationOptionsUnused = association !== null && (input.flags.cubeName !== undefined || input.flags.template !== undefined || input.flags.yes === true);
    if (association) {
        const cube = await deps.getCube(association.cubeId);
        const authoritativeAssociation = { ...association, name: cube.name };
        if (cube.name !== association.name) {
            try {
                await deps.saveAssociation(repository, authoritativeAssociation);
            }
            catch {
                throw new RepositoryAssociationSaveError();
            }
        }
        const response = {
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
    deps.write(`Create a cube for this repository\n` +
        `Repository: ${input.context.root}\n` +
        `Server: ${input.serverOrigin}\n`);
    let name = input.flags.cubeName?.trim() ?? input.context.derivedName;
    if (!input.flags.cubeName && deps.isTTY() && !input.flags.yes) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const answer = await ask(deps, `Cube name [${input.context.derivedName}]: `);
            if ('stop' in answer)
                return { kind: 'stop', code: answer.stop };
            name = answer.value.trim() || input.context.derivedName;
            if (validRepositoryCubeName(name))
                break;
            deps.write(`${NAME_ERROR}\n`);
        }
    }
    if (!validRepositoryCubeName(name)) {
        deps.write(`${NAME_ERROR}\n`);
        return { kind: 'stop', code: 1 };
    }
    let template = input.flags.template;
    if (!template && deps.isTTY() && !input.flags.yes) {
        deps.write(`Choose a template:\n` +
            `  1. Software Development (recommended)\n` +
            `     Recommended for code repositories.\n` +
            `  2. Starter\n` +
            `     Minimal roles for general projects.\n`);
        for (let attempt = 0; attempt < 10 && !template; attempt += 1) {
            const answer = await ask(deps, 'Template [1]: ');
            if ('stop' in answer)
                return { kind: 'stop', code: answer.stop };
            const selected = answer.value.trim();
            if (selected === '' || selected === '1')
                template = 'software-dev';
            else if (selected === '2')
                template = 'starter';
            else
                deps.write('Choose 1 or 2.\n');
        }
        if (!template) {
            deps.write('Input ended before cube creation. Nothing was changed.\n');
            return { kind: 'stop', code: 1 };
        }
    }
    template ??= 'software-dev';
    if (deps.isTTY() && !input.flags.yes) {
        deps.write(`Create this cube?\n` +
            `  Name: ${name}\n` +
            `  Template: ${presentation(template).label}\n` +
            `  Repository: ${input.context.root}\n` +
            `  Server: ${input.serverOrigin}\n`);
        let confirmed = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const answer = await ask(deps, 'Create cube? [Y/n]: ');
            if ('stop' in answer)
                return { kind: 'stop', code: answer.stop };
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
        if (!confirmed) {
            deps.write('Input ended before cube creation. Nothing was changed.\n');
            return { kind: 'stop', code: 1 };
        }
    }
    deps.write('Creating cube...\n');
    const workingRepoName = input.context.derivedName;
    const creation = await deps.createCube({ name, workingRepoName, repository, template });
    try {
        await deps.saveAssociation(repository, {
            cubeId: creation.response.cube_id,
            name: creation.response.name,
            workingRepoName: creation.response.working_repo_name,
            template: creation.response.template,
        });
    }
    catch {
        throw new RepositoryAssociationSaveError();
    }
    renderResult(deps, {
        existing: creation.response.result === 'resolved',
        response: creation.response,
        root: input.context.root,
        serverOrigin: input.serverOrigin,
        mode: input.mode,
        creationOptionsUnused: false,
    });
    return { kind: 'success', creation, existing: creation.response.result === 'resolved' };
}
//# sourceMappingURL=repository-cube-init.js.map