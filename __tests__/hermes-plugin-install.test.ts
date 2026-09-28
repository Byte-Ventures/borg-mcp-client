/**
 * `borg representative hermes-plugin install | uninstall` and the `borg update`
 * activation, against a FAKE hermes CLI only (__tests__/fixtures/fake-hermes.mjs).
 * No test runs the real `hermes` (decision ebbfb45c): every Hermes CLI in this
 * file is built from the fake's absolute path, never resolved from PATH.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BACKUPS_KEPT,
  HERMES_PLUGIN_FILES,
  HERMES_PLUGIN_NAME,
  activateHermesPlugin,
  configSetText,
  execFileHermesCli,
  packagedHermesPluginDir,
  printableUntrusted,
  runHermesPluginInstall,
  runHermesPluginUninstall,
  type HermesPluginDeps,
  type HermesPluginInstallCommand,
} from '../src/hermes-plugin-install.js';
import { parseRepresentativeArgs } from '../src/representative-cmd.js';

const FAKE_SOURCE = fileURLToPath(new URL('./fixtures/fake-hermes.mjs', import.meta.url));
const BORG = '/opt/borg/bin/borg';
const DM = 'agent:main:telegram:dm:12345';

let root: string;
let home: string;
let fake: string;
let log: string;
let rules: string;
let worktree: string;
let out: string[];
let err: string[];

function hermesEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    FAKE_HERMES_ROOT: root,
    FAKE_HERMES_LOG: log,
    FAKE_HERMES_RULES: rules,
    ...extra,
  };
}

function deps(overrides: Partial<HermesPluginDeps> & { hermesEnv?: NodeJS.ProcessEnv; worktrees?: string[] | null } = {}): HermesPluginDeps {
  const { hermesEnv: extraEnv, worktrees, ...rest } = overrides;
  const env = hermesEnv(extraEnv);
  return {
    env,
    homedir: () => join(root, 'user-home'),
    sourceDir: packagedHermesPluginDir(),
    hermes: (h) => execFileHermesCli(fake, h, env),
    borgCommand: () => BORG,
    bindings: async () => (worktrees === undefined ? [worktree] : worktrees),
    isTTY: () => false,
    prompt: async () => null,
    now: () => new Date(),
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    ...rest,
  };
}

const install = (command: Partial<HermesPluginInstallCommand> = {}, d = deps()) =>
  runHermesPluginInstall({ hermesHome: home, dryRun: false, noRestart: false, ...command }, d);

const pluginDir = () => join(home, 'plugins', HERMES_PLUGIN_NAME);
const config = () => JSON.parse(readFileSync(join(home, 'config.yaml'), 'utf8'));
const calls = (): Array<{ argv: string[]; home: string; allowAllEnv: string[] }> =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const isRead = (argv: string[]) => (argv[0] === 'config' && argv[1] === 'get') || (argv[0] === 'gateway' && argv[1] === 'status');
const writes = () => calls().filter(({ argv }) => !isRead(argv));
const setGateway = (value: Record<string, unknown>) => writeFileSync(join(home, 'fake-gateway.json'), JSON.stringify(value));
const backups = () => {
  const dir = join(home, 'backups', 'borg-representative');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};
const setRules = (value: unknown[]) => writeFileSync(rules, JSON.stringify(value));
const writeSessions = (value: unknown) => {
  mkdirSync(join(home, 'sessions'), { recursive: true });
  writeFileSync(join(home, 'sessions', 'sessions.json'), JSON.stringify(value));
};
const resetLog = () => rmSync(log, { force: true });

const ORIGINAL_CONFIG = `${JSON.stringify({ model: 'keep-me', plugins: { enabled: ['other-plugin'] } }, null, 2)}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'borg-hermes-plugin-'));
  home = join(root, 'hermes-home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), ORIGINAL_CONFIG);
  worktree = join(root, 'worktrees', 'representative');
  mkdirSync(worktree, { recursive: true });
  log = join(root, 'hermes-calls.jsonl');
  rules = join(root, 'hermes-rules.json');
  fake = join(root, 'bin', 'hermes');
  mkdirSync(join(root, 'bin'));
  writeFileSync(fake, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SOURCE)} "$@"\n`);
  chmodSync(fake, 0o755);
  writeSessions({
    _README: 'legacy mirror',
    [DM]: { session_key: DM, display_name: 'Theo DM', platform: 'telegram', chat_type: 'dm' },
    'agent:main:telegram:group:-100': { display_name: 'A group' },
  });
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hermes-plugin argument parsing', () => {
  it('accepts install and uninstall with their flags', () => {
    expect(parseRepresentativeArgs(['hermes-plugin', 'install'])).toEqual({
      ok: true, command: { action: 'hermes-plugin-install', dryRun: false, noRestart: false },
    });
    expect(parseRepresentativeArgs([
      'hermes-plugin', 'install', '--hermes-home', '/h', '--worktree', '/w', '--session-key', DM, '--dry-run', '--no-restart',
    ])).toEqual({
      ok: true,
      command: { action: 'hermes-plugin-install', hermesHome: '/h', worktree: '/w', sessionKey: DM, dryRun: true, noRestart: true },
    });
    expect(parseRepresentativeArgs(['hermes-plugin', 'uninstall', '--hermes-home', '/h', '--dry-run'])).toEqual({
      ok: true, command: { action: 'hermes-plugin-uninstall', hermesHome: '/h', dryRun: true, noRestart: false },
    });
  });

  it('rejects other subcommands, relative paths, bad session keys, missing values and unknown flags', () => {
    for (const args of [
      ['hermes-plugin'],
      ['hermes-plugin', 'remove'],
      ['hermes-plugin', 'install', '--hermes-home', 'rel'],
      ['hermes-plugin', 'install', '--worktree', 'rel'],
      ['hermes-plugin', 'install', '--hermes-home'],
      ['hermes-plugin', 'install', '--force'],
      ['hermes-plugin', 'install', '--session-key', 'agent:main:telegram:group:1'],
      ['hermes-plugin', 'install', '--session-key', 'agent:work:telegram:dm:1'],
      ['hermes-plugin', 'uninstall', '--worktree', '/w'],
    ]) {
      expect(parseRepresentativeArgs(args), args.join(' ')).toMatchObject({ ok: false });
    }
  });
});

describe('hermes-plugin install', () => {
  it('installs the files, writes every value through the Hermes CLI with read-back, backs up and restarts', async () => {
    expect(await install()).toBe(0);
    expect(err.join('')).toBe('');

    expect(readdirSync(pluginDir()).sort()).toEqual([...HERMES_PLUGIN_FILES].sort());
    for (const name of HERMES_PLUGIN_FILES) {
      expect(readFileSync(join(pluginDir(), name))).toEqual(readFileSync(join(packagedHermesPluginDir(), name)));
    }
    const written = config();
    expect(written.model).toBe('keep-me');
    expect(written.plugins.enabled).toEqual(['other-plugin', HERMES_PLUGIN_NAME]);
    expect(written.plugins.entries[HERMES_PLUGIN_NAME]).toEqual({
      allow_gateway_injection: true,
      settings: { session_key: DM, worktree, borg_command: BORG },
    });
    expect(written.mcp_servers['borg-representative']).toEqual({
      command: BORG, args: ['representative', 'mcp', '--worktree', worktree], lazy: true,
    });

    // One HERMES_HOME for every call, execFile argv (no shell), allow-all switches never inherited.
    expect(calls().every((call) => call.home === home && call.allowAllEnv.length === 0)).toBe(true);
    const sets = writes().filter(({ argv }) => argv[1] === 'set').map(({ argv }) => argv.slice(2));
    expect(sets).toContainEqual([`plugins.entries.${HERMES_PLUGIN_NAME}.settings.session_key`, DM]);
    expect(sets).toContainEqual([`plugins.entries.${HERMES_PLUGIN_NAME}.allow_gateway_injection`, 'true']);
    // Every write is followed by its read-back.
    for (const [key] of sets) {
      const index = calls().findIndex(({ argv }) => argv[1] === 'set' && argv[2] === key);
      expect(calls()[index + 1].argv).toEqual(['config', 'get', key, '--json', '--raw']);
    }
    expect(writes().slice(-2).map(({ argv }) => argv)).toEqual([['serve', '--stop'], ['gateway', 'restart']]);

    const [backup] = backups();
    const backupPath = join(home, 'backups', 'borg-representative', backup);
    expect(readFileSync(backupPath, 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'backups', 'borg-representative')).mode & 0o777).toBe(0o700);
    const text = out.join('');
    expect(text).toContain(`Conversation: ${DM} (the only gateway DM conversation)`);
    expect(text).toContain(`Backup of config.yaml: ${backupPath}`);
    expect(text.indexOf('hermes serve --stop')).toBeLessThan(text.indexOf('Running `hermes serve --stop`'));
  });

  it('is idempotent: a second run makes no write, no backup and no restart', async () => {
    expect(await install()).toBe(0);
    const before = readFileSync(join(home, 'config.yaml'));
    const backupCount = backups().length;
    resetLog();
    out = [];

    expect(await install()).toBe(0);
    expect(writes()).toEqual([]);
    expect(backups()).toHaveLength(backupCount);
    expect(readFileSync(join(home, 'config.yaml'))).toEqual(before);
    expect(out.join('')).toContain('already installed and configured; nothing was changed');
  });

  it('round-trips a worktree path with YAML and flow syntax exactly, with no extra keys', async () => {
    const hostile = join(root, 'wt, lazy: false] # "q" \'s\' {x}');
    mkdirSync(hostile, { recursive: true });
    expect(await install({ worktree: hostile }, deps({ worktrees: [worktree, hostile] }))).toBe(0);
    const entry = config().mcp_servers['borg-representative'];
    expect(Object.keys(entry).sort()).toEqual(['args', 'command', 'lazy']);
    expect(entry).toEqual({ command: BORG, args: ['representative', 'mcp', '--worktree', hostile], lazy: true });
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.worktree).toBe(hostile);
  });

  it('reads values past Hermes startup output printed before the JSON line', async () => {
    expect(await install({}, deps({ hermesEnv: { FAKE_HERMES_NOISE: '1' } }))).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.session_key).toBe(DM);
  });

  it('--dry-run runs only config reads and changes nothing', async () => {
    expect(await install({ dryRun: true })).toBe(0);
    expect(writes()).toEqual([]);
    expect(calls().length).toBeGreaterThan(0);
    expect(existsSync(pluginDir())).toBe(false);
    expect(existsSync(join(home, 'backups'))).toBe(false);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ORIGINAL_CONFIG);
    const text = out.join('');
    expect(text).toContain('Dry run; nothing was changed.');
    expect(text).toContain(`create ${pluginDir()}`);
    expect(text).toContain('hermes plugins enable');
  });

  it('--dry-run does not import representative state: it needs --worktree when none exists', async () => {
    const initializeFlags: boolean[] = [];
    const d = deps({ bindings: async ({ initialize }) => { initializeFlags.push(initialize); return null; } });
    expect(await install({ dryRun: true }, d)).toBe(1);
    expect(err.join('')).toContain('Pass --worktree <path>');
    expect(initializeFlags).toEqual([false]);
    expect(await install({ dryRun: true, worktree }, d)).toBe(0);
  });

  it('--no-restart skips both restarts and prints the commands', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    expect(writes().some(({ argv }) => argv[0] === 'gateway' || argv[0] === 'serve')).toBe(false);
    expect(out.join('')).toContain('run `hermes serve --stop` and restart the gateway (`hermes gateway restart`)');
  });

  it('migrates a 5.x install: refreshes the files, unsets the old settings, keeps the configured conversation', async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), 'plugin.yaml'), 'name: borg-representative-push\nversion: 1.0.0\n');
    writeFileSync(join(pluginDir(), '__init__.py'), '# 5.x plugin\n');
    const kept = 'agent:main:discord:dm:777';
    writeFileSync(join(home, 'config.yaml'), JSON.stringify({
      plugins: {
        enabled: [HERMES_PLUGIN_NAME],
        entries: {
          [HERMES_PLUGIN_NAME]: {
            allow_gateway_injection: true,
            settings: { session_key: kept, worktree, mcp_server: 'borg-representative', reinject_after_s: 600, max_reinjects: 3 },
          },
        },
      },
    }));

    expect(await install()).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings).toEqual({ session_key: kept, worktree, borg_command: BORG });
    expect(readFileSync(join(pluginDir(), '__init__.py'))).toEqual(readFileSync(join(packagedHermesPluginDir(), '__init__.py')));
    expect(out.join('')).toContain('kept from the current plugin settings');
    expect(out.join('')).toContain('Updated the Hermes plugin');
  });

  it('refuses a symbolic-link or non-directory plugin path, a missing home and a linked backups directory', async () => {
    mkdirSync(join(home, 'plugins'));
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, pluginDir());
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('symbolic link');
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(pluginDir());
    writeFileSync(pluginDir(), 'not a directory');
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('is not a directory');
    rmSync(pluginDir());

    expect(await install({ hermesHome: join(root, 'missing') })).toBe(1);
    expect(err.join('')).toContain('No Hermes home');

    mkdirSync(join(root, 'backups-elsewhere'));
    symlinkSync(join(root, 'backups-elsewhere'), join(home, 'backups'));
    err = [];
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('is not a directory');
    expect(readdirSync(join(root, 'backups-elsewhere'))).toEqual([]);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(existsSync(pluginDir())).toBe(false);
  });

  it('keeps the newest backups only', async () => {
    const dir = join(home, 'backups', 'borg-representative');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 7; i += 1) writeFileSync(join(dir, `config.yaml.2020010${i}T000000000Z`), 'old');
    writeFileSync(join(dir, 'unrelated.txt'), 'kept');
    expect(await install()).toBe(0);
    const remaining = readdirSync(dir).filter((name) => name.startsWith('config.yaml.'));
    expect(remaining).toHaveLength(BACKUPS_KEPT);
    expect(remaining.some((name) => name.startsWith('config.yaml.2020'))).toBe(true);
    expect(readdirSync(dir)).toContain('unrelated.txt');
  });
});

describe('hermes-plugin install rollback', () => {
  it('restores the backup and removes a new plugin directory when a write fails', async () => {
    setRules([{ match: 'config set mcp_servers.borg-representative', code: 1, stderr: 'boom' }]);
    expect(await install()).toBe(1);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(existsSync(pluginDir())).toBe(false);
    expect(err.join('')).toContain('boom');
    expect(err.join('')).toMatch(/config\.yaml was restored from .*borg-representative\/config\.yaml\./);
    expect(writes().some(({ argv }) => argv[0] === 'gateway')).toBe(false);
  });

  it('fails when the read-back differs from the intended value, then restores', async () => {
    setRules([{ match: `config set plugins.entries.${HERMES_PLUGIN_NAME}.settings.worktree`, store: '/somewhere/else' }]);
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('Hermes stored');
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(ORIGINAL_CONFIG);
  });

  it('restores the previous plugin files of an existing install on failure', async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), 'plugin.yaml'), 'old manifest\n');
    writeFileSync(join(pluginDir(), '__init__.py'), '# old\n');
    setRules([{ match: 'plugins enable', code: 1 }]);
    expect(await install()).toBe(1);
    expect(readFileSync(join(pluginDir(), 'plugin.yaml'), 'utf8')).toBe('old manifest\n');
    expect(readFileSync(join(pluginDir(), '__init__.py'), 'utf8')).toBe('# old\n');
  });

  it('never overwrites a config.yaml changed by someone else during the run', async () => {
    setRules([{ match: 'config set mcp_servers.borg-representative', code: 1, touch: true }]);
    expect(await install()).toBe(1);
    const after = config();
    expect(after.touched_by_someone_else).toBe(true);
    const message = err.join('');
    expect(message).toContain('config.yaml changed outside this run, so it was not restored');
    expect(message).toContain(`set plugins.entries.${HERMES_PLUGIN_NAME}.settings.session_key`);
    expect(message).toMatch(/Backup: .*config\.yaml\./);
  });

  it('reports a failed restart after a completed configuration', async () => {
    setRules([{ match: 'gateway restart', code: 1, stderr: 'Gateway service restart failed.' }]);
    expect(await install()).toBe(1);
    expect(config().plugins.enabled).toContain(HERMES_PLUGIN_NAME);
    expect(err.join('')).toContain('Run `hermes gateway restart` yourself where the gateway runs');
  });

  it('reports a hermes executable that cannot be run', async () => {
    const d = deps();
    const missing = execFileHermesCli(join(root, 'no-such-hermes'), home, d.env);
    expect(await install({}, { ...d, hermes: () => missing })).toBe(1);
    expect(err.join('')).toMatch(/exit 127/);
  });
});

describe('gateway restart only under a service (D2)', () => {
  const restarts = () => writes().filter(({ argv }) => argv[0] === 'gateway' && argv[1] === 'restart');

  it('restarts a launchd- or systemd-managed gateway and confirms the new PID with gateway status', async () => {
    for (const mode of ['launchd', 'systemd']) {
      resetLog(); out = [];
      rmSync(pluginDir(), { recursive: true, force: true });
      writeFileSync(join(home, 'config.yaml'), ORIGINAL_CONFIG);
      setGateway({ mode, pid: 100 });
      expect(await install(), mode).toBe(0);
      expect(restarts()).toHaveLength(1);
      const statusCalls = calls().filter(({ argv }) => argv[0] === 'gateway' && argv[1] === 'status');
      expect(statusCalls).toHaveLength(2); // before and after the restart
      expect(out.join('')).toContain('The Hermes gateway restarted (PID 101)');
    }
  });

  it.each([
    ['manual', 'was started by hand'],
    ['multiplexed', "runs inside the default profile's gateway"],
    ['stopped', 'is not running; it will load the plugin when it starts'],
    ['odd', 'did not show a service-managed gateway'],
  ])('never runs gateway restart for a %s gateway, and says what to do', async (mode, message) => {
    setGateway({ mode, pid: 100 });
    expect(await install()).toBe(0);
    expect(restarts()).toEqual([]);
    expect(existsSync(join(home, 'fake-foreground-gateway'))).toBe(false);
    expect(writes().map(({ argv }) => argv)).toContainEqual(['serve', '--stop']);
    expect(out.join('')).toContain(message);
  });

  it('fails when the restart cannot be confirmed', async () => {
    setGateway({ mode: 'launchd', pid: 100, restartKeepsPid: true });
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('could not be confirmed');
  });

  it('kills only its own hermes child when a restart exceeds the hard timeout', async () => {
    setGateway({ mode: 'launchd', pid: 100, hang: true });
    const d = deps();
    const started = Date.now();
    expect(await install({}, { ...d, hermes: (h) => execFileHermesCli(fake, h, d.env, { timeoutMs: 1_500 }) })).toBe(1);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(err.join('')).toMatch(/gateway restart` failed \(exit 124\): timed out after 2 s/);
    const hung = readFileSync(join(home, 'fake-foreground-gateway'), 'utf8').trim().split('\n').map(Number);
    for (const pid of hung) expect(() => process.kill(pid, 0)).toThrow();
  }, 60_000);
});

describe('session_key discovery (untrusted sessions.json)', () => {
  it('lists several DM candidates, stripped of control characters, and refuses without a terminal', async () => {
    writeSessions({
      [DM]: { display_name: 'Theo\u001b[31m DM‮' },
      'agent:main:discord:dm:42': { origin: { chat_name: 'Other\u0007' } },
      'agent:main:telegram:dm:bad key': {},
    });
    expect(await install()).toBe(1);
    const message = err.join('');
    expect(message).toContain(`${DM}  (Theo[31m DM)`);
    expect(message).toContain('agent:main:discord:dm:42  (Other)');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('bad key');
    expect(writes()).toEqual([]);
  });

  it('lets a terminal user pick one candidate', async () => {
    writeSessions({ [DM]: {}, 'agent:main:discord:dm:42': {} });
    expect(await install({}, deps({ isTTY: () => true, prompt: async () => '1' }))).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.session_key).toBe('agent:main:discord:dm:42');
  });

  it('treats a linked, oversized or non-object sessions.json as unavailable', async () => {
    const path = join(home, 'sessions', 'sessions.json');
    const real = join(root, 'real-sessions.json');
    writeFileSync(real, JSON.stringify({ [DM]: {} }));
    rmSync(path);
    symlinkSync(real, path);
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('No gateway DM conversation was found');

    rmSync(path);
    writeFileSync(path, JSON.stringify({ [DM]: {}, pad: 'x'.repeat(1024 * 1024) }));
    expect(await install()).toBe(1);

    writeFileSync(path, JSON.stringify([DM]));
    expect(await install()).toBe(1);
    expect(writes()).toEqual([]);
  });

  it('uses --session-key over discovery', async () => {
    rmSync(join(home, 'sessions'), { recursive: true });
    expect(await install({ sessionKey: 'agent:main:slack:dm:U1' })).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.session_key).toBe('agent:main:slack:dm:U1');
  });
});

describe('worktree from the representative binding state', () => {
  it('refuses with no binding, several bindings, or an unbound --worktree', async () => {
    expect(await install({}, deps({ worktrees: [] }))).toBe(1);
    expect(err.join('')).toContain('borg representative prepare');
    err = [];
    expect(await install({}, deps({ worktrees: ['/a', '/b'] }))).toBe(1);
    expect(err.join('')).toContain('pass one with --worktree');
    err = [];
    expect(await install({ worktree: '/c' }, deps({ worktrees: ['/a', '/b'] }))).toBe(1);
    expect(err.join('')).toContain('/c is not a prepared representative worktree');
    expect(writes()).toEqual([]);
  });
});

describe('open-gateway report', () => {
  it('reports allow-all switches from Hermes config, .env and this shell, and never refuses', async () => {
    writeFileSync(join(home, '.env'), 'GATEWAY_ALLOW_ALL_USERS=true\n');
    expect(await install({}, deps({ hermesEnv: { TELEGRAM_ALLOW_ALL_USERS: 'yes' } }))).toBe(0);
    const text = out.join('');
    expect(text).toContain('Open gateway (GATEWAY_ALLOW_ALL_USERS, TELEGRAM_ALLOW_ALL_USERS (this shell\'s environment))');
    // The shell's switch never reaches Hermes, so the .env reading is Hermes's own.
    expect(calls().every((call) => call.allowAllEnv.length === 0)).toBe(true);
  });

  it('reports a closed gateway when nothing is set', async () => {
    expect(await install()).toBe(0);
    expect(out.join('')).toContain('no allow-all switch is set');
  });
});

describe('hermes-plugin uninstall', () => {
  const uninstall = (command: { dryRun?: boolean; noRestart?: boolean } = {}) =>
    runHermesPluginUninstall({ hermesHome: home, dryRun: false, noRestart: false, ...command }, deps());

  it('reverses only the Borg-owned entries, removes the files and restarts', async () => {
    expect(await install()).toBe(0);
    resetLog();
    expect(await uninstall()).toBe(0);
    const after = config();
    expect(after.plugins.enabled).toEqual(['other-plugin']);
    expect(after.plugins.entries?.[HERMES_PLUGIN_NAME]).toBeUndefined();
    expect(after.mcp_servers?.['borg-representative']).toBeUndefined();
    expect(after.model).toBe('keep-me');
    expect(existsSync(pluginDir())).toBe(false);
    expect(writes().slice(-2).map(({ argv }) => argv)).toEqual([['serve', '--stop'], ['gateway', 'restart']]);
    expect(backups().length).toBeGreaterThanOrEqual(2);

    resetLog();
    out = [];
    expect(await uninstall()).toBe(0);
    expect(writes()).toEqual([]);
    expect(out.join('')).toContain('is not installed');
  });

  it('keeps a foreign MCP entry and a plugin directory holding other files', async () => {
    expect(await install()).toBe(0);
    writeFileSync(join(home, 'config.yaml'), JSON.stringify({
      ...config(),
      mcp_servers: { 'borg-representative': { command: 'something-else', args: [] } },
    }));
    writeFileSync(join(pluginDir(), 'notes.txt'), 'mine');
    expect(await uninstall({ noRestart: true })).toBe(0);
    expect(config().mcp_servers['borg-representative']).toEqual({ command: 'something-else', args: [] });
    expect(readdirSync(pluginDir())).toEqual(['notes.txt']);
    expect(out.join('')).toContain('not a Borg representative entry; it was left in place');
  });

  it('--dry-run only reads', async () => {
    expect(await install()).toBe(0);
    const before = readFileSync(join(home, 'config.yaml'));
    resetLog();
    expect(await uninstall({ dryRun: true })).toBe(0);
    expect(writes()).toEqual([]);
    expect(readFileSync(join(home, 'config.yaml'))).toEqual(before);
    expect(existsSync(pluginDir())).toBe(true);
  });

  it('restores the backup when an uninstall write fails', async () => {
    expect(await install()).toBe(0);
    const before = readFileSync(join(home, 'config.yaml'), 'utf8');
    setRules([{ match: `config unset plugins.entries.${HERMES_PLUGIN_NAME}`, code: 1 }]);
    expect(await uninstall()).toBe(1);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe(before);
    expect(existsSync(pluginDir())).toBe(true);
  });
});

describe('activateHermesPlugin (borg update)', () => {
  const activation = (d = deps()) => activateHermesPlugin({ ...d, env: { ...d.env, HERMES_HOME: home } });

  it('does nothing, and runs no hermes command, without the plugin directory', async () => {
    expect(await activation()).toBe(0);
    expect(calls()).toEqual([]);
    expect(out).toEqual([]);
  });

  it('activates an installed plugin with the configured conversation and no prompt', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    writeFileSync(join(pluginDir(), '__init__.py'), '# stale\n');
    resetLog();
    const d = deps({ prompt: async () => { throw new Error('activation must not prompt'); } });
    expect(await activation(d)).toBe(0);
    expect(readFileSync(join(pluginDir(), '__init__.py'))).toEqual(readFileSync(join(packagedHermesPluginDir(), '__init__.py')));
    expect(writes().slice(-2).map(({ argv }) => argv)).toEqual([['serve', '--stop'], ['gateway', 'restart']]);
  });

  it('fails with the install command when it cannot choose a conversation', async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeSessions({ [DM]: {}, 'agent:main:discord:dm:42': {} });
    expect(await activation()).toBe(1);
    expect(err.join('')).toContain('borg representative hermes-plugin install');
    expect(writes()).toEqual([]);
  });

  it('never creates the plugin directory', async () => {
    expect(await activation()).toBe(0);
    expect(existsSync(pluginDir())).toBe(false);
    expect(lstatSync(home).isDirectory()).toBe(true);
  });
});

describe('value encoding', () => {
  it('passes strings raw and containers or booleans as JSON; refuses strings Hermes would parse', () => {
    expect(configSetText('/a/b')).toBe('/a/b');
    expect(configSetText(true)).toBe('true');
    expect(configSetText({ a: ['x'] })).toBe('{"a":["x"]}');
    for (const bad of ['', '[x', '{x', 'a\nb']) expect(() => configSetText(bad)).toThrow();
  });

  it('strips control and bidirectional characters from untrusted text', () => {
    expect(printableUntrusted('a\u0000b\u001bc\u009bd‮e⁦f')).toBe('abcdef');
    expect(printableUntrusted('x'.repeat(100)).length).toBe(80);
  });
});
