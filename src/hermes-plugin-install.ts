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
import { constants as fsConstants } from 'node:fs';
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
  disabled: 'plugins.disabled',
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
   * Worktrees of the prepared representative bindings, read only. Without
   * representative state yet, these are the 5.x bindings its first-generation
   * import would bind (the same read-only preview). Nothing is created: the
   * state is imported by `borg representative mcp` or `listen` on first use.
   */
  bindings(): Promise<string[]>;
  isTTY(): boolean;
  /** Reads one answer line from the terminal; null on EOF. */
  prompt(question: string): Promise<string | null>;
  now(): Date;
  /** Pending-activation records (Borg's own state, never Hermes config). */
  activation: ActivationStore;
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
export function execFileHermesCli(
  command: string,
  home: string,
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number } = {},
): HermesCli {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!allowAllEnvName(name)) childEnv[name] = value;
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
    bindings: async () => {
      const { createRepresentativeStore } = await import('./representative-store.js');
      const store = createRepresentativeStore();
      if (await store.initialized()) return (await store.listBindings()).map((binding) => binding.worktree);
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
        rl.once('close', () => { if (!answered) resolve(null); });
      });
    },
    now: () => new Date(),
    activation: fileActivationStore(),
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

  /** The value Hermes holds after a set must be exactly the intended one. */
  async verifySet(key: string, value: unknown): Promise<void> {
    const actual = await this.get(key);
    if (actual === ABSENT || !isDeepStrictEqual(actual, value)) {
      throw new HermesPluginError(
        `Hermes stored ${key} as ${actual === ABSENT ? 'nothing' : JSON.stringify(actual)}, not ${JSON.stringify(value)}.`,
      );
    }
  }

  /** `config unset` on a key that is already absent is success. */
  async unset(key: string): Promise<void> {
    const argv = ['config', 'unset', key];
    const result = await this.cli(argv);
    if (result.code !== 0 && !result.stderr.includes('Config key not set')) {
      throw new HermesPluginError(describeFailure(argv, result));
    }
  }

  async verifyUnset(key: string): Promise<void> {
    if ((await this.get(key)) !== ABSENT) throw new HermesPluginError(`Hermes still holds ${key} after unset.`);
  }
}

// ---------------------------------------------------------------------------
// config.yaml backup and per-key rollback

