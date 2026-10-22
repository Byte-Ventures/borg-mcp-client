import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import which from 'which';
export class OpenCodeInstallationError extends Error {
    code = 'OPENCODE_INSTALLATION';
}
export class OpenCodeExecutableChangedError extends Error {
    code = 'OPENCODE_EXECUTABLE_CHANGED';
    constructor() {
        super('OpenCode changed during startup. No prompt was submitted; relaunch Borg to use the updated installation.');
    }
}
/** Both published formats exist: `1.19.3` and `opencode v2.1.2`. */
export function parseOpenCodeVersion(output) {
    const match = /^(?:opencode\s+v?)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(output.trim());
    if (!match)
        throw new OpenCodeInstallationError('Could not read the OpenCode version. Run `opencode --version` and check the installation.');
    const [major, minor, patch] = match.slice(1, 4).map(Number);
    if (![major, minor, patch].every(Number.isSafeInteger) || (major !== 1 && major !== 2)) {
        throw new OpenCodeInstallationError('This OpenCode major version is not supported by Borg.');
    }
    return {
        version: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}`,
        major,
        minor,
        patch,
        prerelease: match[4] ?? null,
    };
}
const defaultDeps = {
    resolveExecutable: (env) => realpathSync(which.sync('opencode', { path: env.PATH })),
    readVersion: (executable, env) => execFileSync(executable, ['--version'], {
        env,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 16_384,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    }),
};
/** No global cache: an upgrade or PATH change is observed on the next launch. */
export function inspectOpenCodeInstallation(env = process.env, deps = defaultDeps) {
    let executable;
    let output;
    try {
        executable = deps.resolveExecutable(env);
        output = deps.readVersion(executable, env);
    }
    catch {
        // Child errors can contain stdout/stderr and environment values. Report a
        // fixed diagnostic instead of copying those details into launch output.
        throw new OpenCodeInstallationError('Could not inspect the installed OpenCode CLI. Run `opencode --version` and check your PATH.');
    }
    return { ...parseOpenCodeVersion(output), executable };
}
export function verifyOpenCodeServerVersion(installation, version) {
    if (typeof version !== 'string')
        throw new OpenCodeExecutableChangedError();
    let actual;
    try {
        actual = parseOpenCodeVersion(version);
    }
    catch {
        throw new OpenCodeExecutableChangedError();
    }
    if (actual.version !== installation.version)
        throw new OpenCodeExecutableChangedError();
}
//# sourceMappingURL=opencode-installation.js.map