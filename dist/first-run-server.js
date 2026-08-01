import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDefaultUpdateDeps, isExactSemver, resolveCompatibleServerTarget, } from './update-cmd.js';
const CLIENT_PACKAGE = 'borgmcp';
const SERVER_PACKAGE = 'borgmcp-server';
const SHARED_PACKAGE = 'borgmcp-shared';
const DEFAULT_CONNECT_COMMAND = 'borg assimilate --host <host>';
const CLIENT_ONBOARDING_ENV = 'BORG_CLIENT_ONBOARDING';
export const HINT_SUPPORTED_FROM = '0.8.1';
function readClientSharedVersion() {
    const here = fileURLToPath(import.meta.url);
    const manifestPath = join(dirname(here), '..', 'package.json');
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('installed borgmcp package manifest is invalid');
    }
    const dependencies = parsed.dependencies;
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
        throw new Error('installed borgmcp dependency manifest is invalid');
    }
    const version = dependencies[SHARED_PACKAGE];
    if (!isExactSemver(version)) {
        throw new Error(`installed ${CLIENT_PACKAGE} does not declare an exact ${SHARED_PACKAGE} pin`);
    }
    return version;
}
function exactInstallCommand(version) {
    return `npm install --global --ignore-scripts ${SERVER_PACKAGE}@${version}`;
}
function assertInstalledServer(installed, published) {
    if (installed?.name !== SERVER_PACKAGE ||
        installed.version !== published.version ||
        installed.sharedVersion !== published.sharedVersion) {
        throw new Error(`installation verification expected ${SERVER_PACKAGE}@${published.version} with ` +
            `${SHARED_PACKAGE}@${published.sharedVersion}`);
    }
}
export function buildDefaultFirstRunServerInstallDeps() {
    const update = buildDefaultUpdateDeps();
    return {
        currentServer: update.currentServer,
        publishedPackage: update.publishedPackage,
        publishedVersions: update.publishedVersions,
        installGlobal: update.installGlobal,
        runServerSetup: (server, options = {}) => new Promise((resolve) => {
            const child = spawn(server.binPath, ['setup'], {
                stdio: 'inherit',
                shell: false,
                env: options.onboardingHint
                    ? { ...process.env, [CLIENT_ONBOARDING_ENV]: '1' }
                    : process.env,
            });
            child.once('error', () => resolve(1));
            child.once('exit', (code) => resolve(code ?? 1));
        }),
        confirm: update.confirm,
        isTTY: update.isTTY,
        stdout: update.stdout,
        stderr: update.stderr,
        clientSharedVersion: readClientSharedVersion,
    };
}
/**
 * Offer the exact compatible server before first-run setup mutates state.
 * Returning anything except `present`/`installed` means no caller-owned setup
 * or assimilation work should continue.
 */
export async function offerFirstRunServerInstall(deps = buildDefaultFirstRunServerInstallDeps(), connectCommand = DEFAULT_CONNECT_COMMAND, options = {}) {
    let installed;
    try {
        installed = await deps.currentServer();
    }
    catch (error) {
        deps.stderr(`The local ${SERVER_PACKAGE} installation could not be verified. No installation was attempted.\n` +
            `Run \`borg server status\` to inspect it, or repair the npm-global installation and run this command again.\n` +
            `${error instanceof Error ? error.message : String(error)}\n`);
        return { kind: 'failed' };
    }
    if (installed) {
        return initializeServerIfRequested(installed, deps, options.initializeServer, 'present', shouldSuppressClientNextSteps(installed.version));
    }
    if (!deps.isTTY()) {
        deps.stderr(`No local ${SERVER_PACKAGE} installation was found. No installation was attempted because this terminal is non-interactive.\n` +
            `Run \`borg setup\` in an interactive terminal, or connect to an existing server with ` +
            `\`${connectCommand}\`.\n`);
        return { kind: 'non-interactive' };
    }
    let target;
    try {
        const sharedVersion = deps.clientSharedVersion();
        target = await resolveCompatibleServerTarget(sharedVersion, deps);
    }
    catch (error) {
        deps.stderr(`Borg could not resolve a compatible local server. No installation was attempted.\n` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            `Run \`borg update\`, then run \`borg setup\` again. Or connect to an existing server with ` +
            `\`${connectCommand}\`.\n`);
        return { kind: 'failed' };
    }
    const command = exactInstallCommand(target.version);
    const decision = await deps.confirm(`No local ${SERVER_PACKAGE} installation was found. ` +
        `Install ${SERVER_PACKAGE}@${target.version}, the local coordination server, ` +
        `which uses ${SHARED_PACKAGE}@${target.sharedVersion}, now?\n` +
        `Command: ${command}\n` +
        `Install it now? [Y/n] `, true);
    if (decision !== 'yes') {
        const reason = decision === 'interrupted'
            ? 'Installation was cancelled by SIGINT.'
            : decision === 'eof'
                ? 'Installation was cancelled because confirmation input ended.'
                : 'Installation was declined.';
        deps.stderr(`${reason} No server package or server state was changed.\n` +
            `To install it later, run \`${command}\`. Then run \`borg server setup\` and \`borg server start\`.\n`);
        return { kind: 'declined' };
    }
    try {
        await deps.installGlobal(SERVER_PACKAGE, target.version, { ignoreScripts: true });
        installed = await deps.currentServer();
        assertInstalledServer(installed, target);
    }
    catch (error) {
        deps.stderr(`The ${SERVER_PACKAGE}@${target.version} installation could not be completed and verified.\n` +
            `${error instanceof Error ? error.message : String(error)}\n` +
            `Run \`${command}\` to retry. Then run \`borg server setup\` and \`borg server start\`.\n`);
        return { kind: 'failed' };
    }
    deps.stdout(`Installed ${SERVER_PACKAGE}@${target.version} with ${SHARED_PACKAGE}@${target.sharedVersion}.\n` +
        (options.initializeServer
            ? `The local server package is ready.\n`
            : `Next, run \`borg server setup\`, then run \`borg server start\` in a terminal you keep open.\n`));
    return initializeServerIfRequested(installed, deps, options.initializeServer, 'installed');
}
async function initializeServerIfRequested(server, deps, requested, kind, suppressClientNextSteps = false) {
    if (!requested)
        return { kind, server, ...(suppressClientNextSteps ? { suppressClientNextSteps: true } : {}) };
    try {
        const exitCode = await deps.runServerSetup(server, { onboardingHint: !suppressClientNextSteps });
        if (exitCode === 0) {
            return { kind, server, ...(suppressClientNextSteps ? { suppressClientNextSteps: true } : {}) };
        }
    }
    catch (error) {
        deps.stderr(`Local server setup could not be completed. ${error instanceof Error ? error.message : String(error)}\n`);
    }
    deps.stderr('Run `borg server setup` to retry local server initialization, then run `borg server start`.\n');
    return { kind: 'failed' };
}
function shouldSuppressClientNextSteps(version) {
    if (!isExactSemver(version))
        return false;
    const installedParts = version.split('.').slice(0, 3).map(Number);
    const supportedParts = HINT_SUPPORTED_FROM.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (installedParts[index] !== supportedParts[index]) {
            return installedParts[index] < supportedParts[index];
        }
    }
    return false;
}
//# sourceMappingURL=first-run-server.js.map