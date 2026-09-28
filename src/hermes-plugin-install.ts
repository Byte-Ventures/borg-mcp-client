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
export const HERMES_PLUGIN_FILES = ['plugin.yaml', '__init__.py'] as const;
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
} as const;
/** 5.x plugin settings that v2 no longer reads. */
export const LEGACY_SETTING_KEYS = ['mcp_server', 'reinject_after_s', 'max_reinjects']
  .map((name) => `${ENTRY_KEY}.settings.${name}`);

export interface HermesCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one `hermes <argv>` for one Hermes home. */
export type HermesCli = (argv: readonly string[]) => Promise<HermesCliResult>;

export interface HermesPluginDeps {
  env: NodeJS.ProcessEnv;
  homedir(): string;
  /** Directory holding the packaged plugin files. */
  sourceDir: string;
  /** The Hermes CLI for one home; every call carries HERMES_HOME=<home>. */
  hermes(home: string): HermesCli;
  /** Absolute path of the borg executable written into the MCP entry and the plugin. */
  borgCommand(): string;
  /**
   * Worktrees of the saved representative bindings. `initialize` imports 5.x
   * state first when no state exists; without it an uninitialized state is null.
   */
  bindings(options: { initialize: boolean }): Promise<string[] | null>;
  isTTY(): boolean;
  /** Reads one answer line from the terminal; null on EOF. */
  prompt(question: string): Promise<string | null>;
  now(): Date;
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface HermesPluginInstallCommand {
  hermesHome?: string;
  worktree?: string;
  sessionKey?: string;
  dryRun: boolean;
  noRestart: boolean;
}

export interface HermesPluginUninstallCommand {
  hermesHome?: string;
  dryRun: boolean;
  noRestart: boolean;
}

export function packagedHermesPluginDir(): string {
  return fileURLToPath(new URL(`../hermes-plugin/${HERMES_PLUGIN_NAME}/`, import.meta.url));
}

/** Environment switches that open the gateway to everyone (Hermes user-guide/security.md). */
function allowAllEnvName(name: string): boolean {
  return /^(?:[A-Z0-9_]+_)?ALLOW_ALL_USERS$/.test(name);
}

/**
 * execFile, never a shell. The allow-all switches are removed from the child
 * environment so `config get` reports Hermes's own `.env`, not this shell.
 */
export function execFileHermesCli(command: string, home: string, env: NodeJS.ProcessEnv): HermesCli {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!allowAllEnvName(name)) childEnv[name] = value;
  }
  childEnv.HERMES_HOME = home;
  return (argv) => new Promise((resolve) => {
    execFile(command, [...argv], {
      env: childEnv,
      timeout: HERMES_TIMEOUT_MS,
      maxBuffer: HERMES_OUTPUT_MAX,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 127) : 0;
      const detail = error && typeof error.code !== 'number' ? `${stderr}${error.message}\n` : stderr;
      resolve({ code, stdout, stderr: detail });
    });
  });
}

export function defaultBorgCommand(): string {
  return process.argv[1];
}

export function defaultHermesPluginDeps(): HermesPluginDeps {
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
        if (!initialize) return null;
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
        rl.once('close', () => { if (!answered) resolve(null); });
      });
    },
    now: () => new Date(),
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  };
}