async function readConfigBytes(path: string): Promise<Buffer | null> {
  const st = await lstatOrNull(path);
  if (!st) return null;
  if (!st.isFile()) throw new HermesPluginError(`${path} is not a regular file; nothing was changed.`);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * A directory Borg owns: created 0700; an existing one must be a real
 * directory owned by this user. The mode is set through a descriptor opened
 * with O_DIRECTORY|O_NOFOLLOW and checked with fstat, so a path swapped for a
 * symlink after a check is never followed.
 */
async function ensurePrivateDir(path: string): Promise<void> {
  if (!await lstatOrNull(path)) await mkdir(path, { mode: 0o700 });
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw new HermesPluginError(`${path} is not a directory (${errnoCode(error) ?? 'unreadable'}); nothing was changed.`);
  }
  try {
    const st = await handle.stat();
    if (!st.isDirectory()) throw new HermesPluginError(`${path} is not a directory; nothing was changed.`);
    if (!ownedByMe(st.uid)) throw new HermesPluginError(`${path} is not owned by this user; nothing was changed.`);
    // mkdir's mode is filtered by the umask; an existing directory may be wider.
    if ((st.mode & 0o777) !== 0o700) await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

/** A directory Borg shares with Hermes: created 0700 when missing, otherwise only checked. */
async function ensureRealDir(path: string): Promise<void> {
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

/** How to reverse one write: the value before it and the value it wrote. */
type Undo =
  | { kind: 'key'; key: string; before: ConfigValue; wrote: ConfigValue }
  | { kind: 'enable'; addedToEnabled: boolean; removedFromDisabled: boolean };

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
  private backup: string | null = null;
  private readonly undo: Undo[] = [];
  /** The plugin's entry before this run; when it was absent, a rollback leaves no empty entry behind. */
  private entryBefore: ConfigValue = ABSENT;

  constructor(
    private readonly home: string,
    private readonly config: HermesConfig,
    private readonly now: () => Date,
  ) {}

  get backupPath(): string | null {
    return this.backup;
  }

  get wrote(): boolean {
    return this.undo.length > 0;
  }

  private async begin(): Promise<void> {
    if (this.backup) return;
    this.entryBefore = await this.config.get(ENTRY_KEY);
    const original = await readConfigBytes(join(this.home, 'config.yaml'));
    const backupsRoot = join(this.home, 'backups');
    const dir = join(backupsRoot, 'borg-representative');
    await ensureRealDir(backupsRoot);
    await ensurePrivateDir(dir);
    for (let attempt = 0; ; attempt += 1) {
      const path = join(dir, `config.yaml.${stamp(this.now())}${attempt ? `-${attempt}` : ''}`);
      try {
        const handle = await open(
          path,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(original ?? Buffer.alloc(0));
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.backup = path;
        break;
      } catch (error) {
        if (errnoCode(error) !== 'EEXIST' || attempt >= 20) throw error;
      }
    }
    await pruneBackups(dir);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.begin();
    const before = await this.config.get(key);
    // Recorded before the command: a failed command may still have written.
    this.undo.push({ kind: 'key', key, before, wrote: value });
    await this.config.run(['config', 'set', key, configSetText(value)]);
    await this.config.verifySet(key, value);
  }

  async unset(key: string): Promise<void> {
    await this.begin();
    const before = await this.config.get(key);
    this.undo.push({ kind: 'key', key, before, wrote: ABSENT });
    await this.config.unset(key);
    await this.config.verifyUnset(key);
  }

  async enablePlugin(): Promise<void> {
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
  async rollback(): Promise<{ reversed: string[]; left: string[] }> {
    const reversed: string[] = [];
    const left: string[] = [];
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
        } else {
          await this.config.run(['config', 'set', step.key, configSetText(step.before)]);
          await this.config.verifySet(step.key, step.before);
        }
        reversed.push(step.key);
      } catch (error) {
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
      } catch (error) {
        left.push(`${ENTRY_KEY} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return { reversed, left };
  }

  private async reverseEnable(step: Extract<Undo, { kind: 'enable' }>, reversed: string[], left: string[]): Promise<void> {
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
      } else {
        left.push(`${KEYS.disabled} (already lists the plugin)`);
      }
    }
  }
}

/** A mapping that holds nothing but (nested) empty mappings: what unsetting its leaves leaves behind. */
function onlyEmptyMappings(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(onlyEmptyMappings);
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
// Activation state: desired generations and the generation confirmed loaded

/** The digest of an uninstall: nothing of Borg's in Hermes. */
export const ABSENT_GENERATION = 'absent';
const RECORD_MAX_BYTES = 4096;
const DIGEST = /^(?:absent|[0-9a-f]{64})$/;

/** A gateway identity is a positive integer PID; anything else is unknown. */
export function validPid(value: unknown): string | null {
  return typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) ? value : null;
}

/**
 * One write of Borg's managed state. `id` is unique per write, so a later
 * write of the same content (A -> B -> A) is a new generation that needs its
 * own evidence; `digest` is what was written (`absent` for an uninstall);
 * `gateway_pid` is the gateway PID sampled at that write.
 */
export interface Generation {
  id: string;
  digest: string;
  gateway_pid: string | null;
}

/**
 * `<borg config>/hermes-plugin/<sha256(home)>.json`, per Hermes home:
 * - desired: the generation Borg last wrote;
 * - activated: the id of the generation the gateway is confirmed to have
 *   loaded (null: none confirmed);
 * - desktop_reload: the Borg MCP entry changed, and a running Hermes Desktop
 *   keeps the previous one until /reload-mcp or a restart. Borg cannot confirm
 *   that step; the next run that finds the entry unchanged clears it.
 * The activation is pending until `activated` names the desired generation.
 */
export interface ActivationRecord {
  version: 3;
  hermes_home: string;
  desired: Generation;
  activated: string | null;
  desktop_reload: boolean;
}

export const activationPending = (record: ActivationRecord | null): boolean =>
  record === null || record.activated !== record.desired.id;

export interface ActivationStore {
  /** null when there is no record; a record whose content cannot be trusted reads as nothing confirmed. */
  read(home: string): Promise<ActivationRecord | null>;
  write(record: ActivationRecord): Promise<void>;
  clear(home: string): Promise<void>;
}

const ownedByMe = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();

function parseRecord(text: string, home: string): ActivationRecord {
  const untrusted: ActivationRecord = {
    version: 3, hermes_home: home, desired: { id: 'untrusted', digest: 'untrusted', gateway_pid: null }, activated: null, desktop_reload: false,
  };
  let value: Partial<ActivationRecord>;
  try {
    value = JSON.parse(text) as Partial<ActivationRecord>;
  } catch {
    return untrusted;
  }
  const desired = value.desired as Partial<Generation> | undefined;
  const valid = value.version === 3 && value.hermes_home === home &&
    desired !== null && typeof desired === 'object' &&
    isRepresentativeUuid(desired.id) && typeof desired.digest === 'string' && DIGEST.test(desired.digest) &&
    (desired.gateway_pid === null || validPid(desired.gateway_pid) !== null) &&
    (value.activated === null || isRepresentativeUuid(value.activated)) &&
    typeof value.desktop_reload === 'boolean';
  // Malformed content never confirms anything: it reads as pending with no known gateway identity.
  return valid ? value as ActivationRecord : untrusted;
}

/**
 * The activation records, under `<borg config>/hermes-plugin`. The directory
 * and every ancestor from the Borg home root are checked with the reviewed S1
 * walk (validatePrivateDirectory), on reads as well as writes; the record is
 * opened O_NOFOLLOW|O_NONBLOCK (a FIFO or device never blocks) and must fstat
 * as a regular file owned by this user, mode 0600, at most 4 KiB.
 */
export function fileActivationStore(): ActivationStore {
  const dir = () => join(borgConfigRoot(), 'hermes-plugin');
  const pathFor = (home: string) => join(dir(), `${createHash('sha256').update(home).digest('hex')}.json`);
  const privateDir = async (create: boolean): Promise<boolean> => {
    try {
      return await validatePrivateDirectory(dir(), create);
    } catch (error) {
      throw new HermesPluginError(`Unsafe Borg state path: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`);
    }
  };
  return {
    read: async (home) => {
      if (!await privateDir(false)) return null;
      const path = pathFor(home);
      let handle;
      try {
        handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT') return null;
        throw new HermesPluginError(`Unsafe Borg state file ${path} (${errnoCode(error) ?? 'unreadable'}). Nothing was changed.`);
      }
      try {
        const st = await handle.stat();
        if (!st.isFile() || !ownedByMe(st.uid) || (st.mode & 0o777) !== 0o600 || st.size > RECORD_MAX_BYTES) {
          throw new HermesPluginError(
            `Unsafe Borg state file ${path}: it must be a regular file owned by you, mode 0600, at most ${RECORD_MAX_BYTES} bytes. Nothing was changed.`,
          );
        }
        return parseRecord((await handle.readFile()).toString('utf8'), home);
      } finally {
        await handle.close();
      }
    },
    write: async (record) => {
      await privateDir(true);
      const path = pathFor(record.hermes_home);
      const temporary = `${path}.${process.pid}.tmp`;
      const handle = await open(
        temporary,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      await syncDirectory(dir());
    },
    clear: async (home) => {
      if (!await privateDir(false)) return;
      const path = pathFor(home);
      const st = await lstatOrNull(path);
      if (st?.isFile()) {
        await unlink(path);
        await syncDirectory(dir());
      }
    },
  };
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
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

/**
 * The install marker is Borg's own manifest, `<plugin dir>/plugin.yaml`, as a
 * regular file. A directory without it (for example one uninstall left because
 * it holds other files) is not an install, and `borg update` never touches it.
 */
async function installState(home: string): Promise<'absent' | 'installed' | 'directory-only'> {
  const target = hermesPluginDir(home);
  const st = await lstatOrNull(target);
  if (!st) return 'absent';
  if (st.isSymbolicLink()) throw new HermesPluginError(`${target} is a symbolic link; remove it yourself, then rerun.`);
  if (!st.isDirectory()) throw new HermesPluginError(`${target} exists and is not a directory.`);
  const manifest = await lstatOrNull(join(target, 'plugin.yaml'));
  if (manifest && !manifest.isFile()) throw new HermesPluginError(`${join(target, 'plugin.yaml')} is not a regular file.`);
  return manifest ? 'installed' : 'directory-only';
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

/** Python's bytecode cache for the plugin module: `__pycache__/__init__.<tag>.pyc`. */
const PLUGIN_BYTECODE = /^__init__\.[A-Za-z0-9_.-]+\.pyc$/;

/**
 * Remove Borg's files: `__init__.py`, its bytecode cache, then `plugin.yaml`
 * (the marker) last, then the directory when nothing else is left in it.
 * Anything else is kept, and a directory without `plugin.yaml` is no install.
 */
async function removePluginFiles(target: string): Promise<'removed' | 'kept-other-files'> {
  const init = join(target, '__init__.py');
  if ((await lstatOrNull(init))?.isFile()) await unlink(init);
  const cache = join(target, '__pycache__');
  const cacheStat = await lstatOrNull(cache);
  if (cacheStat?.isDirectory() && !cacheStat.isSymbolicLink()) {
    for (const name of await readdir(cache)) {
      if (PLUGIN_BYTECODE.test(name) && (await lstatOrNull(join(cache, name)))?.isFile()) await unlink(join(cache, name));
    }
    await rmdir(cache).catch((error: unknown) => {
      if (errnoCode(error) !== 'ENOTEMPTY' && errnoCode(error) !== 'EEXIST') throw error;
    });
  }
  const manifest = join(target, 'plugin.yaml');
  if ((await lstatOrNull(manifest))?.isFile()) await unlink(manifest);
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
    // O_NONBLOCK: a FIFO swapped in after the lstat never blocks; fstat then refuses it.
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
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

/**
 * The conversation to wake, without asking yet. Borg never picks one without
 * the operator's confirmation (design rev 2 §6): on a gateway that allows
 * several users, the only DM in sessions.json can be someone else's.
 * - `--session-key`, or the key already configured, is used as given.
 * - Otherwise, when the run can ask (a terminal, not a dry run): the
 *   candidates, to be shown and confirmed once every other check has passed.
 * - Otherwise (no terminal, including `borg update`): refused, naming the
 *   candidates and the exact command with --session-key.
 * - A dry run shows a single candidate as the one install would ask about.
 */
async function planSessionKey(
  home: string,
  configured: ConfigValue,
  explicit: string | undefined,
  deps: HermesPluginDeps,
  dryRun: boolean,
  retry: (sessionKey: string) => string,
): Promise<{ sessionKey: string; source: string } | { candidates: SessionCandidate[] }> {
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
  if (dryRun && candidates.length === 1) {
    return { sessionKey: candidates[0].sessionKey, source: 'the only gateway DM conversation; install asks you to confirm it' };
  }
  if (!deps.isTTY() || dryRun) {
    throw new HermesPluginError(
      `Borg does not choose the conversation to wake without your confirmation. Gateway DM conversations found:\n` +
        `${listCandidates(candidates)}Run install with the one that is yours, for example:\n` +
        candidates.map((candidate) => `  ${retry(candidate.sessionKey)}\n`).join('').trimEnd(),
    );
  }
  return { candidates };
}

function listCandidates(candidates: SessionCandidate[]): string {
  return candidates.map((candidate, index) => `  ${index + 1}. ${describeCandidate(candidate)}\n`).join('');
}

/** A numbered choice at the terminal; anything else refuses with nothing changed. */
async function promptChoice<T>(deps: HermesPluginDeps, question: string, choices: T[], none: string): Promise<T> {
  const answer = await deps.prompt(`${question} [1-${choices.length}] `);
  const index = answer === null ? Number.NaN : Number(answer.trim()) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= choices.length) throw new HermesPluginError(none);
  return choices[index];
}

/**
 * The questions, asked only after every check that can refuse has passed: the
 * worktree when several are prepared, then the conversation, confirmed with
 * [y/N] (the default is no). Nothing has been written when a question is asked.
 */
async function askSelections(
  deps: HermesPluginDeps,
  worktreePlan: { worktree: string } | { choices: string[] },
  sessionPlan: { sessionKey: string; source: string } | { candidates: SessionCandidate[] },
): Promise<{ worktree: string; sessionKey: string; source: string }> {
  let worktree: string;
  if ('choices' in worktreePlan) {
    deps.stdout(`Prepared representative worktrees:\n${worktreePlan.choices.map((path, index) => `  ${index + 1}. ${path}\n`).join('')}`);
    worktree = await promptChoice(deps, 'Use which worktree?', worktreePlan.choices, 'No worktree was chosen; nothing was changed.');
  } else {
    worktree = worktreePlan.worktree;
  }
  if (!('candidates' in sessionPlan)) return { worktree, ...sessionPlan };
  const candidates = sessionPlan.candidates;
  deps.stdout(`Gateway DM conversations found in Hermes (confirm that it is your own DM):\n${listCandidates(candidates)}`);
  const chosen = candidates.length > 1
    ? await promptChoice(deps, 'Wake which conversation?', candidates, 'No conversation was chosen; nothing was changed.')
    : candidates[0];
  const confirm = await deps.prompt(`Wake ${describeCandidate(chosen)} for Borg Coordinator replies? [y/N] `);
  if (confirm === null || !/^(?:y|yes)$/i.test(confirm.trim())) {
    throw new HermesPluginError('The conversation was not confirmed; nothing was changed.');
  }
  return { worktree, sessionKey: chosen.sessionKey, source: 'confirmed by you' };
}

// ---------------------------------------------------------------------------
// Worktree from the representative binding state

/**
 * The worktree, without asking yet. Read only: the installer never creates
 * representative state, on any path. With several prepared and no
 * --worktree or still-bound configured one: the choices when the run can ask,
 * otherwise a refusal with one exact command per worktree.
 */
async function planWorktree(
  explicit: string | undefined,
  configured: ConfigValue,
  deps: HermesPluginDeps,
  interactive: boolean,
  retry: (worktree: string) => string,
): Promise<{ worktree: string } | { choices: string[] }> {
  const worktrees = await deps.bindings();
  if (explicit !== undefined) {
    if (!worktrees.includes(explicit)) {
      throw new HermesPluginError(`${explicit} is not a prepared representative worktree. Prepared: ${worktrees.join(', ') || 'none'}.`);
    }
    return { worktree: explicit };
  }
  if (typeof configured === 'string' && worktrees.includes(configured)) return { worktree: configured };
  if (worktrees.length === 1) return { worktree: worktrees[0] };
  if (worktrees.length === 0) {
    throw new HermesPluginError(
      'No representative connection is prepared. Run `borg representative prepare --coordinator <drone-label>` first.',
    );
  }
  if (interactive) return { choices: worktrees };
  throw new HermesPluginError(
    `Several representative worktrees are prepared. Run install with the one to use:\n` +
      worktrees.map((path) => `  ${retry(path)}\n`).join('').trimEnd(),
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

async function openGatewaySwitches(
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

/** What the run does to the Borg MCP entry, for the Hermes Desktop line. */
type McpChange = 'added' | 'changed' | null;

const DESKTOP_ADDED = 'Hermes Desktop: new chats get the Borg tools.\n';
const DESKTOP_RELOAD =
  'Hermes Desktop: run /reload-mcp in each open chat, or restart Hermes Desktop, to use the updated Borg tools. ' +
  'Borg does not restart Desktop and cannot confirm this step.\n';

async function configSteps(config: HermesConfig, target: Target): Promise<{ steps: Step[]; mcp: McpChange }> {
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
  const currentMcp = await config.get(KEYS.mcp);
  const mcp: McpChange = currentMcp === ABSENT ? 'added' : isDeepStrictEqual(currentMcp, mcpEntry(target)) ? null : 'changed';
  await setIfDifferent(KEYS.mcp, mcpEntry(target));
  const enabled = await config.get(KEYS.enabled);
  const disabled = await config.get(KEYS.disabled);
  const listed = Array.isArray(enabled) && enabled.includes(HERMES_PLUGIN_NAME);
  const blocked = Array.isArray(disabled) && disabled.includes(HERMES_PLUGIN_NAME);
  if (!listed || blocked) {
    steps.push({ describe: `hermes plugins enable ${HERMES_PLUGIN_NAME}`, apply: (tx) => tx.enablePlugin() });
  }
  return { steps, mcp };
}

export type GatewaySupervision =
  | { kind: 'service'; pid: string | null }
  | { kind: 'manual'; pid: string | null }
  | { kind: 'multiplexed' }
  | { kind: 'stopped' }
  | { kind: 'unknown' };

/**
 * The gateway's supervision state from the documented `hermes gateway status`
 * ("Show service status"). Its text is not a machine contract, so only the
 * positive service-managed lines count as supervised; anything unrecognised is
 * `unknown`, and Borg never restarts an unknown gateway.
 */
export function parseGatewayStatus(stdout: string): GatewaySupervision {
  const launchd = stdout.match(/Gateway is supervised by launchd \(PID (\d+)\)/);
  if (launchd) return { kind: 'service', pid: launchd[1] };
  if (/gateway service is running/i.test(stdout)) {
    return { kind: 'service', pid: stdout.match(/Main PID:\s*(\d+)/)?.[1] ?? null };
  }
  if (/Running manually, not as a system service/.test(stdout)) {
    return { kind: 'manual', pid: stdout.match(/Gateway is running \(PID: (\d+)\)/)?.[1] ?? null };
  }
  if (/Gateway is running via the default-profile multiplexer/.test(stdout)) return { kind: 'multiplexed' };
  if (/Gateway is not running|gateway service is stopped|Gateway service is not loaded/i.test(stdout)) return { kind: 'stopped' };
  return { kind: 'unknown' };
}

async function gatewaySupervision(cli: HermesCli): Promise<GatewaySupervision> {
  const result = await cli(['gateway', 'status']);
  return result.code === 0 ? parseGatewayStatus(result.stdout) : { kind: 'unknown' };
}

const gatewayPid = (state: GatewaySupervision): string | null =>
  state.kind === 'service' || state.kind === 'manual' ? validPid(state.pid) : null;

const RESTART_PLAN = 'hermes gateway restart, only when the gateway runs as a launchd/systemd service';

type HostOutcome = 'complete' | 'action-needed' | 'failed';

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
async function activateHosts(
  cli: HermesCli,
  deps: HermesPluginDeps,
  verb: 'load' | 'unload',
  writtenWithPid: string | null,
): Promise<HostOutcome> {
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
    deps.stderr(
      `The gateway restart is unconfirmed: \`hermes gateway status\` did not show a new PID ` +
        `(before ${oldPid ?? 'unknown'}, after ${newPid ?? 'unknown'}). Check it, or run ${command}.\n`,
    );
    return 'failed';
  }
  deps.stdout(`The Hermes gateway restarted (PID ${oldPid} -> ${newPid}).\n`);
  return 'complete';
}

/**
 * The generation of what install writes: a digest of Borg's plugin files and
 * managed keys. Equal generations mean nothing Borg manages changed.
 */
function desiredGeneration(sources: Array<{ name: string; content: Buffer }>, target: Target): string {
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
async function beginGeneration(
  cli: HermesCli,
  home: string,
  digest: string,
  previous: ActivationRecord | null,
  desktopReload: boolean,
): Promise<ActivationRecord> {
  return {
    version: 3,
    hermes_home: home,
    desired: { id: randomUUID(), digest, gateway_pid: gatewayPid(await gatewaySupervision(cli)) },
    activated: previous?.activated ?? null,
    desktop_reload: desktopReload,
  };
}

/** Finish the host step for a record; the record is kept as written unless the step is confirmed. */
async function finishGeneration(
  cli: HermesCli,
  deps: HermesPluginDeps,
  record: ActivationRecord,
  noRestart: boolean,
  verb: 'load' | 'unload',
  rerun: string,
): Promise<number> {
  if (noRestart) {
    deps.stdout(`Restart skipped (--no-restart); the activation stays pending. Run \`${rerun}\` without --no-restart to finish it.\n`);
    return 0;
  }
  const outcome = await activateHosts(cli, deps, verb, record.desired.gateway_pid);
  if (outcome === 'complete') {
    if (record.desired.digest === ABSENT_GENERATION) await deps.activation.clear(record.hermes_home);
    else await deps.activation.write({ ...record, activated: record.desired.id });
    return 0;
  }
  deps.stdout(`The activation stays pending; after that, rerun \`${rerun}\` to finish it.\n`);
  return outcome === 'failed' ? 1 : 0;
}

interface ActivationOptions {
  explicitWorktree?: string;
  explicitSessionKey?: string;
  /** The selectors this run was given, so a printed retry targets the same install. */
  invocation: { hermesHome?: string; worktree?: string };
  dryRun: boolean;
  noRestart: boolean;
  /** install may create the plugin; `borg update` never does. */
  mayCreate: boolean;
}

const INSTALL_COMMAND = 'borg representative hermes-plugin install';

/**
 * An install command for the operator to run: built from the selectors of the
 * current invocation (--hermes-home when one was given, --worktree when one
 * was given) plus the given session key, every value shell-quoted.
 */
export function installCommand(selectors: { hermesHome?: string; worktree?: string; sessionKey?: string }): string {
  return [
    INSTALL_COMMAND,
    ...(selectors.hermesHome !== undefined ? ['--hermes-home', shellEscape(selectors.hermesHome)] : []),
    ...(selectors.worktree !== undefined ? ['--worktree', shellEscape(selectors.worktree)] : []),
    ...(selectors.sessionKey !== undefined ? ['--session-key', shellEscape(selectors.sessionKey)] : []),
  ].join(' ');
}
/** The uninstall command for the same Hermes home, shell-quoted. */
export function uninstallCommand(hermesHome: string | undefined): string {
  return ['borg representative hermes-plugin uninstall', ...(hermesHome !== undefined ? ['--hermes-home', shellEscape(hermesHome)] : [])].join(' ');
}

async function activate(home: string, options: ActivationOptions, deps: HermesPluginDeps): Promise<number> {
  const cli = deps.hermes(home);
  const config = new HermesConfig(cli);
  const target = hermesPluginDir(home);
  const state = await installState(home);
  if (state !== 'installed' && !options.mayCreate) return 0;
  const previous = await deps.activation.read(home);
  const sources = await readSources(deps.sourceDir);
  const before = state === 'absent' ? new Map<string, Buffer | null>() : await snapshotPluginFiles(target);
  const staleFiles = sources.filter(({ name, content }) => !before.get(name)?.equals(content)).map(({ name }) => name);

  const configuredSessionKey = await config.get(KEYS.sessionKey);
  const configuredWorktree = await config.get(KEYS.worktree);
  // Every check that can refuse runs before any question, and every question
  // before the first write. The lookups are read only: the installer never
  // creates representative state (mcp/listen import it on first use).
  const interactive = deps.isTTY() && !options.dryRun;
  const worktreePlan = await planWorktree(
    options.explicitWorktree, configuredWorktree, deps, interactive,
    (path) => installCommand({
      ...options.invocation, worktree: path,
      ...(options.explicitSessionKey !== undefined ? { sessionKey: options.explicitSessionKey } : {}),
    }),
  );
  const sessionPlan = await planSessionKey(
    home, configuredSessionKey, options.explicitSessionKey, deps, options.dryRun,
    (key) => installCommand({ ...options.invocation, sessionKey: key }),
  );
  const borgCommand = deps.borgCommand();
  if (!isAbsolute(borgCommand)) throw new HermesPluginError(`The borg executable path is not absolute: ${borgCommand}`);
  const { worktree, sessionKey, source } = await askSelections(deps, worktreePlan, sessionPlan);
  const wanted: Target = { sessionKey, worktree, borgCommand };
  const { steps, mcp } = await configSteps(config, wanted);
  const gateway = await openGatewaySwitches(config, platformOf(sessionKey), deps.env);
  const desired = desiredGeneration(sources, wanted);

  const summary =
    `Hermes home:  ${home}\n` +
    `Conversation: ${sessionKey} (${source})\n` +
    `Worktree:     ${worktree}\n` +
    `borg:         ${borgCommand}\n`;

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
  const written: string[] = [];
  try {
    if (state === 'absent') {
      const plugins = join(home, 'plugins');
      const pluginsStat = await lstatOrNull(plugins);
      if (pluginsStat && (pluginsStat.isSymbolicLink() || !pluginsStat.isDirectory())) {
        throw new HermesPluginError(`${plugins} is not a directory.`);
      }
      if (!pluginsStat) await mkdir(plugins, { mode: 0o755 });
      await mkdir(target, { mode: 0o755 });
      createdDir = true;
    }
    // __init__.py first and plugin.yaml (the marker) last: an interrupted copy is never an install.
    for (const name of ['__init__.py', 'plugin.yaml'] as const) {
      const source = sources.find((file) => file.name === name)!;
      if (!staleFiles.includes(name)) continue;
      await writePluginFile(target, name, source.content);
      written.push(name);
    }
    for (const step of steps) await step.apply(tx);
  } catch (error) {
    await reportFailure(error, tx, deps, async () => {
      if (createdDir) {
        await removePluginFiles(target);
      } else {
        for (const name of [...written].reverse()) {
          const prior = before.get(name);
          if (prior) await writePluginFile(target, name, prior);
          else await unlink(join(target, name)).catch(() => {});
        }
      }
      // Everything was reversed: the previous generation is current again.
      if (previous) await deps.activation.write(previous);
      else await deps.activation.clear(home);
    });
    return 1;
  }

  deps.stdout(
    `${createdDir ? 'Installed' : 'Updated'} the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
      `${tx.backupPath ? ` Backup of config.yaml (for manual recovery): ${tx.backupPath}` : ''}\n`,
  );
  deps.stdout(openGatewayReport(gateway));
  if (mcp === 'added') deps.stdout(DESKTOP_ADDED);
  if (mcp === 'changed') deps.stdout(DESKTOP_RELOAD);
  return finishGeneration(cli, deps, record, options.noRestart, 'load', installCommand(options.invocation));
}

/**
 * A failed run reverses Borg's own keys (never a whole-file restore) and then
 * its plugin files, but only when every key could be reversed.
 */
async function reportFailure(
  error: unknown,
  tx: ConfigTransaction,
  deps: HermesPluginDeps,
  restoreFiles: () => Promise<void>,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  let outcome = '';
  try {
    const { reversed, left } = await tx.rollback();
    if (reversed.length > 0) outcome += `Reversed: ${reversed.join(', ')}.\n`;
    if (left.length > 0) {
      outcome += `Left as they are: ${left.join('; ')}.\n`;
    } else {
      await restoreFiles();
    }
    if (!tx.wrote) outcome += 'No Hermes config was changed.\n';
  } catch (rollbackError) {
    outcome += `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}.\n`;
  }
  if (tx.backupPath) outcome += `config.yaml as it was before this run: ${tx.backupPath}\n`;
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
      invocation: {
        ...(command.hermesHome !== undefined ? { hermesHome: command.hermesHome } : {}),
        ...(command.worktree !== undefined ? { worktree: command.worktree } : {}),
      },
      dryRun: command.dryRun,
      noRestart: command.noRestart,
      mayCreate: true,
    }, deps);
  } catch (error) {
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
export async function activateHermesPlugin(deps: HermesPluginDeps): Promise<number> {
  const unattended: HermesPluginDeps = {
    ...deps,
    isTTY: () => false,
    prompt: async () => { throw new HermesPluginError('borg update never asks a question'); },
  };
  try {
    const home = resolveHermesHome(undefined, unattended);
    if ((await installState(home)) !== 'installed') return 0;
    unattended.stdout(`Activating the Hermes plugin ${HERMES_PLUGIN_NAME}.\n`);
    return await activate(home, { invocation: {}, dryRun: false, noRestart: false, mayCreate: false }, unattended);
  } catch (error) {
    return failure(error, unattended, 'Hermes plugin activation');
  }
}

export interface HermesPluginStatus {
  installed: boolean;
  hermes_home: string;
  /** The gateway is not confirmed to have loaded what Borg last wrote. */
  activation_pending?: boolean;
  /**
   * The Borg MCP entry changed; a running Hermes Desktop keeps the previous one
   * until /reload-mcp or a Desktop restart. Borg cannot confirm this step.
   */
  desktop_reload_pending?: boolean;
  session_key?: string | null;
  /** Allow-all switches that open the gateway to anyone; empty when none. */
  open_gateway?: string[];
  error?: string;
}

/**
 * For `borg representative status`: whether the plugin is installed and, when
 * it is, its activation state and the open-gateway report read through
 * `hermes config get`. Without an install no hermes command runs.
 */
export async function hermesPluginStatus(deps: Pick<HermesPluginDeps, 'env' | 'homedir' | 'hermes' | 'activation'>): Promise<HermesPluginStatus> {
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
  } catch (error) {
    return { installed: true, hermes_home: home, error: printableUntrusted(error instanceof Error ? error.message : String(error), 300) };
  }
}

/**
 * Uninstall is the same generation machinery with desired = absent: the
 * record stays until the gateway is confirmed to have unloaded the plugin, so
 * a rerun finishes a failed or --no-restart uninstall.
 */
export async function runHermesPluginUninstall(command: HermesPluginUninstallCommand, deps: HermesPluginDeps): Promise<number> {
  try {
    const home = resolveHermesHome(command.hermesHome, deps);
    await requireHermesHome(home);
    const cli = deps.hermes(home);
    const config = new HermesConfig(cli);
    const target = hermesPluginDir(home);
    const state = await installState(home);
    const previous = await deps.activation.read(home);

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
    let removesMcp = false;
    if (mcp !== ABSENT) {
      if (isBorgMcpEntry(mcp)) {
        steps.push({ describe: `unset ${KEYS.mcp}`, apply: (tx) => tx.unset(KEYS.mcp) });
        removesMcp = true;
      } else {
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
      for (const step of steps) await step.apply(tx);
    } catch (error) {
      await reportFailure(error, tx, deps, async () => {
        if (previous) await deps.activation.write(previous);
        else await deps.activation.clear(home);
      });
      return 1;
    }
    let dirOutcome = '';
    if (state !== 'absent') {
      dirOutcome = (await removePluginFiles(target)) === 'removed'
        ? `Removed ${target}.\n`
        : `Removed the plugin's files; ${target} holds other files and was left in place (it is no longer an install).\n`;
    }
    deps.stdout(
      `Uninstalled the Hermes plugin ${HERMES_PLUGIN_NAME}.` +
        `${tx.backupPath ? ` Backup of config.yaml (for manual recovery): ${tx.backupPath}` : ''}\n${dirOutcome}${foreignNote}` +
        `${removesMcp ? DESKTOP_RELOAD : ''}`,
    );
    return finishGeneration(cli, deps, record, command.noRestart, 'unload', uninstallCommand(command.hermesHome));
  } catch (error) {
    return failure(error, deps, 'Uninstall');
  }
}

function isBorgMcpEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = (value as { args?: unknown }).args;
  return Array.isArray(args) && args[0] === 'representative' && args[1] === 'mcp';
}
