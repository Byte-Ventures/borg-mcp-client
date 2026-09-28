/**
 * `borg representative hermes-plugin install | uninstall` and `activateHermesPlugin()`
 * (run by `borg update`): one command sets up the Borg-owned Hermes push plugin.
 *
 * Every Hermes config change goes through Hermes's documented CLI
 * (`hermes config set|get|unset`, `hermes plugins enable`), run with execFile and
 * never a shell, with one explicit HERMES_HOME. After each write the value is read
 * back with `hermes config get <key> --json --raw` and must deep-equal the intended
 * value. Before the first write, config.yaml is backed up (O_EXCL|O_NOFOLLOW,
 * 0600). On failure the backup is restored only when config.yaml still has the
 * digest this run last recorded; otherwise nothing is restored and the applied
 * steps are printed.
 *
 * The plugin directory `<home>/plugins/borg-representative-push/` is the install
 * marker: `borg update` activates whenever it exists and never creates it.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, open, rename, rmdir, unlink, writeFile } from './guarded-fs.js';
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
        bindings: async ({ initialize }) => {
            const { createRepresentativeStore } = await import('./representative-store.js');
            const store = createRepresentativeStore();
            if (!(await store.initialized())) {
                if (!initialize)
                    return null;
                await store.initialize();
            }
            return (await store.listBindings()).map((binding) => binding.worktree);
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
        stdout: (text) => { process.stdout.write(text); },
        stderr: (text) => { process.stderr.write(text); },
    };
}
export class HermesPluginError extends Error {
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
// config.yaml backup and digest-conditional rollback
async function readConfigBytes(path) {
    const st = await lstatOrNull(path);
    if (!st)
        return null;
    if (!st.isFile())
        throw new HermesPluginError(`${path} is not a regular file; nothing was changed.`);
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        return { bytes: await handle.readFile(), mode: st.mode & 0o777 };
    }
    finally {
        await handle.close();
    }
}
function digestOf(content) {
    return content ? createHash('sha256').update(content.bytes).digest('hex') : 'absent';
}
async function ensurePrivateDir(path) {
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
class ConfigTransaction {
    home;
    config;
    now;
    backup = null;
    lastDigest = null;
    attempted = false;
    applied = [];
    constructor(home, config, now) {
        this.home = home;
        this.config = config;
        this.now = now;
    }
    get configPath() {
        return join(this.home, 'config.yaml');
    }
    get backupPath() {
        return this.backup?.path ?? null;
    }
    async begin() {
        if (this.backup)
            return;
        const original = await readConfigBytes(this.configPath);
        const backupsRoot = join(this.home, 'backups');
        const dir = join(backupsRoot, 'borg-representative');
        await ensurePrivateDir(backupsRoot);
        await ensurePrivateDir(dir);
        let path = '';
        for (let attempt = 0;; attempt += 1) {
            path = join(dir, `config.yaml.${stamp(this.now())}${attempt ? `-${attempt}` : ''}`);
            try {
                const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
                try {
                    await handle.writeFile(original?.bytes ?? Buffer.alloc(0));
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                break;
            }
            catch (error) {
                if (errnoCode(error) !== 'EEXIST' || attempt >= 20)
                    throw error;
            }
        }
        this.backup = { path, original };
        this.lastDigest = digestOf(original);
        await pruneBackups(dir);
    }
    /**
     * One Hermes write. Its digest is recorded only when the command succeeded:
     * after a failed command the file's state is unknown, so a later rollback
     * compares against the last write known to be ours and keeps anything else.
     */
    async write(step, command) {
        await this.begin();
        this.attempted = true;
        try {
            await command();
        }
        catch (error) {
            this.applied.push(`${step} (failed)`);
            throw error;
        }
        this.applied.push(step);
        this.lastDigest = digestOf(await readConfigBytes(this.configPath));
    }
    async set(key, value) {
        await this.write(`set ${key}`, () => this.config.run(['config', 'set', key, configSetText(value)]));
        await this.config.verifySet(key, value);
    }
    async unset(key) {
        await this.write(`unset ${key}`, () => this.config.unset(key));
        await this.config.verifyUnset(key);
    }
    async enablePlugin() {
        await this.write(`hermes plugins enable ${HERMES_PLUGIN_NAME}`, () => this.config.run(['plugins', 'enable', HERMES_PLUGIN_NAME]));
        const enabled = await this.config.get(KEYS.enabled);
        if (!Array.isArray(enabled) || !enabled.includes(HERMES_PLUGIN_NAME)) {
            throw new HermesPluginError(`${KEYS.enabled} does not list ${HERMES_PLUGIN_NAME} after \`hermes plugins enable\`.`);
        }
    }
    /**
     * Restore the backup only when config.yaml is exactly what this run last
     * wrote; a concurrent change is never overwritten.
     */
    async rollback() {
        if (!this.backup || !this.attempted)
            return 'nothing';
        const current = await readConfigBytes(this.configPath).catch(() => undefined);
        if (current === undefined || digestOf(current) !== this.lastDigest)
            return 'kept';
        const original = this.backup.original;
        if (!original) {
            await unlink(this.configPath);
            return 'restored';
        }
        const temporary = join(this.home, `.config.yaml.borg-restore.${process.pid}`);
        await writeFile(temporary, original.bytes, { mode: original.mode, flag: 'wx' });
        try {
            await rename(temporary, this.configPath);
        }
        catch (error) {
            await unlink(temporary).catch(() => { });
            throw error;
        }
        return 'restored';
    }
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
/** The marker: a real directory, never a link. null when absent. */
async function pluginDirState(home) {
    const target = hermesPluginDir(home);
    const st = await lstatOrNull(target);
    if (!st)
        return 'absent';
    if (st.isSymbolicLink())
        throw new HermesPluginError(`${target} is a symbolic link; remove it yourself, then rerun.`);
    if (!st.isDirectory())
        throw new HermesPluginError(`${target} exists and is not a directory.`);
    return 'directory';
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
async function removePluginFiles(target) {
    for (const name of HERMES_PLUGIN_FILES) {
        const path = join(target, name);
        const st = await lstatOrNull(path);
        if (st?.isFile())
            await unlink(path);
    }
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
        const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
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
async function chooseSessionKey(home, configured, explicit, deps) {
    if (explicit !== undefined)
        return { sessionKey: explicit, source: '--session-key' };
    if (typeof configured === 'string' && SESSION_KEY_PATTERN.test(configured)) {
        return { sessionKey: configured, source: 'kept from the current plugin settings' };
    }
    const candidates = await discoverSessionKeys(home);
    if (candidates === 'unavailable' || candidates.length === 0) {
        throw new HermesPluginError(`No gateway DM conversation was found in ${join(home, 'sessions', 'sessions.json')}. ` +
            'Message your Hermes bot once from your own DM, then rerun, or pass --session-key agent:main:<platform>:dm:<chat id>.');
    }
    if (candidates.length === 1)
        return { sessionKey: candidates[0].sessionKey, source: 'the only gateway DM conversation' };
    const listing = candidates.map((candidate, index) => `  ${index + 1}. ${describeCandidate(candidate)}\n`).join('');
    if (!deps.isTTY()) {
        throw new HermesPluginError(`Several gateway DM conversations were found; pass one with --session-key:\n${listing.trimEnd()}`);
    }
    deps.stdout(`Gateway DM conversations:\n${listing}`);
    const answer = await deps.prompt(`Wake which conversation? [1-${candidates.length}] `);
    const index = answer === null ? Number.NaN : Number(answer.trim()) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        throw new HermesPluginError('No conversation was chosen; nothing was changed.');
    }
    return { sessionKey: candidates[index].sessionKey, source: 'your choice' };
}
// ---------------------------------------------------------------------------
// Worktree from the representative binding state
async function chooseWorktree(explicit, configured, deps, options) {
    const worktrees = await deps.bindings(options);
    if (worktrees === null) {
        if (explicit)
            return explicit;
        throw new HermesPluginError('No representative state exists yet, and a dry run does not import it. Pass --worktree <path>, or run without --dry-run.');
    }
    if (explicit !== undefined) {
        if (!worktrees.includes(explicit)) {
            throw new HermesPluginError(`${explicit} is not a prepared representative worktree. Prepared: ${worktrees.join(', ') || 'none'}.`);
        }
        return explicit;
    }
    if (typeof configured === 'string' && worktrees.includes(configured))
        return configured;
    if (worktrees.length === 1)
        return worktrees[0];
    if (worktrees.length === 0) {
        throw new HermesPluginError('No representative connection is prepared. Run `borg representative prepare --coordinator <drone-label>` first.');
    }
    throw new HermesPluginError(`Several representative worktrees are prepared; pass one with --worktree:\n${worktrees.map((path) => `  ${path}\n`).join('').trimEnd()}`);
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
async function configSteps(config, target) {
    const steps = [];
    const setIfDifferent = async (key, value) => {
        const current = await config.get(key);
        if (current !== ABSENT && isDeepStrictEqual(current, value))
            return;
        steps.push({ describe: `set ${key} = ${JSON.stringify(value)}`, apply: (tx) => tx.set(key, value) });
    };
    await setIfDifferent(KEYS.sessionKey, target.sessionKey);
    await setIfDifferent(KEYS.worktree, target.worktree);
    await setIfDifferent(KEYS.borgCommand, target.borgCommand);
    for (const key of LEGACY_SETTING_KEYS) {
        if ((await config.get(key)) !== ABSENT)
            steps.push({ describe: `unset ${key}`, apply: (tx) => tx.unset(key) });
    }
    await setIfDifferent(KEYS.injection, true);
    await setIfDifferent(KEYS.mcp, mcpEntry(target));
    const enabled = await config.get(KEYS.enabled);
    const disabled = await config.get('plugins.disabled');
    const listed = Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME);
    const blocked = Array.isArray(disabled) && disabled.includes(HERMES_PLUGIN_NAME);
    if (!listed || blocked) {
        steps.push({ describe: `hermes plugins enable ${HERMES_PLUGIN_NAME}`, apply: (tx) => tx.enablePlugin() });
    }
    return steps;
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
    if (/Running manually, not as a system service/.test(stdout))
        return { kind: 'manual' };
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
function restartPlan() {
    return ['hermes serve --stop', 'hermes gateway restart, only when the gateway runs as a launchd/systemd service'];
}
/**
 * Activate the running hosts. `hermes serve --stop` is always safe (Desktop
 * respawns its backend). The gateway is restarted only when `gateway status`
 * shows it service-managed: without a service, `hermes gateway restart` would
 * run a gateway in the foreground under this process, so Borg prints the
 * command instead. Every call has a hard timeout that kills only its own child.
 */
async function restartHosts(cli, deps, verb) {
    deps.stdout('Running `hermes serve --stop` (Hermes Desktop restarts its backend on its own).\n');
    const serve = await cli(['serve', '--stop']);
    let ok = serve.code === 0;
    if (!ok)
        deps.stderr(`${describeFailure(['serve', '--stop'], serve)}. Run it yourself.\n`);
    const before = await gatewaySupervision(cli);
    const manualHint = `Run \`hermes gateway restart\` yourself where the gateway runs to ${verb} the plugin.\n`;
    switch (before.kind) {
        case 'stopped':
            deps.stdout(`The Hermes gateway is not running; it will ${verb} the plugin when it starts.\n`);
            return ok;
        case 'manual':
            deps.stdout(`The Hermes gateway was started by hand (not as a service), so Borg does not restart it. ${manualHint}`);
            return ok;
        case 'multiplexed':
            deps.stdout(`The Hermes gateway for this profile runs inside the default profile's gateway, so Borg does not restart it. ${manualHint}`);
            return ok;
        case 'unknown':
            deps.stdout(`\`hermes gateway status\` did not show a service-managed gateway, so Borg does not restart it. ${manualHint}`);
            return ok;
        case 'service':
            break;
    }
    deps.stdout('Running `hermes gateway restart` (service-managed gateway).\n');
    const restart = await cli(['gateway', 'restart']);
    if (restart.code !== 0) {
        deps.stderr(`${describeFailure(['gateway', 'restart'], restart)}. ${manualHint}`);
        return false;
    }
    const after = await gatewaySupervision(cli);
    if (after.kind !== 'service' || (before.pid !== null && after.pid === before.pid)) {
        deps.stderr(`The gateway restart could not be confirmed by \`hermes gateway status\`. ${manualHint}`);
        return false;
    }
    deps.stdout(`The Hermes gateway restarted${after.pid ? ` (PID ${after.pid})` : ''}.\n`);
    return ok;
}
function restartHint(verb) {
    return `Restart skipped. To ${verb} the plugin run \`hermes serve --stop\` and restart the gateway (\`hermes gateway restart\`).\n`;
}
async function activate(home, options, deps) {
    const cli = deps.hermes(home);
    const config = new HermesConfig(cli);
    const target = hermesPluginDir(home);
    const dirState = await pluginDirState(home);
    if (dirState === 'absent' && !options.mayCreate)
        return 0;
    const sources = await readSources(deps.sourceDir);
    const before = dirState === 'directory' ? await snapshotPluginFiles(target) : new Map();
    const staleFiles = sources.filter(({ name, content }) => !before.get(name)?.equals(content)).map(({ name }) => name);
    const configuredSessionKey = await config.get(KEYS.sessionKey);
    const configuredWorktree = await config.get(KEYS.worktree);
    const worktree = await chooseWorktree(options.explicitWorktree, configuredWorktree, deps, { initialize: !options.dryRun });
    const { sessionKey, source } = await chooseSessionKey(home, configuredSessionKey, options.explicitSessionKey, deps);
    const borgCommand = deps.borgCommand();
    if (!isAbsolute(borgCommand))
        throw new HermesPluginError(`The borg executable path is not absolute: ${borgCommand}`);
    const wanted = { sessionKey, worktree, borgCommand };
    const steps = await configSteps(config, wanted);
    const gateway = await openGatewaySwitches(config, platformOf(sessionKey), deps.env);
    const summary = `Hermes home:  ${home}\n` +
        `Conversation: ${sessionKey} (${source})\n` +
        `Worktree:     ${worktree}\n` +
        `borg:         ${borgCommand}\n`;
    if (dirState === 'directory' && staleFiles.length === 0 && steps.length === 0) {
        deps.stdout(`${summary}The Hermes plugin ${HERMES_PLUGIN_NAME} is already installed and configured; nothing was changed.\n${openGatewayReport(gateway)}`);
        return 0;
    }
    const plan = [
        ...(dirState === 'absent' ? [`create ${target}`] : []),
        ...staleFiles.map((name) => `write ${join(target, name)}`),
        ...steps.map((step) => step.describe),
        ...(options.noRestart ? [] : restartPlan()),
    ];
    if (options.dryRun) {
        deps.stdout(`${summary}Dry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${openGatewayReport(gateway)}`);
        return 0;
    }
    deps.stdout(`${summary}Steps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);
    const tx = new ConfigTransaction(home, config, deps.now);
    let createdDir = false;
    const written = [];
    try {
        if (dirState === 'absent') {
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
        for (const { name, content } of sources) {
            if (!staleFiles.includes(name))
                continue;
            await writePluginFile(target, name, content);
            written.push(name);
        }
        for (const step of steps)
            await step.apply(tx);
    }
    catch (error) {
        await reportFailure(error, tx, deps, async () => {
            if (createdDir) {
                await removePluginFiles(target);
                return;
            }
            for (const name of written) {
                const previous = before.get(name);
                if (previous)
                    await writePluginFile(target, name, previous);
                else
                    await unlink(join(target, name)).catch(() => { });
            }
        });
        return 1;
    }
    deps.stdout(`${createdDir ? 'Installed' : 'Updated'} the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
        `${tx.backupPath ? ` Backup of config.yaml: ${tx.backupPath}` : ''}\n`);
    deps.stdout(openGatewayReport(gateway));
    if (options.noRestart) {
        deps.stdout(restartHint('load'));
        return 0;
    }
    return (await restartHosts(cli, deps, 'load')) ? 0 : 1;
}
async function reportFailure(error, tx, deps, restoreFiles) {
    const message = error instanceof Error ? error.message : String(error);
    let outcome;
    try {
        const rollback = await tx.rollback();
        if (rollback === 'kept') {
            outcome =
                `config.yaml changed outside this run, so it was not restored. Applied steps:\n` +
                    `${tx.applied.map((step) => `  - ${step}\n`).join('')}` +
                    `Backup: ${tx.backupPath}\n`;
        }
        else {
            await restoreFiles();
            outcome = rollback === 'restored'
                ? `config.yaml was restored from ${tx.backupPath}.\n`
                : 'No Hermes config was changed.\n';
        }
    }
    catch (rollbackError) {
        outcome =
            `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Applied steps:\n` +
                `${tx.applied.map((step) => `  - ${step}\n`).join('')}` +
                `${tx.backupPath ? `Backup: ${tx.backupPath}\n` : ''}`;
    }
    deps.stderr(`${message}\n${outcome}`);
}
function failure(error, deps, prefix) {
    const message = error instanceof HermesPluginError ? error.message : `${prefix} failed: ${error instanceof Error ? error.message : String(error)}`;
    deps.stderr(`${message}\n`);
    return 1;
}
export async function runHermesPluginInstall(command, deps) {
    try {
        const home = resolveHermesHome(command.hermesHome, deps);
        await requireHermesHome(home);
        return await activate(home, {
            ...(command.worktree ? { explicitWorktree: command.worktree } : {}),
            ...(command.sessionKey ? { explicitSessionKey: command.sessionKey } : {}),
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
 * `borg update`: activate the installed plugin (the plugin directory is the
 * marker). Without the directory this does nothing and runs no hermes command.
 */
export async function activateHermesPlugin(deps) {
    try {
        const home = resolveHermesHome(undefined, deps);
        const dir = await lstatOrNull(hermesPluginDir(home));
        if (!dir)
            return 0;
        deps.stdout(`Activating the Hermes plugin ${HERMES_PLUGIN_NAME}.\n`);
        return await activate(home, { dryRun: false, noRestart: false, mayCreate: false }, deps);
    }
    catch (error) {
        const code = failure(error, deps, 'Hermes plugin activation');
        deps.stderr('Rerun `borg representative hermes-plugin install` to finish the activation.\n');
        return code;
    }
}
/**
 * For `borg representative status`: whether the plugin is installed (its
 * directory is the marker) and, when it is, the open-gateway report read
 * through `hermes config get`. Without the directory no hermes command runs.
 */
export async function hermesPluginStatus(deps) {
    const home = resolveHermesHome(undefined, deps);
    try {
        if ((await pluginDirState(home)) === 'absent')
            return { installed: false, hermes_home: home };
        const config = new HermesConfig(deps.hermes(home));
        const sessionKey = await config.get(KEYS.sessionKey);
        if (typeof sessionKey !== 'string' || !SESSION_KEY_PATTERN.test(sessionKey)) {
            return { installed: true, hermes_home: home, session_key: null, error: 'settings.session_key is not a gateway DM key; rerun `borg representative hermes-plugin install`' };
        }
        return {
            installed: true,
            hermes_home: home,
            session_key: sessionKey,
            open_gateway: await openGatewaySwitches(config, platformOf(sessionKey), deps.env),
        };
    }
    catch (error) {
        return { installed: true, hermes_home: home, error: printableUntrusted(error instanceof Error ? error.message : String(error), 300) };
    }
}
export async function runHermesPluginUninstall(command, deps) {
    try {
        const home = resolveHermesHome(command.hermesHome, deps);
        await requireHermesHome(home);
        const cli = deps.hermes(home);
        const config = new HermesConfig(cli);
        const target = hermesPluginDir(home);
        const dirState = await pluginDirState(home);
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
        if (mcp !== ABSENT) {
            if (isBorgMcpEntry(mcp))
                steps.push({ describe: `unset ${KEYS.mcp}`, apply: (tx) => tx.unset(KEYS.mcp) });
            else
                foreignMcp = true;
        }
        const foreignNote = foreignMcp ? `${KEYS.mcp} is not a Borg representative entry; it was left in place.\n` : '';
        if (dirState === 'absent' && steps.length === 0) {
            deps.stdout(`The Hermes plugin ${HERMES_PLUGIN_NAME} is not installed in ${home}; nothing was changed.\n${foreignNote}`);
            return 0;
        }
        const plan = [
            ...steps.map((step) => step.describe),
            ...(dirState === 'directory' ? [`remove ${HERMES_PLUGIN_FILES.map((name) => join(target, name)).join(' and ')}, then the directory if empty`] : []),
            ...(command.noRestart ? [] : restartPlan()),
        ];
        if (command.dryRun) {
            deps.stdout(`Hermes home: ${home}\nDry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${foreignNote}`);
            return 0;
        }
        deps.stdout(`Hermes home: ${home}\nSteps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);
        const tx = new ConfigTransaction(home, config, deps.now);
        try {
            for (const step of steps)
                await step.apply(tx);
        }
        catch (error) {
            await reportFailure(error, tx, deps, async () => { });
            return 1;
        }
        let dirOutcome = '';
        if (dirState === 'directory') {
            dirOutcome = (await removePluginFiles(target)) === 'removed'
                ? `Removed ${target}.\n`
                : `Removed the plugin's files; ${target} holds other files and was left in place.\n`;
        }
        deps.stdout(`Uninstalled the Hermes plugin ${HERMES_PLUGIN_NAME}.${tx.backupPath ? ` Backup of config.yaml: ${tx.backupPath}` : ''}\n${dirOutcome}${foreignNote}`);
        if (command.noRestart) {
            deps.stdout(restartHint('unload'));
            return 0;
        }
        return (await restartHosts(cli, deps, 'unload')) ? 0 : 1;
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