export class HermesPluginError extends Error {}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/** Control, C1 and bidirectional-override characters are removed before anything untrusted is printed. */
export function printableUntrusted(text: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function resolveHermesHome(explicit: string | undefined, deps: Pick<HermesPluginDeps, 'env' | 'homedir'>): string {
  const home = explicit ?? (deps.env.HERMES_HOME || join(deps.homedir(), '.hermes'));
  if (!isAbsolute(home)) throw new HermesPluginError(`The Hermes home must be an absolute path: ${home}`);
  return home;
}

async function requireHermesHome(home: string): Promise<void> {
  const homeStat = await lstatOrNull(home);
  if (!homeStat?.isDirectory()) {
    throw new HermesPluginError(`No Hermes home at ${home}. Install Hermes first, or pass --hermes-home <path>.`);
  }
}

// ---------------------------------------------------------------------------
// Hermes config through the documented CLI

const ABSENT = Symbol('absent');
type ConfigValue = unknown | typeof ABSENT;

/**
 * Hermes may print its own startup maintenance before the command's output
 * (`hermes config get --json` prints one `json.dumps` line), so the value is the
 * last non-empty line.
 */
function parseGetOutput(key: string, stdout: string): unknown {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (last === undefined) throw new HermesPluginError(`\`hermes config get ${key}\` printed nothing.`);
  try {
    return JSON.parse(last);
  } catch {
    throw new HermesPluginError(`\`hermes config get ${key} --json\` did not print JSON.`);
  }
}

function describeFailure(argv: readonly string[], result: HermesCliResult): string {
  const detail = printableUntrusted(result.stderr.trim().split(/\r?\n/).at(-1) ?? '', 300);
  return `\`hermes ${argv.join(' ')}\` failed (exit ${result.code})${detail ? `: ${detail}` : ''}`;
}

/** The value text for `hermes config set`: containers and booleans as JSON, strings raw. */
export function configSetText(value: unknown): string {
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
  constructor(private readonly cli: HermesCli) {}

  async get(key: string): Promise<ConfigValue> {
    const argv = ['config', 'get', key, '--json', '--raw'];
    const result = await this.cli(argv);
    if (result.code === 0) return parseGetOutput(key, result.stdout);
    if (result.stderr.includes('Config key not set')) return ABSENT;
    throw new HermesPluginError(describeFailure(argv, result));
  }

  async run(argv: readonly string[]): Promise<void> {
    const result = await this.cli(argv);
    if (result.code !== 0) throw new HermesPluginError(describeFailure(argv, result));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.run(['config', 'set', key, configSetText(value)]);
    const actual = await this.get(key);
    if (actual === ABSENT || !isDeepStrictEqual(actual, value)) {
      throw new HermesPluginError(
        `Hermes stored ${key} as ${actual === ABSENT ? 'nothing' : JSON.stringify(actual)}, not ${JSON.stringify(value)}.`,
      );
    }
  }

  async unset(key: string): Promise<void> {
    const argv = ['config', 'unset', key];
    const result = await this.cli(argv);
    if (result.code !== 0 && !result.stderr.includes('Config key not set')) {
      throw new HermesPluginError(describeFailure(argv, result));
    }
    if ((await this.get(key)) !== ABSENT) throw new HermesPluginError(`Hermes still holds ${key} after unset.`);
  }
}

// ---------------------------------------------------------------------------
// config.yaml backup and digest-conditional rollback

async function readConfigBytes(path: string): Promise<{ bytes: Buffer; mode: number } | null> {
  const st = await lstatOrNull(path);
  if (!st) return null;
  if (!st.isFile()) throw new HermesPluginError(`${path} is not a regular file; nothing was changed.`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return { bytes: await handle.readFile(), mode: st.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function digestOf(content: { bytes: Buffer } | null): string {
  return content ? createHash('sha256').update(content.bytes).digest('hex') : 'absent';
}

async function ensurePrivateDir(path: string): Promise<void> {
  const st = await lstatOrNull(path);
  if (!st) {
    await mkdir(path, { mode: 0o700 });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new HermesPluginError(`${path} is not a directory; nothing was changed.`);
  }
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
}

class ConfigTransaction {
  private backup: { path: string; original: { bytes: Buffer; mode: number } | null } | null = null;
  private lastDigest: string | null = null;
  readonly applied: string[] = [];

  constructor(
    private readonly home: string,
    private readonly config: HermesConfig,
    private readonly now: () => Date,
  ) {}

  get configPath(): string {
    return join(this.home, 'config.yaml');
  }

  get backupPath(): string | null {
    return this.backup?.path ?? null;
  }

  private async begin(): Promise<void> {
    if (this.backup) return;
    const original = await readConfigBytes(this.configPath);
    const backupsRoot = join(this.home, 'backups');
    const dir = join(backupsRoot, 'borg-representative');
    await ensurePrivateDir(backupsRoot);
    await ensurePrivateDir(dir);
    let path = '';
    for (let attempt = 0; ; attempt += 1) {
      path = join(dir, `config.yaml.${stamp(this.now())}${attempt ? `-${attempt}` : ''}`);
      try {
        const handle = await open(
          path,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(original?.bytes ?? Buffer.alloc(0));
          await handle.sync();
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST' || attempt >= 20) throw error;
      }
    }
    this.backup = { path, original };
    this.lastDigest = digestOf(original);
    await pruneBackups(dir);
  }

  private async record(step: string): Promise<void> {
    this.applied.push(step);
    this.lastDigest = digestOf(await readConfigBytes(this.configPath));
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.begin();
    try {
      await this.config.set(key, value);
    } finally {
      await this.record(`set ${key}`);
    }
  }

  async unset(key: string): Promise<void> {
    await this.begin();
    try {
      await this.config.unset(key);
    } finally {
      await this.record(`unset ${key}`);
    }
  }

  async enablePlugin(): Promise<void> {
    await this.begin();
    try {
      await this.config.run(['plugins', 'enable', HERMES_PLUGIN_NAME]);
    } finally {
      await this.record(`hermes plugins enable ${HERMES_PLUGIN_NAME}`);
    }
    const enabled = await this.config.get(KEYS.enabled);
    if (!Array.isArray(enabled) || !enabled.includes(HERMES_PLUGIN_NAME)) {
      throw new HermesPluginError(`${KEYS.enabled} does not list ${HERMES_PLUGIN_NAME} after \`hermes plugins enable\`.`);
    }
  }

  /**
   * Restore the backup only when config.yaml is exactly what this run last
   * wrote; a concurrent change is never overwritten.
   */
  async rollback(): Promise<'nothing' | 'restored' | 'kept'> {
    if (!this.backup || this.applied.length === 0) return 'nothing';
    const current = await readConfigBytes(this.configPath).catch(() => undefined);
    if (current === undefined || digestOf(current) !== this.lastDigest) return 'kept';
    const original = this.backup.original;
    if (!original) {
      await unlink(this.configPath);
      return 'restored';
    }
    const temporary = join(this.home, `.config.yaml.borg-restore.${process.pid}`);
    await writeFile(temporary, original.bytes, { mode: original.mode, flag: 'wx' });
    try {
      await rename(temporary, this.configPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return 'restored';
  }
}

async function pruneBackups(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => /^config\.yaml\.\d{8}T\d{9}Z(?:-\d+)?$/.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - BACKUPS_KEPT))) {
    const path = join(dir, name);
    const st = await lstatOrNull(path);
    if (st?.isFile()) await unlink(path);
  }
}

// ---------------------------------------------------------------------------
// Plugin files

async function readSources(sourceDir: string): Promise<Array<{ name: string; content: Buffer }>> {
  return Promise.all(HERMES_PLUGIN_FILES.map(async (name) => {
    try {
      return { name, content: await readFile(join(sourceDir, name)) };
    } catch {
      throw new HermesPluginError(`The packaged plugin file ${name} is missing from ${sourceDir}; reinstall borgmcp.`);
    }
  }));
}

export function hermesPluginDir(home: string): string {
  return join(home, 'plugins', HERMES_PLUGIN_NAME);
}

/** The marker: a real directory, never a link. null when absent. */
async function pluginDirState(home: string): Promise<'absent' | 'directory'> {
  const target = hermesPluginDir(home);
  const st = await lstatOrNull(target);
  if (!st) return 'absent';
  if (st.isSymbolicLink()) throw new HermesPluginError(`${target} is a symbolic link; remove it yourself, then rerun.`);
  if (!st.isDirectory()) throw new HermesPluginError(`${target} exists and is not a directory.`);
  return 'directory';
}

type FileSnapshot = Map<string, Buffer | null>;

async function snapshotPluginFiles(target: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  for (const name of HERMES_PLUGIN_FILES) {
    const path = join(target, name);
    const st = await lstatOrNull(path);
    if (st && !st.isFile()) throw new HermesPluginError(`${path} is not a regular file.`);
    snapshot.set(name, st ? await readFile(path) : null);
  }
  return snapshot;
}

async function writePluginFile(target: string, name: string, content: Buffer): Promise<void> {
  const destination = join(target, name);
  const temporary = join(target, `.${name}.${process.pid}.tmp`);
  // 'wx' refuses to follow or reuse anything already at the temporary path.
  await writeFile(temporary, content, { mode: 0o644, flag: 'wx' });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function removePluginFiles(target: string): Promise<'removed' | 'kept-other-files'> {
  for (const name of HERMES_PLUGIN_FILES) {
    const path = join(target, name);
    const st = await lstatOrNull(path);
    if (st?.isFile()) await unlink(path);
  }
  try {
    await rmdir(target);
    return 'removed';
  } catch (error) {
    if (errnoCode(error) === 'ENOTEMPTY' || errnoCode(error) === 'EEXIST') return 'kept-other-files';
    throw error;
  }
}

// ---------------------------------------------------------------------------
// session_key discovery (untrusted input)

export interface SessionCandidate {
  sessionKey: string;
  label: string;
}

export async function discoverSessionKeys(home: string): Promise<SessionCandidate[] | 'unavailable'> {
  const path = join(home, 'sessions', 'sessions.json');
  const st = await lstatOrNull(path);
  if (!st || !st.isFile() || st.size > SESSIONS_MAX_BYTES) return 'unavailable';
  let parsed: unknown;
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > SESSIONS_MAX_BYTES) return 'unavailable';
      parsed = JSON.parse((await handle.readFile()).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return 'unavailable';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unavailable';
  const candidates: SessionCandidate[] = [];
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SESSION_KEY_PATTERN.test(key)) continue;
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    const origin = record.origin && typeof record.origin === 'object' ? record.origin as Record<string, unknown> : {};
    const name = [record.display_name, origin.chat_name, origin.user_name].find((value) => typeof value === 'string' && value.trim());
    candidates.push({ sessionKey: key, label: printableUntrusted(typeof name === 'string' ? name : '') });
  }
  return candidates.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

function describeCandidate(candidate: SessionCandidate): string {
  return `${candidate.sessionKey}${candidate.label ? `  (${candidate.label})` : ''}`;
}

async function chooseSessionKey(
  home: string,
  configured: ConfigValue,
  explicit: string | undefined,
  deps: HermesPluginDeps,
): Promise<{ sessionKey: string; source: string }> {
  if (explicit !== undefined) return { sessionKey: explicit, source: '--session-key' };
  if (typeof configured === 'string' && SESSION_KEY_PATTERN.test(configured)) {
    return { sessionKey: configured, source: 'kept from the current plugin settings' };
  }
  const candidates = await discoverSessionKeys(home);
  if (candidates === 'unavailable' || candidates.length === 0) {
    throw new HermesPluginError(
      `No gateway DM conversation was found in ${join(home, 'sessions', 'sessions.json')}. ` +
        'Message your Hermes bot once from your own DM, then rerun, or pass --session-key agent:main:<platform>:dm:<chat id>.',
    );
  }
  if (candidates.length === 1) return { sessionKey: candidates[0].sessionKey, source: 'the only gateway DM conversation' };
  const listing = candidates.map((candidate, index) => `  ${index + 1}. ${describeCandidate(candidate)}\n`).join('');
  if (!deps.isTTY()) {
    throw new HermesPluginError(
      `Several gateway DM conversations were found; pass one with --session-key:\n${listing.trimEnd()}`,
    );
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

async function chooseWorktree(
  explicit: string | undefined,
  configured: ConfigValue,
  deps: HermesPluginDeps,
  options: { initialize: boolean },
): Promise<string> {
  const worktrees = await deps.bindings(options);
  if (worktrees === null) {
    if (explicit) return explicit;
    throw new HermesPluginError(
      'No representative state exists yet, and a dry run does not import it. Pass --worktree <path>, or run without --dry-run.',
    );
  }
  if (explicit !== undefined) {
    if (!worktrees.includes(explicit)) {
      throw new HermesPluginError(`${explicit} is not a prepared representative worktree. Prepared: ${worktrees.join(', ') || 'none'}.`);
    }
    return explicit;
  }
  if (typeof configured === 'string' && worktrees.includes(configured)) return configured;
  if (worktrees.length === 1) return worktrees[0];
  if (worktrees.length === 0) {
    throw new HermesPluginError(
      'No representative connection is prepared. Run `borg representative prepare --coordinator <drone-label>` first.',
    );
  }
  throw new HermesPluginError(
    `Several representative worktrees are prepared; pass one with --worktree:\n${worktrees.map((path) => `  ${path}\n`).join('').trimEnd()}`,
  );
}

// ---------------------------------------------------------------------------
// Open-gateway report (reported, never refused)

function truthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === 'string' && ['true', '1', 'yes'].includes(value.trim().toLowerCase());
}

export function platformOf(sessionKey: string): string {
  return sessionKey.split(':')[2] ?? '';
}

export async function openGatewaySwitches(
  config: HermesConfig,
  platform: string,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const envNames = ['GATEWAY_ALLOW_ALL_USERS', `${platform.toUpperCase().replace(/-/g, '_')}_ALLOW_ALL_USERS`];
  const open: string[] = [];
  for (const key of ['gateway.allow_all_users', 'allow_all_users', ...envNames]) {
    const value = await config.get(key);
    if (value !== ABSENT && truthy(value)) open.push(key);
  }
  for (const name of envNames) {
    if (truthy(env[name])) open.push(`${name} (this shell's environment)`);
  }
  return open;
}

function openGatewayReport(switches: readonly string[]): string {
  return switches.length === 0
    ? 'Gateway access: no allow-all switch is set; Hermes allowlists and pairing decide who can message the bot.\n'
    : `Open gateway (${switches.join(', ')}): anyone who can message the bot can read Coordinator replies and send as the representative.\n`;
}

// ---------------------------------------------------------------------------
// Plan and apply

interface Target {
  sessionKey: string;
  worktree: string;
  borgCommand: string;
}

function mcpEntry(target: Target): { command: string; args: string[]; lazy: true } {
  return { command: target.borgCommand, args: ['representative', 'mcp', '--worktree', target.worktree], lazy: true };
}

interface Step {
  describe: string;
  apply(tx: ConfigTransaction): Promise<void>;
}

async function configSteps(config: HermesConfig, target: Target): Promise<Step[]> {
  const steps: Step[] = [];
  const setIfDifferent = async (key: string, value: unknown) => {
    const current = await config.get(key);
    if (current !== ABSENT && isDeepStrictEqual(current, value)) return;
    steps.push({ describe: `set ${key} = ${JSON.stringify(value)}`, apply: (tx) => tx.set(key, value) });
  };
  await setIfDifferent(KEYS.sessionKey, target.sessionKey);
  await setIfDifferent(KEYS.worktree, target.worktree);
  await setIfDifferent(KEYS.borgCommand, target.borgCommand);
  for (const key of LEGACY_SETTING_KEYS) {
    if ((await config.get(key)) !== ABSENT) steps.push({ describe: `unset ${key}`, apply: (tx) => tx.unset(key) });
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

function restartCommands(): string[][] {
  return [['serve', '--stop'], ['gateway', 'restart']];
}

async function restartHosts(cli: HermesCli, deps: HermesPluginDeps): Promise<boolean> {
  let ok = true;
  for (const argv of restartCommands()) {
    deps.stdout(`Running \`hermes ${argv.join(' ')}\`.\n`);
    const result = await cli(argv);
    if (result.code !== 0) {
      ok = false;
      deps.stderr(`${describeFailure(argv, result)}. Run it yourself to finish the activation.\n`);
    }
  }
  return ok;
}

function restartHint(): string {
  return `Restart skipped. To load the plugin run: ${restartCommands().map((argv) => `\`hermes ${argv.join(' ')}\``).join(' and ')}.\n`;
}

interface ActivationOptions {
  explicitWorktree?: string;
  explicitSessionKey?: string;
  dryRun: boolean;
  noRestart: boolean;
  /** install may create the plugin directory; `borg update` never does. */
  mayCreate: boolean;
}

async function activate(home: string, options: ActivationOptions, deps: HermesPluginDeps): Promise<number> {
  const cli = deps.hermes(home);
  const config = new HermesConfig(cli);
  const target = hermesPluginDir(home);
  const dirState = await pluginDirState(home);
  if (dirState === 'absent' && !options.mayCreate) return 0;
  const sources = await readSources(deps.sourceDir);
  const before = dirState === 'directory' ? await snapshotPluginFiles(target) : new Map<string, Buffer | null>();
  const staleFiles = sources.filter(({ name, content }) => !before.get(name)?.equals(content)).map(({ name }) => name);

  const configuredSessionKey = await config.get(KEYS.sessionKey);
  const configuredWorktree = await config.get(KEYS.worktree);
  const worktree = await chooseWorktree(options.explicitWorktree, configuredWorktree, deps, { initialize: !options.dryRun });
  const { sessionKey, source } = await chooseSessionKey(home, configuredSessionKey, options.explicitSessionKey, deps);
  const borgCommand = deps.borgCommand();
  if (!isAbsolute(borgCommand)) throw new HermesPluginError(`The borg executable path is not absolute: ${borgCommand}`);
  const wanted: Target = { sessionKey, worktree, borgCommand };
  const steps = await configSteps(config, wanted);
  const gateway = await openGatewaySwitches(config, platformOf(sessionKey), deps.env);

  const summary =
    `Hermes home:  ${home}\n` +
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
    ...(options.noRestart ? [] : restartCommands().map((argv) => `hermes ${argv.join(' ')}`)),
  ];
  if (options.dryRun) {
    deps.stdout(`${summary}Dry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${openGatewayReport(gateway)}`);
    return 0;
  }
  deps.stdout(`${summary}Steps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);

  const tx = new ConfigTransaction(home, config, deps.now);
  let createdDir = false;
  const written: string[] = [];
  try {
    if (dirState === 'absent') {
      const plugins = join(home, 'plugins');
      const pluginsStat = await lstatOrNull(plugins);
      if (pluginsStat && (pluginsStat.isSymbolicLink() || !pluginsStat.isDirectory())) {
        throw new HermesPluginError(`${plugins} is not a directory.`);
      }
      if (!pluginsStat) await mkdir(plugins, { mode: 0o755 });
      await mkdir(target, { mode: 0o755 });
      createdDir = true;
    }
    for (const { name, content } of sources) {
      if (!staleFiles.includes(name)) continue;
      await writePluginFile(target, name, content);
      written.push(name);
    }
    for (const step of steps) await step.apply(tx);
  } catch (error) {
    await reportFailure(error, tx, deps, async () => {
      if (createdDir) {
        await removePluginFiles(target);
        return;
      }
      for (const name of written) {
        const previous = before.get(name);
        if (previous) await writePluginFile(target, name, previous);
        else await unlink(join(target, name)).catch(() => {});
      }
    });
    return 1;
  }

  deps.stdout(
    `${createdDir ? 'Installed' : 'Updated'} the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
      `${tx.backupPath ? ` Backup of config.yaml: ${tx.backupPath}` : ''}\n`,
  );
  deps.stdout(openGatewayReport(gateway));
  if (options.noRestart) {
    deps.stdout(restartHint());
    return 0;
  }
  return (await restartHosts(cli, deps)) ? 0 : 1;
}

async function reportFailure(
  error: unknown,
  tx: ConfigTransaction,
  deps: HermesPluginDeps,
  restoreFiles: () => Promise<void>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  let outcome: string;
  try {
    const rollback = await tx.rollback();
    if (rollback === 'kept') {
      outcome =
        `config.yaml changed outside this run, so it was not restored. Applied steps:\n` +
        `${tx.applied.map((step) => `  - ${step}\n`).join('')}` +
        `Backup: ${tx.backupPath}\n`;
    } else {
      await restoreFiles();
      outcome = rollback === 'restored'
        ? `config.yaml was restored from ${tx.backupPath}.\n`
        : 'No Hermes config was changed.\n';
    }
  } catch (rollbackError) {
    outcome =
      `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Applied steps:\n` +
      `${tx.applied.map((step) => `  - ${step}\n`).join('')}` +
      `${tx.backupPath ? `Backup: ${tx.backupPath}\n` : ''}`;
  }
  deps.stderr(`${message}\n${outcome}`);
}

function failure(error: unknown, deps: HermesPluginDeps, prefix: string): number {
  const message = error instanceof HermesPluginError ? error.message : `${prefix} failed: ${error instanceof Error ? error.message : String(error)}`;
  deps.stderr(`${message}\n`);
  return 1;
}

export async function runHermesPluginInstall(command: HermesPluginInstallCommand, deps: HermesPluginDeps): Promise<number> {
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
  } catch (error) {
    return failure(error, deps, 'Install');
  }
}

/**
 * `borg update`: activate the installed plugin (the plugin directory is the
 * marker). Without the directory this does nothing and runs no hermes command.
 */
export async function activateHermesPlugin(deps: HermesPluginDeps): Promise<number> {
  try {
    const home = resolveHermesHome(undefined, deps);
    const dir = await lstatOrNull(hermesPluginDir(home));
    if (!dir) return 0;
    deps.stdout(`Activating the Hermes plugin ${HERMES_PLUGIN_NAME}.\n`);
    return await activate(home, { dryRun: false, noRestart: false, mayCreate: false }, deps);
  } catch (error) {
    const code = failure(error, deps, 'Hermes plugin activation');
    deps.stderr('Rerun `borg representative hermes-plugin install` to finish the activation.\n');
    return code;
  }
}

export async function runHermesPluginUninstall(command: HermesPluginUninstallCommand, deps: HermesPluginDeps): Promise<number> {
  try {
    const home = resolveHermesHome(command.hermesHome, deps);
    await requireHermesHome(home);
    const cli = deps.hermes(home);
    const config = new HermesConfig(cli);
    const target = hermesPluginDir(home);
    const dirState = await pluginDirState(home);

    const steps: Step[] = [];
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
      if (isBorgMcpEntry(mcp)) steps.push({ describe: `unset ${KEYS.mcp}`, apply: (tx) => tx.unset(KEYS.mcp) });
      else foreignMcp = true;
    }
    const foreignNote = foreignMcp ? `${KEYS.mcp} is not a Borg representative entry; it was left in place.\n` : '';

    if (dirState === 'absent' && steps.length === 0) {
      deps.stdout(`The Hermes plugin ${HERMES_PLUGIN_NAME} is not installed in ${home}; nothing was changed.\n${foreignNote}`);
      return 0;
    }
    const plan = [
      ...steps.map((step) => step.describe),
      ...(dirState === 'directory' ? [`remove ${HERMES_PLUGIN_FILES.map((name) => join(target, name)).join(' and ')}, then the directory if empty`] : []),
      ...(command.noRestart ? [] : restartCommands().map((argv) => `hermes ${argv.join(' ')}`)),
    ];
    if (command.dryRun) {
      deps.stdout(`Hermes home: ${home}\nDry run; nothing was changed. Planned steps:\n${plan.map((step) => `  - ${step}\n`).join('')}${foreignNote}`);
      return 0;
    }
    deps.stdout(`Hermes home: ${home}\nSteps:\n${plan.map((step) => `  - ${step}\n`).join('')}`);

    const tx = new ConfigTransaction(home, config, deps.now);
    try {
      for (const step of steps) await step.apply(tx);
    } catch (error) {
      await reportFailure(error, tx, deps, async () => {});
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
      deps.stdout(restartHint().replace('To load the plugin', 'To unload the plugin'));
      return 0;
    }
    return (await restartHosts(cli, deps)) ? 0 : 1;
  } catch (error) {
    return failure(error, deps, 'Uninstall');
  }
}

function isBorgMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = (value as { args?: unknown }).args;
  return Array.isArray(args) && args[0] === 'representative' && args[1] === 'mcp';
}
