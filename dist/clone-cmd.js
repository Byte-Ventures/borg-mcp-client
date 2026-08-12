import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCloneCredentials, redactCloneSecrets } from './clone-security.js';
import { buildDefaultQuickstartDeps, runQuickstart } from './quickstart-cmd.js';
import { shellEscape } from './shell-escape.js';
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ALLOWED_SCHEMES = new Set(['file:', 'git:', 'git+ssh:', 'http:', 'https:', 'ssh:']);
const SCP_REMOTE_RE = /^[^@\s/:]+@[^:\s]+:[^\s]+$/;
function defaultRunSync(cmd, args, cwd) {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
    };
}
export function buildDefaultCloneDeps() {
    return {
        cwd: () => process.cwd(),
        chdir: (path) => process.chdir(path),
        runSync: defaultRunSync,
        pathExists: existsSync,
        isDirectory: (path) => {
            try {
                return statSync(path).isDirectory();
            }
            catch {
                return false;
            }
        },
        readDirectory: (path) => readdirSync(path),
        createDirectory: (path) => {
            mkdirSync(dirname(path), { recursive: true });
            try {
                mkdirSync(path);
                return true;
            }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
                    return false;
                throw error;
            }
        },
        removeTree: (path) => rmSync(path, { recursive: true, force: true }),
        quickstart: async (cwd) => {
            process.chdir(cwd);
            return runQuickstart({ roles: [], yes: false }, buildDefaultQuickstartDeps());
        },
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
    };
}
export function validateCloneRepositoryUrl(value) {
    if (!value || value.trim() !== value || /\s/.test(value) || CONTROL_RE.test(value)) {
        return { ok: false, error: 'repository URL contains whitespace or control characters' };
    }
    if (value.startsWith('-'))
        return { ok: false, error: 'repository URL must not start with a hyphen' };
    if (hasCloneCredentials(value)) {
        return { ok: false, error: 'credential-bearing repository URLs are not accepted; use a credential helper or SSH configuration instead' };
    }
    if (SCP_REMOTE_RE.test(value))
        return { ok: true };
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1];
    if (!scheme)
        return { ok: true }; // Local path.
    if (!value.toLowerCase().startsWith(`${scheme.toLowerCase()}://`) && scheme.toLowerCase() !== 'file') {
        return { ok: false, error: 'repository URL is not a supported hierarchical URL' };
    }
    try {
        const parsed = new URL(value);
        if (!ALLOWED_SCHEMES.has(parsed.protocol))
            return { ok: false, error: `unsupported repository URL scheme ${parsed.protocol}` };
        if (parsed.search || parsed.hash)
            return { ok: false, error: 'repository URLs with query strings or fragments are not accepted' };
        if (parsed.protocol !== 'file:' && !parsed.hostname)
            return { ok: false, error: 'repository URL must include a host' };
        if (!parsed.pathname || parsed.pathname === '/')
            return { ok: false, error: 'repository URL must include a repository path' };
        return { ok: true };
    }
    catch {
        return { ok: false, error: 'repository URL is not valid' };
    }
}
function sourceName(value) {
    let leaf = value;
    try {
        const parsed = new URL(value);
        leaf = parsed.protocol === 'file:' ? fileURLToPath(parsed) : parsed.pathname;
    }
    catch {
        if (SCP_REMOTE_RE.test(value))
            leaf = value.slice(value.indexOf(':') + 1);
    }
    const name = basename(leaf.replace(/\/+$/, '')).replace(/\.git$/i, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return name || 'repository';
}
function remoteKey(value, base) {
    if (SCP_REMOTE_RE.test(value)) {
        const colon = value.indexOf(':');
        const login = value.slice(0, colon);
        const at = login.lastIndexOf('@');
        const user = login.slice(0, at);
        const host = login.slice(at + 1).toLowerCase();
        return `ssh://${user}@${host}/${value.slice(colon + 1).replace(/\/+$/, '').replace(/\.git$/i, '')}`;
    }
    try {
        const parsed = new URL(value);
        if (parsed.protocol === 'file:')
            return `file:${resolve(fileURLToPath(parsed))}`;
        const user = parsed.username ? `${parsed.username}@` : '';
        const port = parsed.port ? `:${parsed.port}` : '';
        return `${parsed.protocol}//${user}${parsed.hostname.toLowerCase()}${port}${parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '')}`;
    }
    catch {
        return `file:${resolve(base, value)}`;
    }
}
function readOrigin(deps, directory) {
    const result = deps.runSync('git', ['remote', 'get-url', 'origin'], directory);
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
function repositoryAt(deps, directory) {
    return deps.runSync('git', ['rev-parse', '--is-inside-work-tree'], directory).status === 0;
}
function validateDestination(value) {
    if (!value || value.trim() !== value || CONTROL_RE.test(value) || value.startsWith('-') || hasCloneCredentials(value)) {
        return 'destination contains an unsafe path value';
    }
    return null;
}
function chooseDestination(deps, args) {
    const base = deps.cwd();
    if (args.destination !== undefined) {
        const error = validateDestination(args.destination);
        return error ? { error } : { path: resolve(base, args.destination) };
    }
    const name = sourceName(args.repositoryUrl);
    for (let n = 1; n < 10_000; n += 1) {
        const candidate = resolve(base, n === 1 ? name : `${name}-${n}`);
        if (!deps.pathExists(candidate))
            return { path: candidate };
        if (deps.isDirectory(candidate) && repositoryAt(deps, candidate)) {
            const origin = readOrigin(deps, candidate);
            if (origin && !hasCloneCredentials(origin) && remoteKey(origin, candidate) === remoteKey(args.repositoryUrl, base)) {
                return { path: candidate };
            }
            if (n === 1)
                return { error: `existing checkout at ${candidate} points at another remote; choose an explicit destination` };
        }
    }
    return { error: `could not find a collision-safe destination for ${name}` };
}
export async function runClone(args, rawDeps) {
    const deps = {
        ...rawDeps,
        stdout: (text) => rawDeps.stdout(redactCloneSecrets(text)),
        stderr: (text) => rawDeps.stderr(redactCloneSecrets(text)),
    };
    const valid = validateCloneRepositoryUrl(args.repositoryUrl);
    if (!valid.ok) {
        deps.stderr(`borg clone: ${valid.error}.\n`);
        return 1;
    }
    const selected = chooseDestination(deps, args);
    if ('error' in selected) {
        deps.stderr(`borg clone: ${selected.error}.\n`);
        return 1;
    }
    const destination = selected.path;
    let cloned = false;
    const destinationExisted = deps.pathExists(destination);
    const emptyDestination = destinationExisted && deps.isDirectory(destination) && deps.readDirectory(destination).length === 0;
    if (destinationExisted && !emptyDestination) {
        if (!deps.isDirectory(destination) || !repositoryAt(deps, destination)) {
            deps.stderr(`borg clone: destination ${destination} exists and is not a Git checkout; it was left untouched.\n`);
            return 1;
        }
        const origin = readOrigin(deps, destination);
        if (!origin || hasCloneCredentials(origin)) {
            deps.stderr(`borg clone: the existing checkout has no safe, readable origin remote; it was left untouched.\n`);
            return 1;
        }
        if (remoteKey(origin, destination) !== remoteKey(args.repositoryUrl, deps.cwd())) {
            deps.stderr(`borg clone: remote mismatch at ${destination}; existing ${origin}, requested ${args.repositoryUrl}. The checkout was left untouched.\n`);
            return 1;
        }
        deps.stdout(`Reusing existing checkout at ${destination}; its origin remote matches.\n`);
    }
    else {
        const createdDestination = destinationExisted ? false : deps.createDirectory(destination);
        if (!destinationExisted && !createdDestination) {
            deps.stderr(`borg clone: destination ${destination} appeared while preparing the clone; it was left untouched. Retry with another directory.\n`);
            return 1;
        }
        const result = deps.runSync('git', ['clone', '--', args.repositoryUrl, destination], deps.cwd());
        if (result.status !== 0) {
            if (createdDestination && deps.pathExists(destination)) {
                deps.removeTree(destination);
            }
            deps.stderr(`borg clone: clone failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}.\n` +
                `Rollback: ${destinationExisted
                    ? `the pre-existing empty destination ${destination} was preserved; inspect it for partial Git files`
                    : deps.pathExists(destination) ? `partial checkout remains at ${destination}` : `the directory borg created at ${destination} was removed`}.\n`);
            return 1;
        }
        cloned = true;
        deps.stdout(`Cloned ${sourceName(args.repositoryUrl)} into ${destination}.\n`);
    }
    if (args.noLaunch) {
        deps.stdout(`Checkout ready at ${destination}. No cube or drone was created.\n` +
            `Next: cd ${shellEscape(destination)} && borg quickstart\n`);
        return 0;
    }
    deps.chdir(destination);
    const code = await deps.quickstart(destination);
    if (code !== 0) {
        deps.stderr(`The checkout${cloned ? '' : ' you already had'} is ready at ${destination}, but quickstart did not finish. ` +
            `It was left untouched; cd there and run \`borg quickstart\` again.\n`);
    }
    return code;
}
//# sourceMappingURL=clone-cmd.js.map