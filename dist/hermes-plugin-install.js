/**
 * `borg representative hermes-plugin install`: copy the Borg-owned Hermes push
 * plugin (hermes-plugin/borg-representative-push) into <Hermes home>/plugins.
 *
 * It only places the plugin's own files. It never edits Hermes config, never
 * enables the plugin and never starts or restarts Hermes: the operator does
 * those steps from the printed snippet.
 */
import { lstat, readFile, stat } from 'node:fs/promises';
import { mkdir, rename, unlink, writeFile } from './guarded-fs.js';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export const HERMES_PLUGIN_NAME = 'borg-representative-push';
/** Exactly the shipped files; nothing else in the source directory is copied. */
export const HERMES_PLUGIN_FILES = ['plugin.yaml', '__init__.py'];
export function packagedHermesPluginDir() {
    return fileURLToPath(new URL(`../hermes-plugin/${HERMES_PLUGIN_NAME}/`, import.meta.url));
}
export function defaultHermesPluginInstallDeps() {
    return {
        env: process.env,
        homedir,
        sourceDir: packagedHermesPluginDir(),
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    };
}
class InstallRefused extends Error {
}
function errnoCode(error) {
    return error?.code;
}
async function lstatOrNull(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (errnoCode(error) === 'ENOENT')
            return null;
        throw error;
    }
}
export function hermesPluginConfigSnippet() {
    return (`plugins:\n` +
        `  enabled:\n` +
        `    - ${HERMES_PLUGIN_NAME}\n` +
        `  entries:\n` +
        `    ${HERMES_PLUGIN_NAME}:\n` +
        `      allow_gateway_injection: true\n` +
        `      settings:\n` +
        `        session_key: "agent:main:<platform>:<chat type>:<chat id>"  # the gateway conversation to wake\n` +
        `        worktree: "<absolute path of the prepared representative worktree>"\n` +
        `mcp_servers:\n` +
        `  borg-representative:\n` +
        `    command: borg\n` +
        `    args: ["representative", "mcp", "--worktree", "<same absolute worktree path>"]\n` +
        `    lazy: true\n`);
}
export async function runHermesPluginInstall(command, deps) {
    try {
        const home = command.hermesHome ?? (deps.env.HERMES_HOME || join(deps.homedir(), '.hermes'));
        if (!isAbsolute(home))
            throw new InstallRefused(`The Hermes home must be an absolute path: ${home}`);
        const homeStat = await stat(home).catch(() => null);
        if (!homeStat?.isDirectory()) {
            throw new InstallRefused(`No Hermes home at ${home}. Install Hermes first, or pass --hermes-home <path>.`);
        }
        const sources = await Promise.all(HERMES_PLUGIN_FILES.map(async (name) => {
            try {
                return { name, content: await readFile(join(deps.sourceDir, name)) };
            }
            catch {
                throw new InstallRefused(`The packaged plugin file ${name} is missing from ${deps.sourceDir}; reinstall borgmcp.`);
            }
        }));
        const pluginsDir = join(home, 'plugins');
        const pluginsStat = await stat(pluginsDir).catch((error) => {
            if (errnoCode(error) === 'ENOENT')
                return null;
            throw error;
        });
        if (pluginsStat && !pluginsStat.isDirectory())
            throw new InstallRefused(`${pluginsDir} is not a directory.`);
        if (!pluginsStat)
            await mkdir(pluginsDir, { mode: 0o755 });
        const target = join(pluginsDir, HERMES_PLUGIN_NAME);
        const existing = await lstatOrNull(target);
        if (existing?.isSymbolicLink()) {
            throw new InstallRefused(`${target} is a symbolic link; remove it yourself before installing.`);
        }
        if (existing && !existing.isDirectory())
            throw new InstallRefused(`${target} exists and is not a directory.`);
        if (existing && !command.force) {
            throw new InstallRefused(`${target} already exists. Pass --force to replace the plugin's files.`);
        }
        if (!existing)
            await mkdir(target, { mode: 0o755 });
        for (const { name, content } of sources) {
            const destination = join(target, name);
            const temporary = join(target, `.${name}.${process.pid}.tmp`);
            // 'wx' refuses to follow or reuse anything already at the temporary path.
            await writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
            try {
                await rename(temporary, destination);
            }
            catch (error) {
                await unlink(temporary).catch(() => { });
                throw error;
            }
        }
        deps.stdout(`${existing ? 'Replaced' : 'Installed'} the Hermes plugin ${HERMES_PLUGIN_NAME} in ${target}.\n\n` +
            `Hermes config was not changed. Add the following to ${join(home, 'config.yaml')}\n` +
            `(\`hermes plugins enable ${HERMES_PLUGIN_NAME}\` covers the enabled list only):\n\n` +
            hermesPluginConfigSnippet() +
            `\nThen:\n` +
            `- session_key must name a messaging-gateway conversation (for example your Telegram DM). A Hermes\n` +
            `  Desktop chat cannot be woken: Hermes injects plugin messages only into gateway conversations.\n` +
            `- Any Hermes process may read and deliver; Borg stops waking for a reply once it is delivered.\n` +
            `- Restart the gateway (\`hermes gateway restart\`) so it loads the plugin.\n` +
            `Details: docs/HUMAN_REPRESENTATIVE.md, section "Hermes push plugin".\n`);
        return 0;
    }
    catch (error) {
        const message = error instanceof InstallRefused ? error.message : `Install failed: ${error instanceof Error ? error.message : String(error)}`;
        deps.stderr(`${message}\n`);
        return 1;
    }
}
//# sourceMappingURL=hermes-plugin-install.js.map