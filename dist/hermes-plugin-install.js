/**
 * `borg representative hermes-plugin install | uninstall` and `activateHermesPlugin()`
 * (run by `borg update`): one command sets up the Borg-owned Hermes push plugin.
 *
 * Every Hermes config change goes through Hermes's documented CLI
 * (`hermes config set|get|unset`, `hermes plugins enable`), run with execFile and
 * never a shell, with one explicit HERMES_HOME. After each write the value is read
 * back with `hermes config get <key> --json --raw` and must deep-equal the intended
 * value. Before the first write, config.yaml is copied to a backup
 * (O_EXCL|O_NOFOLLOW, 0600) kept for manual recovery. A failed run reverses only
 * Borg's own keys, one by one through the Hermes CLI, and restores a key only
 * when it still held Borg's value at the check.
 *
 * Borg's manifest `<home>/plugins/borg-representative-push/plugin.yaml` is the
 * install marker: `borg update` activates only an install and never creates one.
 * An activation record in Borg's config marks config that the gateway has not
 * yet been seen to load, so a rerun finishes the job.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, open, rename, rmdir, unlink, writeFile } from './guarded-fs.js';
import { borgConfigRoot } from './private-root.js';
import { validatePrivateDirectory } from './representative-db.js';
import { shellEscape } from './shell-escape.js';
import { isRepresentativeUuid } from './representative-store.js';
export const HERMES_PLUGIN_NAME = 'borg-representative-push';
/** Exactly the shipped files; nothing else in the source directory is copied. */
export const HERMES_PLUGIN_FILES = ['plugin.yaml', '__init__.py'];
export const HERMES_MCP_SERVER_NAME = 'borg-representative';
export const SESSION_KEY_PATTERN = /^agent:main:[a-z0-9_-]{1,32}:dm:[A-Za-z0-9_.:@+=-]{1,128}$/;
export const BACKUPS_KEPT = 5;
const SESSIONS_MAX_BYTES = 1024 * 1024;
const HERMES_TIMEOUT_MS = 120_000;
const HERMES_OUTPUT_MAX = 4 * 1024 * 1024;
const ENTRY_KEY = `plugins.entries.${HERMES_PLUGIN_NAME}`;
const KEYS = {
    enabled: 'plugins.enabled',
    disabled: 'plugins.disabled',
    injection: `${ENTRY_KEY}.allow_gateway_injection`,
    sessionKey: `${ENTRY_KEY}.settings.session_key`,
    worktree: `${ENTRY_KEY}.settings.worktree`,
    borgCommand: `${ENTRY_KEY}.settings.borg_command`,
    mcp: `mcp_servers.${HERMES_MCP_SERVER_NAME}`,
};
/** 5.x plugin settings that v2 no longer reads. */
export const LEGACY_SETTING_KEYS = ['mcp_server', 'reinject_after_s', 'max_reinjects']
    .map((name) => `${ENTRY_KEY}.settings.${name}`);
export function packagedHermesPluginDir() {
    return fileURLToPath(new URL(`../hermes-plugin/${HERMES_PLUGIN_NAME}/`, import.meta.url));
}
/** Environment switches that open the gateway to everyone (Hermes user-guide/security.md). */
function allowAllEnvName(name) {
    return /^(?:[A-Z0-9_]+_)?ALLOW_ALL_USERS$/.test(name);
}
/**
 * execFile, never a shell. The allow-all switches are removed from the child
 * environment so `config get` reports Hermes's own `.env`, not this shell.
 */
export function execFileHermesCli(command, home, env, options = {}) {
    const childEnv = {};
    for (const [name, value] of Object.entries(env)) {
        if (!allowAllEnvName(name))
            childEnv[name] = value;
    }
    childEnv.HERMES_HOME = home;
    return (argv) => new Promise((resolve) => {
        execFile(command, [...argv], {
            env: childEnv,
            // A hard timeout kills only this child `hermes` process, never a gateway.
            timeout: options.timeoutMs ?? HERMES_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            maxBuffer: HERMES_OUTPUT_MAX,
            windowsHide: true,
            encoding: 'utf8',
        }, (error, stdout, stderr) => {
            const timedOut = error?.killed === true;
            const code = error ? (typeof error.code === 'number' ? error.code : timedOut ? 124 : 127) : 0;
            const detail = timedOut
                ? `${stderr}timed out after ${Math.round((options.timeoutMs ?? HERMES_TIMEOUT_MS) / 1000)} s\n`
                : error && typeof error.code !== 'number' ? `${stderr}${error.message}\n` : stderr;
            resolve({ code, stdout, stderr: detail });
        });
    });
}
export function defaultBorgCommand() {
    return process.argv[1];
}
export function defaultHermesPluginDeps() {
    return {
        env: process.env,
        homedir,
        sourceDir: packagedHermesPluginDir(),
        hermes: (home) => execFileHermesCli('hermes', home, process.env),
        borgCommand: defaultBorgCommand,
        bindings: async () => {
            const { createRepresentativeStore } = await import('./representative-store.js');
            const store = createRepresentativeStore();
            if (await store.initialized())
                return (await store.listBindings()).map((binding) => binding.worktree);
            const { previewLegacyImport } = await import('./representative-legacy.js');
            return (await previewLegacyImport()).map((binding) => binding.worktree);
        },
        isTTY: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
        prompt: async (question) => {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            return new Promise((resolve) => {
                let answered = false;
                rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer); });
                rl.once('close', () => { if (!answered)
                    resolve(null); });
            });
        },
        now: () => new Date(),
        activation: fileActivationStore(),
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    };
}
export class HermesPluginError extends Error {
    commands;
    /**
     * @param commands retry commands inside the message. They are printed with
     *   their exact bytes (shell-quoted, for an exact round-trip); every other
     *   line is display text and is cleaned when printed.
     */
    constructor(message, commands = []) {
        super(message);
        this.commands = commands;
    }
}
/**
 * Stderr text from an error: each line cleaned of control, C1 and bidi
 * characters (a config value or a Hermes reply can carry them), except the
 * error's own retry commands, which keep their exact shell-quoted bytes.
 */
function printableMessage(message, commands = []) {
    const exact = new Set(commands);
    return message.split('\n').map((line) => (exact.has(line.trim()) ? line : printableUntrusted(line, 4096))).join('\n');
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
/**
 * A worktree path as display text: control, C1 and bidi characters removed.
 * Retry commands still carry the exact path, shell-quoted.
 */
function shownPath(path) {
    return printableUntrusted(path, 4096);
}
/** Control, C1 and bidirectional-override characters are removed before anything untrusted is printed. */
export function printableUntrusted(text, max = 80) {
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
export function resolveHermesHome(explicit, deps) {
    const home = explicit ?? (deps.env.HERMES_HOME || join(deps.homedir(), '.hermes'));
    if (!isAbsolute(home))
        throw new HermesPluginError(`The Hermes home must be an absolute path: ${home}`);
    return home;
}
async function requireHermesHome(home) {
    const homeStat = await lstatOrNull(home);
    if (!homeStat?.isDirectory()) {
        throw new HermesPluginError(`No Hermes home at ${home}. Install Hermes first, or pass --hermes-home <path>.`);
    }
}
// ---------------------------------------------------------------------------
// Hermes config through the documented CLI
const ABSENT = Symbol('absent');
/**
 * Hermes may print its own startup maintenance before the command's output
 * (`hermes config get --json` prints one `json.dumps` line), so the value is the
 * last non-empty line.
 */
function parseGetOutput(key, stdout) {
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1);
    if (last === undefined)
        throw new HermesPluginError(`\`hermes config get ${key}\` printed nothing.`);
    try {
        return JSON.parse(last);
    }
    catch {
        throw new HermesPluginError(`\`hermes config get ${key} --json\` did not print JSON.`);
    }
}
function describeFailure(argv, result) {
    const detail = printableUntrusted(result.stderr.trim().split(/\r?\n/).at(-1) ?? '', 300);
    return `\`hermes ${argv.join(' ')}\` failed (exit ${result.code})${detail ? `: ${detail}` : ''}`;
}
/** The value text for `hermes config set`: containers and booleans as JSON, strings raw. */
export function configSetText(value) {
    if (typeof value === 'string') {
        // Hermes parses a value that starts with `[`/`{`, spans lines or reads as a
        // scalar word/number; such a string would not round-trip.
        if (value.length === 0 || /[\r\n]/.test(value) || /^[[{]/.test(value)) {
            throw new HermesPluginError(`Refusing to write a value Hermes would reinterpret: ${JSON.stringify(value)}`);
        }
        return value;
    }
    return JSON.stringify(value);
}
class HermesConfig {
    cli;
    constructor(cli) {
        this.cli = cli;
    }
    async get(key) {
        const argv = ['config', 'get', key, '--json', '--raw'];
        const result = await this.cli(argv);
        if (result.code === 0)
            return parseGetOutput(key, result.stdout);
        if (result.stderr.includes('Config key not set'))
            return ABSENT;
        throw new HermesPluginError(describeFailure(argv, result));
    }
    async run(argv) {
        const result = await this.cli(argv);
        if (result.code !== 0)
            throw new HermesPluginError(describeFailure(argv, result));
    }
    /** The value Hermes holds after a set must be exactly the intended one. */
    async verifySet(key, value) {
        const actual = await this.get(key);
        if (actual === ABSENT || !isDeepStrictEqual(actual, value)) {
            throw new HermesPluginError(`Hermes stored ${key} as ${actual === ABSENT ? 'nothing' : JSON.stringify(actual)}, not ${JSON.stringify(value)}.`);
        }
    }
    /** `config unset` on a key that is already absent is success. */
    async unset(key) {
        const argv = ['config', 'unset', key];
        const result = await this.cli(argv);
        if (result.code !== 0 && !result.stderr.includes('Config key not set')) {
            throw new HermesPluginError(describeFailure(argv, result));
        }
    }
    async verifyUnset(key) {
        if ((await this.get(key)) !== ABSENT)
            throw new HermesPluginError(`Hermes still holds ${key} after unset.`);
    }
}
// ---------------------------------------------------------------------------
// config.yaml backup and per-key rollback
async function readConfigBytes(path) {
    const st = await lstatOrNull(path);
    if (!st)
        return null;
    if (!st.isFile())
        throw new HermesPluginError(`${path} is not a regular file; nothing was changed.`);
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
/**
 * A directory Borg owns: created 0700; an existing one must be a real
 * directory owned by this user. The mode is set through a descriptor opened
 * with O_DIRECTORY|O_NOFOLLOW and checked with fstat, so a path swapped for a
 * symlink after a check is never followed.
 */
async function ensurePrivateDir(path) {
    if (!await lstatOrNull(path))
        await mkdir(path, { mode: 0o700 });
    let handle;
    try {
        handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    }
    catch (error) {
        throw new HermesPluginError(`${path} is not a directory (${errnoCode(error) ?? 'unreadable'}); nothing was changed.`);
    }
    try {
        const st = await handle.stat();
        if (!st.isDirectory())
            throw new HermesPluginError(`${path} is not a directory; nothing was changed.`);
        if (!ownedByMe(st.uid))
            throw new HermesPluginError(`${path} is not owned by this user; nothing was changed.`);
        // mkdir's mode is filtered by the umask; an existing directory may be wider.
        if ((st.mode & 0o777) !== 0o700)
            await handle.chmod(0o700);
    }
    finally {
        await handle.close();
    }
}
/** A directory Borg shares with Hermes: created 0700 when missing, otherwise only checked. */
async function ensureRealDir(path) {
    const st = await lstatOrNull(path);
    if (!st) {
        await mkdir(path, { mode: 0o700 });
        return;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new HermesPluginError(`${path} is not a directory; nothing was changed.`);
    }
}
function stamp(now) {
    return now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}
/**
 * Borg's writes to Hermes config. Before the first write config.yaml is copied
 * to a backup, kept only as a manual recovery copy: it is never restored
 * automatically. A failed run reverses Borg's own keys one by one through the
 * Hermes CLI, and restores a key only when it still held Borg's value at the
 * check; a key that differed then, and every other key, is left as it is.
 *
 * Accepted residual (Coordinator decision 350da38d): the check and the
 * reversal are two Hermes CLI calls. Hermes's own config write
 * (hermes_cli/config.py set_config_value: read, change, write back, no lock or
 * compare) cannot make them one, so an edit to the same key between them is
 * not detected. Borg's forward writes have the same interval with any
 * concurrent writer; Borg claims no more than its host's only write primitive.
 */
class ConfigTransaction {
    home;
    config;
    now;
    backup = null;
    undo = [];
    /** The plugin's entry before this run; when it was absent, a rollback leaves no empty entry behind. */
    entryBefore = ABSENT;
    constructor(home, config, now) {
        this.home = home;
        this.config = config;
        this.now = now;
    }
    get backupPath() {
        return this.backup;
    }
    get wrote() {
        return this.undo.length > 0;
    }
    async begin() {
        if (this.backup)
            return;
        this.entryBefore = await this.config.get(ENTRY_KEY);
        const original = await readConfigBytes(join(this.home, 'config.yaml'));
        const backupsRoot = join(this.home, 'backups');
        const dir = join(backupsRoot, 'borg-representative');
        await ensureRealDir(backupsRoot);
        await ensurePrivateDir(dir);
        for (let attempt = 0;; attempt += 1) {
            const path = join(dir, `config.yaml.${stamp(this.now())}${attempt ? `-${attempt}` : ''}`);
            try {
                const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
                try {
                    await handle.writeFile(original ?? Buffer.alloc(0));
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                this.backup = path;
                break;
            }
            catch (error) {
                if (errnoCode(error) !== 'EEXIST' || attempt >= 20)
                    throw error;
            }
        }
        await pruneBackups(dir);
    }
    async set(key, value) {
        await this.begin();
        const before = await this.config.get(key);
        // Recorded before the command: a failed command may still have written.
        this.undo.push({ kind: 'key', key, before, wrote: value });
        await this.config.run(['config', 'set', key, configSetText(value)]);
        await this.config.verifySet(key, value);
    }
    async unset(key) {
        await this.begin();
        const before = await this.config.get(key);
        this.undo.push({ kind: 'key', key, before, wrote: ABSENT });
        await this.config.unset(key);
        await this.config.verifyUnset(key);
    }
    async enablePlugin() {
        await this.begin();
        const enabled = await this.config.get(KEYS.enabled);
        const disabled = await this.config.get(KEYS.disabled);
        this.undo.push({
            kind: 'enable',
            addedToEnabled: !(Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME)),
            removedFromDisabled: Array.isArray(disabled) && disabled.includes(HERMES_PLUGIN_NAME),
        });
        await this.config.run(['plugins', 'enable', HERMES_PLUGIN_NAME]);
        const after = await this.config.get(KEYS.enabled);
        if (!Array.isArray(after) || !after.includes(HERMES_PLUGIN_NAME)) {
            throw new HermesPluginError(`${KEYS.enabled} does not list ${HERMES_PLUGIN_NAME} after \`hermes plugins enable\`.`);
        }
    }
    /** Reverse Borg's writes, newest first. Returns what was reversed and what was left. */
    async rollback() {
        const reversed = [];
        const left = [];
        for (const step of [...this.undo].reverse()) {
            try {
                if (step.kind === 'enable') {
                    await this.reverseEnable(step, reversed, left);
                    continue;
                }
                const current = await this.config.get(step.key);
                const stillOurs = step.wrote === ABSENT ? current === ABSENT : current !== ABSENT && isDeepStrictEqual(current, step.wrote);
                if (!stillOurs) {
                    // It did not hold Borg's value at the check (unchanged by a failed command, or changed since): left as it is.
                    if (!(step.before === ABSENT ? current === ABSENT : current !== ABSENT && isDeepStrictEqual(current, step.before))) {
                        left.push(`${step.key} (changed outside this run)`);
                    }
                    continue;
                }
                if (step.before === ABSENT) {
                    await this.config.unset(step.key);
                    await this.config.verifyUnset(step.key);
                }
                else {
                    await this.config.run(['config', 'set', step.key, configSetText(step.before)]);
                    await this.config.verifySet(step.key, step.before);
                }
                reversed.push(step.key);
            }
            catch (error) {
                left.push(`${step.kind === 'key' ? step.key : KEYS.enabled} (${error instanceof Error ? error.message : String(error)})`);
            }
        }
        if (this.undo.length > 0 && this.entryBefore === ABSENT && left.length === 0) {
            try {
                const entry = await this.config.get(ENTRY_KEY);
                if (entry !== ABSENT && onlyEmptyMappings(entry)) {
                    await this.config.unset(ENTRY_KEY);
                    await this.config.verifyUnset(ENTRY_KEY);
                }
            }
            catch (error) {
                left.push(`${ENTRY_KEY} (${error instanceof Error ? error.message : String(error)})`);
            }
        }
        return { reversed, left };
    }
    async reverseEnable(step, reversed, left) {
        if (step.addedToEnabled) {
            const enabled = await this.config.get(KEYS.enabled);
            if (Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME)) {
                const remaining = enabled.filter((name) => name !== HERMES_PLUGIN_NAME);
                await this.config.run(['config', 'set', KEYS.enabled, configSetText(remaining)]);
                await this.config.verifySet(KEYS.enabled, remaining);
                reversed.push(KEYS.enabled);
            }
        }
        if (step.removedFromDisabled) {
            const disabled = await this.config.get(KEYS.disabled);
            const list = Array.isArray(disabled) ? disabled : [];
            if (!list.includes(HERMES_PLUGIN_NAME)) {
                const restored = [...list, HERMES_PLUGIN_NAME];
                await this.config.run(['config', 'set', KEYS.disabled, configSetText(restored)]);
                await this.config.verifySet(KEYS.disabled, restored);
                reversed.push(KEYS.disabled);
            }
            else {
                left.push(`${KEYS.disabled} (already lists the plugin)`);
            }
        }
    }
}
/** A mapping that holds nothing but (nested) empty mappings: what unsetting its leaves leaves behind. */
function onlyEmptyMappings(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        Object.values(value).every(onlyEmptyMappings);
}
async function pruneBackups(dir) {
    const names = (await readdir(dir)).filter((name) => /^config\.yaml\.\d{8}T\d{9}Z(?:-\d+)?$/.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) {
        const path = join(dir, name);
        const st = await lstatOrNull(path);
        if (st?.isFile())
            await unlink(path);
    }
}
// ---------------------------------------------------------------------------
// Activation state: desired generations and the generation confirmed loaded
/** The digest of an uninstall: nothing of Borg's in Hermes. */
export const ABSENT_GENERATION = 'absent';
const RECORD_MAX_BYTES = 4096;
const DIGEST = /^(?:absent|[0-9a-f]{64})$/;
/** A gateway identity is a positive integer PID; anything else is unknown. */
export function validPid(value) {
    return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? value : null;
}
export const activationPending = (record) => record === null || record.activated !== record.desired.id;
const ownedByMe = (uid) => typeof process.getuid !== 'function' || uid === process.getuid();
function parseRecord(text, home) {
    const untrusted = {
        version: 3, hermes_home: home, desired: { id: 'untrusted', digest: 'untrusted', gateway_pid: null }, activated: null, desktop_reload: false,
    };
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return untrusted;
    }
    const desired = value.desired;
    const valid = value.version === 3 && value.hermes_home === home &&
        desired !== null && typeof desired === 'object' &&
        isRepresentativeUuid(desired.id) && typeof desired.digest === 'string' && DIGEST.test(desired.digest) &&
        (desired.gateway_pid === null || validPid(desired.gateway_pid) !== null) &&
        (value.activated === null || isRepresentativeUuid(value.activated)) &&
        typeof value.desktop_reload === 'boolean';
    // Malformed content never confirms anything: it reads as pending with no known gateway identity.
    return valid ? value : untrusted;
}
/**
 * The activation records, under `<borg config>/hermes-plugin`. The directory
 * and every ancestor from the Borg home root are checked with the reviewed S1
 * walk (validatePrivateDirectory), on reads as well as writes; the record is
 * opened O_NOFOLLOW|O_NONBLOCK (a FIFO or device never blocks) and must fstat
 * as a regular file owned by this user, mode 0600, at most 4 KiB.
 */
export function fileActivationStore() {
    const dir = () => join(borgConfigRoot(), 'hermes-plugin');
    const pathFor = (home) => join(dir(), `${createHash('sha256').update(home).digest('hex')}.json`);
    const privateDir = async (create) => {
        try {
            return await validatePrivateDirectory(dir(), create);
        }
        catch (error) {
            throw new HermesPluginError(`Unsafe Borg state path: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
        }
    };
    return {
        read: async (home) => {
            if (!await privateDir(false))
                return null;
            const path = pathFor(home);
            let handle;
            try {
                handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
            }
            catch (error) {
                if (errnoCode(error) === 'ENOENT')
                    return null;
                throw new HermesPluginError(`Unsafe Borg state file ${path} (${errnoCode(error) ?? 'unreadable'}). Nothing was changed.`);
            }
            try {
                const st = await handle.stat();
                if (!st.isFile() || !ownedByMe(st.uid) || (st.mode & 0o777) !== 0o600 || st.size > RECORD_MAX_BYTES) {
                    throw new HermesPluginError(`Unsafe Borg state file ${path}: it must be a regular file owned by you, mode 0600, at most ${RECORD_MAX_BYTES} bytes. Nothing was changed.`);
                }
                return parseRecord((await handle.readFile()).toString('utf8'), home);
            }
            finally {
                await handle.close();
            }
        },
        write: async (record) => {
            await privateDir(true);
            const path = pathFor(record.hermes_home);
            const temporary = `${path}.${process.pid}.tmp`;
            const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
            try {
                await handle.writeFile(`${JSON.stringify(record)}\n`);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                await rename(temporary, path);
            }
            catch (error) {
                await unlink(temporary).catch(() => { });
                throw error;
            }
            await syncDirectory(dir());
        },
        clear: async (home) => {
            if (!await privateDir(false))
                return;
            const path = pathFor(home);
            const st = await lstatOrNull(path);
            if (st?.isFile()) {
                await unlink(path);
                await syncDirectory(dir());
            }
        },
    };
}
async function syncDirectory(dir) {
    const handle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
// ---------------------------------------------------------------------------
// Plugin files
async function readSources(sourceDir) {
    return Promise.all(HERMES_PLUGIN_FILES.map(async (name) => {
        try {
            return { name, content: await readFile(join(sourceDir, name)) };
        }
        catch {
            throw new HermesPluginError(`The packaged plugin file ${name} is missing from ${sourceDir}; reinstall borgmcp.`);
        }
    }));
}
export function hermesPluginDir(home) {
    return join(home, 'plugins', HERMES_PLUGIN_NAME);
}
/**
 * The install marker is Borg's own manifest, `<plugin dir>/plugin.yaml`, as a
 * regular file. A directory without it (for example one uninstall left because
 * it holds other files) is not an install, and `borg update` never touches it.
 */
async function installState(home) {
    const target = hermesPluginDir(home);
    const st = await lstatOrNull(target);
    if (!st)
        return 'absent';
    if (st.isSymbolicLink())
        throw new HermesPluginError(`${target} is a symbolic link; remove it yourself, then rerun.`);
    if (!st.isDirectory())
        throw new HermesPluginError(`${target} exists and is not a directory.`);
    const manifest = await lstatOrNull(join(target, 'plugin.yaml'));
    if (manifest && !manifest.isFile())
        throw new HermesPluginError(`${join(target, 'plugin.yaml')} is not a regular file.`);
    return manifest ? 'installed' : 'directory-only';
}
async function snapshotPluginFiles(target) {
    const snapshot = new Map();
    for (const name of HERMES_PLUGIN_FILES) {
        const path = join(target, name);
        const st = await lstatOrNull(path);
        if (st && !st.isFile())
            throw new HermesPluginError(`${path} is not a regular file.`);
        snapshot.set(name, st ? await readFile(path) : null);
    }
    return snapshot;
}
async function writePluginFile(target, name, content) {
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
/** Python's bytecode cache for the plugin module: `__pycache__/__init__.<tag>.pyc`. */
const PLUGIN_BYTECODE = /^__init__\.[A-Za-z0-9_.-]+\.pyc$/;
/**
 * Remove Borg's files: `__init__.py`, its bytecode cache, then `plugin.yaml`
 * (the marker) last, then the directory when nothing else is left in it.
 * Anything else is kept, and a directory without `plugin.yaml` is no install.
 */
async function removePluginFiles(target) {
    const init = join(target, '__init__.py');
    if ((await lstatOrNull(init))?.isFile())
        await unlink(init);
    const cache = join(target, '__pycache__');
    const cacheStat = await lstatOrNull(cache);
    if (cacheStat?.isDirectory() && !cacheStat.isSymbolicLink()) {
        for (const name of await readdir(cache)) {
            if (PLUGIN_BYTECODE.test(name) && (await lstatOrNull(join(cache, name)))?.isFile())
                await unlink(join(cache, name));
        }
        await rmdir(cache).catch((error) => {
            if (errnoCode(error) !== 'ENOTEMPTY' && errnoCode(error) !== 'EEXIST')
                throw error;
        });
    }
    const manifest = join(target, 'plugin.yaml');
    if ((await lstatOrNull(manifest))?.isFile())
        await unlink(manifest);
    try {
        await rmdir(target);
        return 'removed';
    }
    catch (error) {
        if (errnoCode(error) === 'ENOTEMPTY' || errnoCode(error) === 'EEXIST')
            return 'kept-other-files';
        throw error;
    }
}
export async function discoverSessionKeys(home) {
    const path = join(home, 'sessions', 'sessions.json');
    const st = await lstatOrNull(path);
    if (!st || !st.isFile() || st.size > SESSIONS_MAX_BYTES)
        return 'unavailable';
    let parsed;
    try {
        // O_NONBLOCK: a FIFO swapped in after the lstat never blocks; fstat then refuses it.
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.size > SESSIONS_MAX_BYTES)
                return 'unavailable';
            parsed = JSON.parse((await handle.readFile()).toString('utf8'));
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return 'unavailable';
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return 'unavailable';
    const candidates = [];
    for (const [key, entry] of Object.entries(parsed)) {
        if (!SESSION_KEY_PATTERN.test(key))
            continue;
        const record = entry && typeof entry === 'object' ? entry : {};
        const origin = record.origin && typeof record.origin === 'object' ? record.origin : {};
        const name = [record.display_name, origin.chat_name, origin.user_name].find((value) => typeof value === 'string' && value.trim());
        candidates.push({ sessionKey: key, label: printableUntrusted(typeof name === 'string' ? name : '') });
    }
    return candidates.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}
function describeCandidate(candidate) {
    return `${candidate.sessionKey}${candidate.label ? `  (${candidate.label})` : ''}`;
}
/**
 * Plan: the conversations this run could wake, without asking. Borg never
 * picks one without the operator's confirmation (design rev 2 §6): on a
 * gateway that allows several users, the only DM in sessions.json can be
 * someone else's.
 * - `--session-key`, or the key already configured, is the one choice, used as given.
 * - Otherwise the discovered DMs, to be confirmed at a terminal once every
 *   check has passed; without a terminal (including `borg update`) selectPlan
 *   refuses, naming them and the exact command with --session-key.
 * - A dry run shows a single candidate as the one install would ask about.
 */
async function planSessions(home, configured, explicit, dryRun) {
    if (explicit !== undefined)
        return [{ sessionKey: explicit, label: '', source: '--session-key' }];
    if (typeof configured === 'string' && SESSION_KEY_PATTERN.test(configured)) {
        return [{ sessionKey: configured, label: '', source: 'kept from the current plugin settings' }];
    }
    const candidates = await discoverSessionKeys(home);
    if (candidates === 'unavailable' || candidates.length === 0) {
        throw new HermesPluginError(`No gateway DM conversation was found in ${join(home, 'sessions', 'sessions.json')}. ` +
            'Message your Hermes bot once from your own DM, then rerun, or pass --session-key agent:main:<platform>:dm:<chat id>.');
    }
    if (dryRun && candidates.length === 1) {
        return [{ ...candidates[0], source: 'the only gateway DM conversation; install asks you to confirm it' }];
    }
    return candidates;
}
/** Without a terminal the conversation is never chosen: refused with the exact commands. */
function refuseUnconfirmedSession(candidates, retry) {
    const commands = candidates.map((candidate) => retry(candidate.sessionKey));
    throw new HermesPluginError(`Borg does not choose the conversation to wake without your confirmation. Gateway DM conversations found:\n` +
        `${listCandidates(candidates)}Run install with the one that is yours, for example:\n` +
        commands.map((command) => `  ${command}\n`).join('').trimEnd(), commands);
}
function listCandidates(candidates) {
    return candidates.map((candidate, index) => `  ${index + 1}. ${describeCandidate(candidate)}\n`).join('');
}
/** A numbered choice at the terminal; anything else refuses with nothing changed. */
async function promptChoice(deps, question, choices, none) {
    const answer = await deps.prompt(`${question} [1-${choices.length}] `);
    const index = answer === null ? Number.NaN : Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= choices.length)
        throw new HermesPluginError(none);
    return choices[index];
}
/**
 * Validate: the complete write set of every candidate (worktree x conversation)
 * is built as data and checked with planProblems, the same checks `config set`
 * applies. A worktree or conversation is selectable only when a valid plan
 * uses it; the others are shown with their reason. When nothing is selectable
 * the run refuses, before any question.
 */
function validateCandidates(worktrees, sessions, borgCommand) {
    const verdicts = new Map();
    for (const worktree of worktrees) {
        const perSession = new Map();
        for (const session of sessions) {
            const problems = planProblems({ worktree, sessionKey: session.sessionKey, borgCommand });
            perSession.set(session, problems.length === 0 ? null : problems.map((problem) => `${problem.key}: ${problem.reason}`).join('; '));
        }
        verdicts.set(worktree, perSession);
    }
    const selectable = worktrees.filter((worktree) => [...verdicts.get(worktree).values()].some((problem) => problem === null));
    const excluded = worktrees.filter((worktree) => !selectable.includes(worktree))
        .map((worktree) => ({ worktree, reason: [...verdicts.get(worktree).values()][0] ?? 'no valid conversation' }));
    return {
        worktrees: selectable,
        excluded,
        valid: (worktree) => sessions.filter((session) => verdicts.get(worktree)?.get(session) === null),
    };
}
/**
 * Plan, validate, ask. Every candidate plan is checked before the first
 * question; the questions offer only valid candidates: the worktree when
 * several are selectable, then the conversation, confirmed with [y/N] (the
 * default is no). Nothing has been written when a question is asked.
 */
async function selectPlan(deps, interactive, worktrees, sessions, borgCommand, retry) {
    const validated = validateCandidates(worktrees, sessions, borgCommand);
    const notSelectable = validated.excluded.map(({ worktree, reason }) => `  - ${shownPath(worktree)} (not selectable: ${printableUntrusted(reason, 300)})\n`).join('');
    if (validated.worktrees.length === 0) {
        throw new HermesPluginError(`No prepared worktree can be installed; nothing was changed:\n${notSelectable.trimEnd()}`);
    }
    if (validated.worktrees.length > 1 && !interactive) {
        const commands = validated.worktrees.map((path) => retry.worktree(path));
        throw new HermesPluginError(`Several representative worktrees are prepared. Run install with the one to use:\n` +
            commands.map((command) => `  ${command}\n`).join('') +
            (notSelectable ? `Not selectable:\n${notSelectable}` : '').trimEnd(), commands);
    }
    let worktree;
    if (validated.worktrees.length > 1) {
        deps.stdout(`Prepared representative worktrees:\n${validated.worktrees.map((path, index) => `  ${index + 1}. ${shownPath(path)}\n`).join('')}` +
            (notSelectable ? `Not selectable:\n${notSelectable}` : ''));
        worktree = await promptChoice(deps, 'Use which worktree?', validated.worktrees, 'No worktree was chosen; nothing was changed.');
    }
    else {
        worktree = validated.worktrees[0];
        if (notSelectable)
            deps.stdout(`Using the only selectable worktree, ${shownPath(worktree)}. Not selectable:\n${notSelectable}`);
    }
    const offered = validated.valid(worktree);
    const fixed = offered.find((session) => session.source !== undefined);
    if (fixed)
        return { worktree, sessionKey: fixed.sessionKey, source: fixed.source };
    if (!interactive)
        refuseUnconfirmedSession(offered, retry.sessionKey);
    deps.stdout(`Gateway DM conversations found in Hermes (confirm that it is your own DM):\n${listCandidates(offered)}`);
    const chosen = offered.length > 1
        ? await promptChoice(deps, 'Wake which conversation?', offered, 'No conversation was chosen; nothing was changed.')
        : offered[0];
    const confirm = await deps.prompt(`Wake ${describeCandidate(chosen)} for Borg Coordinator replies? [y/N] `);
    if (confirm === null || !/^(?:y|yes)$/i.test(confirm.trim())) {
        throw new HermesPluginError('The conversation was not confirmed; nothing was changed.');
    }
    return { worktree, sessionKey: chosen.sessionKey, source: 'confirmed by you' };
}
/**
 * The write-side refusals that existing state decides, checked read only
 * before any question (the same tests the writes apply again when they run):
 * - `<home>/plugins` is a symlink or not a directory (when the plugin is created);
 * - `<home>/config.yaml` exists and is not a regular file (the backup reads it);
 * - `<home>/backups` is a symlink or not a directory;
 * - `<home>/backups/borg-representative` is a symlink, not a directory, or not
 *   owned by this user (a wrong mode is repaired, not refused).
 * The plugin directory and its files, the Hermes home, the packaged plugin, the
 * worktree, the conversation, the borg path and the activation record path
 * (S1's validator, through the record read) are checked earlier. What can still
 * refuse after a question depends on the run itself: a Hermes CLI reply or
 * read-back, and a file-system write that fails.
 */
function preflightWrites(home, createsPluginDir) {
    const stat = (path) => {
        try {
            return lstatSync(path);
        }
        catch (error) {
            if (errnoCode(error) === 'ENOENT')
                return null;
            throw error;
        }
    };
    if (createsPluginDir) {
        const plugins = stat(join(home, 'plugins'));
        if (plugins && (plugins.isSymbolicLink() || !plugins.isDirectory())) {
            throw new HermesPluginError(`${join(home, 'plugins')} is not a directory.`);
        }
    }
    const config = stat(join(home, 'config.yaml'));
    if (config && !config.isFile()) {
        throw new HermesPluginError(`${join(home, 'config.yaml')} is not a regular file; nothing was changed.`);
    }
    const backups = join(home, 'backups');
    const backupsStat = stat(backups);
    if (backupsStat && (backupsStat.isSymbolicLink() || !backupsStat.isDirectory())) {
        throw new HermesPluginError(`${backups} is not a directory; nothing was changed.`);
    }
    const ours = join(backups, 'borg-representative');
    const oursStat = backupsStat ? stat(ours) : null;
    if (oursStat && (oursStat.isSymbolicLink() || !oursStat.isDirectory())) {
        throw new HermesPluginError(`${ours} is not a directory; nothing was changed.`);
    }
    if (oursStat && !ownedByMe(oursStat.uid)) {
        throw new HermesPluginError(`${ours} is not owned by this user; nothing was changed.`);
    }
}
// ---------------------------------------------------------------------------
// Worktree from the representative binding state
/**
 * Plan: the worktrees this run could use, without asking. Read only: the
 * installer never creates representative state, on any path. `--worktree`, or
 * the configured one while it is still bound, is the one candidate.
 */
async function planWorktrees(explicit, configured, deps) {
    const worktrees = await deps.bindings();
    if (explicit !== undefined) {
        if (!worktrees.includes(explicit)) {
            throw new HermesPluginError(`${shownPath(explicit)} is not a prepared representative worktree. Prepared: ${worktrees.map(shownPath).join(', ') || 'none'}.`);
        }
        return [explicit];
    }
    if (typeof configured === 'string' && worktrees.includes(configured))
        return [configured];
    if (worktrees.length === 0) {
        throw new HermesPluginError('No representative connection is prepared. Run `borg representative prepare --coordinator <drone-label>` first.');
    }
    return worktrees;
}
// ---------------------------------------------------------------------------
// Open-gateway report (reported, never refused)
function truthy(value) {
    if (value === true || value === 1)
        return true;
    return typeof value === 'string' && ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}
export function platformOf(sessionKey) {
    return sessionKey.split(':')[2] ?? '';
}
async function openGatewaySwitches(config, platform, env) {
    const envNames = ['GATEWAY_ALLOW_ALL_USERS', `${platform.toUpperCase().replace(/-/g, '_')}_ALLOW_ALL_USERS`];
    const open = [];
    for (const key of ['gateway.allow_all_users', 'allow_all_users', ...envNames]) {
        const value = await config.get(key);
        if (value !== ABSENT && truthy(value))
            open.push(key);
    }
    for (const name of envNames) {
        if (truthy(env[name]))
            open.push(`${name} (this shell's environment)`);
    }
    return open;
}
function openGatewayReport(switches) {
    return switches.length === 0
        ? 'Gateway access: no allow-all switch is set; Hermes allowlists and pairing decide who can message the bot.\n'
        : `Open gateway (${switches.join(', ')}): anyone who can message the bot can read Coordinator replies and send as the representative.\n`;
}
function mcpEntry(target) {
    return { command: target.borgCommand, args: ['representative', 'mcp', '--worktree', target.worktree], lazy: true };
}
/**
 * The plan's write set as data: every value Borg writes with `config set`. It
 * is the one list configSteps writes and planProblems validates.
 */
export function managedWrites(target) {
    return [
        [KEYS.sessionKey, target.sessionKey],
        [KEYS.worktree, target.worktree],
        [KEYS.borgCommand, target.borgCommand],
        [KEYS.injection, true],
        [KEYS.mcp, mcpEntry(target)],
    ];
}
/**
 * Validate: every check a plan's writes apply, run on data before any
 * question. It calls the same functions the writes call: configSetText for
 * each value (which ConfigTransaction.set applies), the DM grammar and the
 * absolute borg path. Empty when the plan is valid.
 */
export function planProblems(target) {
    const problems = [];
    if (!SESSION_KEY_PATTERN.test(target.sessionKey))
        problems.push({ key: KEYS.sessionKey, reason: 'not a gateway DM key' });
    if (!isAbsolute(target.borgCommand))
        problems.push({ key: KEYS.borgCommand, reason: `the borg executable path is not absolute: ${target.borgCommand}` });
    for (const [key, value] of managedWrites(target)) {
        try {
            configSetText(value);
        }
        catch (error) {
            problems.push({ key, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return problems;
}
const DESKTOP_ADDED = 'Hermes Desktop: new chats get the Borg tools.\n';
const DESKTOP_RELOAD = 'Hermes Desktop: run /reload-mcp in each open chat, or restart Hermes Desktop, to use the updated Borg tools. ' +
    'Borg does not restart Desktop and cannot confirm this step.\n';
async function configSteps(config, target) {
    const steps = [];
    const setIfDifferent = async (key, value) => {
        const current = await config.get(key);
        if (current !== ABSENT && isDeepStrictEqual(current, value))
            return;
        // Display text: the value's JSON with control and bidi characters removed (the write keeps the exact value).
        steps.push({ describe: `set ${key} = ${printableUntrusted(JSON.stringify(value), 8192)}`, apply: (tx) => tx.set(key, value) });
    };
    let mcp = null;
    for (const [key, value] of managedWrites(target)) {
        if (key === KEYS.injection) {
            // The 5.x settings go before the gateway permission, as before.
            for (const legacy of LEGACY_SETTING_KEYS) {
                if ((await config.get(legacy)) !== ABSENT)
                    steps.push({ describe: `unset ${legacy}`, apply: (tx) => tx.unset(legacy) });
            }
        }
        if (key === KEYS.mcp) {
            const current = await config.get(KEYS.mcp);
            mcp = current === ABSENT ? 'added' : isDeepStrictEqual(current, value) ? null : 'changed';
        }
        await setIfDifferent(key, value);
    }
    const enabled = await config.get(KEYS.enabled);
    const disabled = await config.get(KEYS.disabled);
    const listed = Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME);
    const blocked = Array.isArray(disabled) && disabled.includes(HERMES_PLUGIN_NAME);
    if (!listed || blocked) {
        steps.push({ describe: `hermes plugins enable ${HERMES_PLUGIN_NAME}`, apply: (tx) => tx.enablePlugin() });
    }
    return { steps, mcp };
}
/**
 * The gateway's supervision state from the documented `hermes gateway status`
 * ("Show service status"). Its text is not a machine contract, so only the
 * positive service-managed lines count as supervised; anything unrecognised is
 * `unknown`, and Borg never restarts an unknown gateway.
 */
export function parseGatewayStatus(stdout) {
    const launchd = stdout.match(/Gateway is supervised by launchd \(PID (\d+)\)/);
    if (launchd)
        return { kind: 'service', pid: launchd[1] };
    if (/gateway service is running/i.test(stdout)) {
        return { kind: 'service', pid: stdout.match(/Main PID:\s*(\d+)/)?.[1] ?? null };
    }
    if (/Running manually, not as a system service/.test(stdout)) {
        return { kind: 'manual', pid: stdout.match(/Gateway is running \(PID: (\d+)\)/)?.[1] ?? null };
    }
    if (/Gateway is running via the default-profile multiplexer/.test(stdout))
        return { kind: 'multiplexed' };
    if (/Gateway is not running|gateway service is stopped|Gateway service is not loaded/i.test(stdout))
        return { kind: 'stopped' };
    return { kind: 'unknown' };
}
async function gatewaySupervision(cli) {
    const result = await cli(['gateway', 'status']);
    return result.code === 0 ? parseGatewayStatus(result.stdout) : { kind: 'unknown' };
}
const gatewayPid = (state) => state.kind === 'service' || state.kind === 'manual' ? validPid(state.pid) : null;
const RESTART_PLAN = 'hermes gateway restart, only when the gateway runs as a launchd/systemd service';
/**
 * Make the running gateway load (or unload) the desired generation. It is
 * restarted only when `gateway status` shows it service-managed, and the
 * restart counts only when both the old and the new PID are valid and differ.
 * Without a service, `hermes gateway restart` would run a gateway in the
 * foreground under this process, so Borg prints the command instead; a
 * hand-started gateway counts as reloaded once its PID is valid and differs
 * from the PID sampled when this generation was written. An unknown identity
 * never counts as a change.
 */
async function activateHosts(cli, deps, verb, writtenWithPid) {
    const before = await gatewaySupervision(cli);
    const command = `\`hermes gateway restart\` where the gateway runs`;
    switch (before.kind) {
        case 'stopped':
            deps.stdout(`The Hermes gateway is not running; it will ${verb} the plugin when it starts.\n`);
            return 'complete';
        case 'manual': {
            const current = gatewayPid(before);
            if (validPid(writtenWithPid) !== null && current !== null && current !== writtenWithPid) {
                deps.stdout(`The hand-started Hermes gateway was restarted since this change was written (PID ${current}).\n`);
                return 'complete';
            }
            deps.stdout(`Action needed: the Hermes gateway was started by hand (not as a service), so Borg does not restart it. Run ${command} to ${verb} the plugin.\n`);
            return 'action-needed';
        }
        case 'multiplexed':
            deps.stdout(`Action needed: this profile's gateway runs inside the default profile's gateway, so Borg does not restart it. Run ${command} to ${verb} the plugin.\n`);
            return 'action-needed';
        case 'unknown':
            deps.stdout(`Action needed: \`hermes gateway status\` did not show a service-managed gateway, so Borg does not restart it. Run ${command} to ${verb} the plugin.\n`);
            return 'action-needed';
        case 'service':
            break;
    }
    deps.stdout('Running `hermes gateway restart` (service-managed gateway).\n');
    const restart = await cli(['gateway', 'restart']);
    if (restart.code !== 0) {
        deps.stderr(`${describeFailure(['gateway', 'restart'], restart)}. Run ${command} to ${verb} the plugin.\n`);
        return 'failed';
    }
    const oldPid = gatewayPid(before);
    const after = await gatewaySupervision(cli);
    const newPid = gatewayPid(after);
    if (after.kind !== 'service' || oldPid === null || newPid === null || newPid === oldPid) {
        deps.stderr(`The gateway restart is unconfirmed: \`hermes gateway status\` did not show a new PID ` +
            `(before ${oldPid ?? 'unknown'}, after ${newPid ?? 'unknown'}). Check it, or run ${command}.\n`);
        return 'failed';
    }
    deps.stdout(`The Hermes gateway restarted (PID ${oldPid} -> ${newPid}).\n`);
    return 'complete';
}
/**
 * The generation of what install writes: a digest of Borg's plugin files and
 * managed keys. Equal generations mean nothing Borg manages changed.
 */
function desiredGeneration(sources, target) {
    const files = Object.fromEntries(sources.map(({ name, content }) => [name, createHash('sha256').update(content).digest('hex')]));
    const managed = {
        files,
        [KEYS.sessionKey]: target.sessionKey,
        [KEYS.worktree]: target.worktree,
        [KEYS.borgCommand]: target.borgCommand,
        [KEYS.injection]: true,
        [KEYS.mcp]: mcpEntry(target),
        [KEYS.enabled]: HERMES_PLUGIN_NAME,
    };
    return createHash('sha256').update(JSON.stringify(managed)).digest('hex');
}
/**
 * Start a new desired generation for a write: a fresh id, so no earlier
 * confirmation (even of the same content) can stand for it, and the gateway
 * identity sampled now, never inherited from an earlier generation.
 */
async function beginGeneration(cli, home, digest, previous, desktopReload) {
    return {
        version: 3,
        hermes_home: home,
        desired: { id: randomUUID(), digest, gateway_pid: gatewayPid(await gatewaySupervision(cli)) },
        activated: previous?.activated ?? null,
        desktop_reload: desktopReload,
    };
}
/** Finish the host step for a record; the record is kept as written unless the step is confirmed. */
async function finishGeneration(cli, deps, record, noRestart, verb, rerun) {
    if (noRestart) {
        deps.stdout(`Restart skipped (--no-restart); the activation stays pending. Run \`${rerun}\` without --no-restart to finish it.\n`);
        return 0;
    }
    const outcome = await activateHosts(cli, deps, verb, record.desired.gateway_pid);
    if (outcome === 'complete') {
        if (record.desired.digest === ABSENT_GENERATION)
            await deps.activation.clear(record.hermes_home);
        else
            await deps.activation.write({ ...record, activated: record.desired.id });
        return 0;
    }
    deps.stdout(`The activation stays pending; after that, rerun \`${rerun}\` to finish it.\n`);
    return outcome === 'failed' ? 1 : 0;
}
const INSTALL_COMMAND = 'borg representative hermes-plugin install';
/**
 * An install command for the operator to run: built from the selectors of the
 * current invocation (--hermes-home when one was given, --worktree when one
 * was given) plus the given session key, every value shell-quoted.
 */
export function installCommand(selectors) {
    return [
        INSTALL_COMMAND,
        ...(selectors.hermesHome !== undefined ? ['--hermes-home', shellEscape(selectors.hermesHome)] : []),
        ...(selectors.worktree !== undefined ? ['--worktree', shellEscape(selectors.worktree)] : []),
        ...(selectors.sessionKey !== undefined ? ['--session-key', shellEscape(selectors.sessionKey)] : []),
    ].join(' ');
}
/** The uninstall command for the same Hermes home, shell-quoted. */
export function uninstallCommand(hermesHome) {
    return ['borg representative hermes-plugin uninstall', ...(hermesHome !== undefined ? ['--hermes-home', shellEscape(hermesHome)] : [])].join(' ');
}
async function activate(home, options, deps) {
    const cli = deps.hermes(home);
    const config = new HermesConfig(cli);
    const target = hermesPluginDir(home);
    const state = await installState(home);
    if (state !== 'installed' && !options.mayCreate)
        return 0;
    // Read-only preflight first, so a static refusal never follows a Hermes call or a question.
    preflightWrites(home, state === 'absent');
    const previous = await deps.activation.read(home);
    const sources = await readSources(deps.sourceDir);
    const before = state === 'absent' ? new Map() : await snapshotPluginFiles(target);
    const staleFiles = sources.filter(({ name, content }) => !before.get(name)?.equals(content)).map(({ name }) => name);
    const configuredSessionKey = await config.get(KEYS.sessionKey);
    const configuredWorktree = await config.get(KEYS.worktree);
    // Every check that can refuse runs before any question, and every question
    // before the first write. The lookups are read only: the installer never
    // creates representative state (mcp/listen import it on first use).
    const interactive = deps.isTTY() && !options.dryRun;
    // Plan the candidates, validate every candidate's write set, then ask.
    const borgCommand = deps.borgCommand();
    const worktrees = await planWorktrees(options.explicitWorktree, configuredWorktree, deps);
    const sessions = await planSessions(home, configuredSessionKey, options.explicitSessionKey, options.dryRun);
    const { worktree, sessionKey, source } = await selectPlan(deps, interactive, worktrees, sessions, borgCommand, {
        worktree: (path) => installCommand({
            ...options.invocation, worktree: path,
            ...(options.explicitSessionKey !== undefined ? { sessionKey: options.explicitSessionKey } : {}),
        }),
        sessionKey: (key) => installCommand({ ...options.invocation, sessionKey: key }),
    });
    const wanted = { sessionKey, worktree, borgCommand };
    const { steps, mcp } = await configSteps(config, wanted);
    const gateway = await openGatewaySwitches(config, platformOf(sessionKey), deps.env);
    const desired = desiredGeneration(sources, wanted);
    const summary = `Hermes home:  ${home}\n` +
        `Conversation: ${sessionKey} (${source})\n` +
        `Worktree:     ${shownPath(worktree)}\n` +
        `borg:         ${shownPath(borgCommand)}\n`;
    if (state === 'installed' && staleFiles.length === 0 && steps.length === 0) {
        // Active only when the confirmed generation is the one that wrote this exact content.
        const active = previous !== null && previous.desired.digest === desired && previous.activated === previous.desired.id;
        if (active && !previous.desktop_reload) {
            deps.stdout(`${summary}The Hermes plugin ${HERMES_PLUGIN_NAME} is installed, configured and active; nothing was changed.\n${openGatewayReport(gateway)}`);
            return 0;
        }
        if (options.dryRun) {
            deps.stdout(`${summary}Dry run; nothing was changed. The configuration is in place` +
                `${active ? '.' : `; the activation is pending: ${RESTART_PLAN}.`}\n${openGatewayReport(gateway)}`);
            return 0;
        }
        // The entry is unchanged, so a Desktop reload step from an earlier run is no longer reported.
        if (active) {
            await deps.activation.write({ ...previous, desktop_reload: false });
            deps.stdout(`${summary}The Hermes plugin ${HERMES_PLUGIN_NAME} is installed, configured and active; nothing was changed.\n${openGatewayReport(gateway)}`);
            return 0;
        }
        // A pending generation of this exact content keeps its id and write-time identity (a retry of the
        // same write); anything else, including config found already in place, starts a generation now.
        const record = previous !== null && previous.desired.digest === desired
            ? { ...previous, desktop_reload: false }
            : await beginGeneration(cli, home, desired, previous, false);
        await deps.activation.write(record);
        deps.stdout(`${summary}The configuration is already in place; finishing the pending activation.\n${openGatewayReport(gateway)}`);
        return finishGeneration(cli, deps, record, options.noRestart, 'load', installCommand(options.invocation));
    }
    const plan = [
        ...(state === 'absent' ? [`create ${target}`] : []),
        ...staleFiles.map((name) => `write ${join(target, name)}`),
        ...steps.map((step) => step.describe),
        ...(options.noRestart ? [] : [RESTART_PLAN]),
    ];
    if (options.dryRun) {
        deps.stdout(`${summary}Dry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${openGatewayReport(gateway)}`);
        return 0;
    }
    deps.stdout(`${summary}Steps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);
    // The new generation is recorded before the first write: a crash from here on leaves a rerun that finishes the job.
    const record = await beginGeneration(cli, home, desired, previous, mcp === 'changed');
    await deps.activation.write(record);
    const tx = new ConfigTransaction(home, config, deps.now);
    let createdDir = false;
    const written = [];
    try {
        if (state === 'absent') {
            const plugins = join(home, 'plugins');
            const pluginsStat = await lstatOrNull(plugins);
            if (pluginsStat && (pluginsStat.isSymbolicLink() || !pluginsStat.isDirectory())) {
                throw new HermesPluginError(`${plugins} is not a directory.`);
            }
            if (!pluginsStat)
                await mkdir(plugins, { mode: 0o755 });
            await mkdir(target, { mode: 0o755 });
            createdDir = true;
        }
        // __init__.py first and plugin.yaml (the marker) last: an interrupted copy is never an install.
        for (const name of ['__init__.py', 'plugin.yaml']) {
            const source = sources.find((file) => file.name === name);
            if (!staleFiles.includes(name))
                continue;
            await writePluginFile(target, name, source.content);
            written.push(name);
        }
        for (const step of steps)
            await step.apply(tx);
    }
    catch (error) {
        await reportFailure(error, tx, deps, async () => {
            if (createdDir) {
                await removePluginFiles(target);
            }
            else {
                for (const name of [...written].reverse()) {
                    const prior = before.get(name);
                    if (prior)
                        await writePluginFile(target, name, prior);
                    else
                        await unlink(join(target, name)).catch(() => { });
                }
            }
            // Everything was reversed: the previous generation is current again.
            if (previous)
                await deps.activation.write(previous);
            else
                await deps.activation.clear(home);
        });
        return 1;
    }
    deps.stdout(`${createdDir ? 'Installed' : 'Updated'} the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
        `${tx.backupPath ? ` Backup of config.yaml (for manual recovery): ${tx.backupPath}` : ''}\n`);
    deps.stdout(openGatewayReport(gateway));
    if (mcp === 'added')
        deps.stdout(DESKTOP_ADDED);
    if (mcp === 'changed')
        deps.stdout(DESKTOP_RELOAD);
    return finishGeneration(cli, deps, record, options.noRestart, 'load', installCommand(options.invocation));
}
/**
 * A failed run reverses Borg's own keys (never a whole-file restore) and then
 * its plugin files, but only when every key could be reversed.
 */
async function reportFailure(error, tx, deps, restoreFiles) {
    const message = error instanceof Error ? error.message : String(error);
    let outcome = '';
    try {
        const { reversed, left } = await tx.rollback();
        if (reversed.length > 0)
            outcome += `Reversed: ${reversed.join(', ')}.\n`;
        if (left.length > 0) {
            outcome += `Left as they are: ${left.join('; ')}.\n`;
        }
        else {
            await restoreFiles();
        }
        if (!tx.wrote)
            outcome += 'No Hermes config was changed.\n';
    }
    catch (rollbackError) {
        outcome += `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.\n`;
    }
    if (tx.backupPath)
        outcome += `config.yaml as it was before this run: ${tx.backupPath}\n`;
    // A rollback's "left" reasons can quote config values and Hermes replies.
    deps.stderr(`${printableMessage(`${message}\n${outcome}`)}`);
}
function failure(error, deps, prefix) {
    const message = error instanceof HermesPluginError ? error.message : `${prefix} failed: ${error instanceof Error ? error.message : String(error)}`;
    deps.stderr(`${printableMessage(message, error instanceof HermesPluginError ? error.commands : [])}\n`);
    return 1;
}
export async function runHermesPluginInstall(command, deps) {
    try {
        const home = resolveHermesHome(command.hermesHome, deps);
        await requireHermesHome(home);
        return await activate(home, {
            ...(command.worktree ? { explicitWorktree: command.worktree } : {}),
            ...(command.sessionKey ? { explicitSessionKey: command.sessionKey } : {}),
            invocation: {
                ...(command.hermesHome !== undefined ? { hermesHome: command.hermesHome } : {}),
                ...(command.worktree !== undefined ? { worktree: command.worktree } : {}),
            },
            dryRun: command.dryRun,
            noRestart: command.noRestart,
            mayCreate: true,
        }, deps);
    }
    catch (error) {
        return failure(error, deps, 'Install');
    }
}
/**
 * `borg update`: activate the installed plugin (Borg's plugin.yaml is the
 * marker). Without it this does nothing and runs no hermes command. It is
 * non-interactive by construction: its deps have no terminal and cannot
 * prompt, so an ambiguous conversation is reported and the activation stays
 * pending. The caller reports a non-zero result as an incomplete activation,
 * never as a failed update.
 */
export async function activateHermesPlugin(deps) {
    const unattended = {
        ...deps,
        isTTY: () => false,
        prompt: async () => { throw new HermesPluginError('borg update never asks a question'); },
    };
    try {
        const home = resolveHermesHome(undefined, unattended);
        if ((await installState(home)) !== 'installed')
            return 0;
        unattended.stdout(`Activating the Hermes plugin ${HERMES_PLUGIN_NAME}.\n`);
        return await activate(home, { invocation: {}, dryRun: false, noRestart: false, mayCreate: false }, unattended);
    }
    catch (error) {
        return failure(error, unattended, 'Hermes plugin activation');
    }
}
/**
 * For `borg representative status`: whether the plugin is installed and, when
 * it is, its activation state and the open-gateway report read through
 * `hermes config get`. Without an install no hermes command runs.
 */
export async function hermesPluginStatus(deps) {
    const home = resolveHermesHome(undefined, deps);
    try {
        const record = await deps.activation.read(home);
        if ((await installState(home)) !== 'installed') {
            return {
                installed: false,
                hermes_home: home,
                ...(record && activationPending(record) ? { activation_pending: true } : {}),
            };
        }
        const activation_pending = activationPending(record);
        const desktop_reload_pending = record?.desktop_reload === true;
        const config = new HermesConfig(deps.hermes(home));
        const sessionKey = await config.get(KEYS.sessionKey);
        if (typeof sessionKey !== 'string' || !SESSION_KEY_PATTERN.test(sessionKey)) {
            return {
                installed: true, hermes_home: home, activation_pending, desktop_reload_pending, session_key: null,
                error: `settings.session_key is not a gateway DM key; rerun \`${INSTALL_COMMAND}\``,
            };
        }
        return {
            installed: true,
            hermes_home: home,
            activation_pending,
            desktop_reload_pending,
            session_key: sessionKey,
            open_gateway: await openGatewaySwitches(config, platformOf(sessionKey), deps.env),
        };
    }
    catch (error) {
        return { installed: true, hermes_home: home, error: printableUntrusted(error instanceof Error ? error.message : String(error), 300) };
    }
}
/**
 * Uninstall is the same generation machinery with desired = absent: the
 * record stays until the gateway is confirmed to have unloaded the plugin, so
 * a rerun finishes a failed or --no-restart uninstall.
 */
export async function runHermesPluginUninstall(command, deps) {
    try {
        const home = resolveHermesHome(command.hermesHome, deps);
        await requireHermesHome(home);
        const cli = deps.hermes(home);
        const config = new HermesConfig(cli);
        const target = hermesPluginDir(home);
        const state = await installState(home);
        const previous = await deps.activation.read(home);
        const steps = [];
        const enabled = await config.get(KEYS.enabled);
        if (Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME)) {
            const remaining = enabled.filter((name) => name !== HERMES_PLUGIN_NAME);
            steps.push({ describe: `set ${KEYS.enabled} = ${JSON.stringify(remaining)}`, apply: (tx) => tx.set(KEYS.enabled, remaining) });
        }
        if ((await config.get(ENTRY_KEY)) !== ABSENT) {
            steps.push({ describe: `unset ${ENTRY_KEY}`, apply: (tx) => tx.unset(ENTRY_KEY) });
        }
        const mcp = await config.get(KEYS.mcp);
        let foreignMcp = false;
        let removesMcp = false;
        if (mcp !== ABSENT) {
            if (isBorgMcpEntry(mcp)) {
                steps.push({ describe: `unset ${KEYS.mcp}`, apply: (tx) => tx.unset(KEYS.mcp) });
                removesMcp = true;
            }
            else {
                foreignMcp = true;
            }
        }
        const foreignNote = foreignMcp ? `${KEYS.mcp} is not a Borg representative entry; it was left in place.\n` : '';
        if (state !== 'installed' && steps.length === 0) {
            // Nothing left to remove. An unload that is not confirmed (a failed or
            // skipped restart, or no confirmed state at all) is finished here.
            const unloaded = previous === null;
            if (unloaded) {
                deps.stdout(`The Hermes plugin ${HERMES_PLUGIN_NAME} is not installed in ${home}; nothing was changed.\n${foreignNote}`);
                return 0;
            }
            if (command.dryRun) {
                deps.stdout(`Hermes home: ${home}\nDry run; nothing was changed. The plugin is removed; the unload is pending: ${RESTART_PLAN}.\n${foreignNote}`);
                return 0;
            }
            const record = previous.desired.digest === ABSENT_GENERATION
                ? previous
                : await beginGeneration(cli, home, ABSENT_GENERATION, previous, false);
            await deps.activation.write(record);
            deps.stdout(`The Hermes plugin ${HERMES_PLUGIN_NAME} is removed from ${home}; finishing the pending unload.\n${foreignNote}`);
            return finishGeneration(cli, deps, record, command.noRestart, 'unload', uninstallCommand(command.hermesHome));
        }
        const plan = [
            ...steps.map((step) => step.describe),
            ...(state === 'absent' ? [] : [`remove the plugin's files from ${target} (plugin.yaml last), then the directory if nothing else is in it`]),
            ...(command.noRestart ? [] : [RESTART_PLAN]),
        ];
        if (command.dryRun) {
            deps.stdout(`Hermes home: ${home}\nDry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${foreignNote}`);
            return 0;
        }
        deps.stdout(`Hermes home: ${home}\nSteps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);
        // desired = absent is recorded before the first removal and stays until the unload is confirmed.
        const record = await beginGeneration(cli, home, ABSENT_GENERATION, previous, false);
        await deps.activation.write(record);
        const tx = new ConfigTransaction(home, config, deps.now);
        try {
            for (const step of steps)
                await step.apply(tx);
        }
        catch (error) {
            await reportFailure(error, tx, deps, async () => {
                if (previous)
                    await deps.activation.write(previous);
                else
                    await deps.activation.clear(home);
            });
            return 1;
        }
        let dirOutcome = '';
        if (state !== 'absent') {
            dirOutcome = (await removePluginFiles(target)) === 'removed'
                ? `Removed ${target}.\n`
                : `Removed the plugin's files; ${target} holds other files and was left in place (it is no longer an install).\n`;
        }
        deps.stdout(`Uninstalled the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
            `${tx.backupPath ? ` Backup of config.yaml (for manual recovery): ${tx.backupPath}` : ''}\n${dirOutcome}${foreignNote}` +
            `${removesMcp ? DESKTOP_RELOAD : ''}`);
        return finishGeneration(cli, deps, record, command.noRestart, 'unload', uninstallCommand(command.hermesHome));
    }
    catch (error) {
        return failure(error, deps, 'Uninstall');
    }
}
function isBorgMcpEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const args = value.args;
    return Array.isArray(args) && args[0] === 'representative' && args[1] === 'mcp';
}
//# sourceMappingURL=hermes-plugin-install.js.map