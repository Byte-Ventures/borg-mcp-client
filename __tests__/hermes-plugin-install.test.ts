/**
 * `borg representative hermes-plugin install | uninstall` and the `borg update`
 * activation, against a FAKE hermes CLI only (__tests__/fixtures/fake-hermes.mjs).
 * No test runs the real `hermes` (decision ebbfb45c): every Hermes CLI in this
 * file is built from the fake's absolute path, never resolved from PATH.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  defaultHermesPluginDeps,
  discoverSessionKeys,
  activationPending,
  execFileHermesCli,
  fileActivationStore,
  hermesPluginStatus,
  packagedHermesPluginDir,
  parseGatewayStatus,
  printableUntrusted,
  runHermesPluginInstall,
  runHermesPluginUninstall,
  type HermesPluginDeps,
  type HermesPluginInstallCommand,
} from '../src/hermes-plugin-install.js';
import { parseRepresentativeArgs } from '../src/representative-cmd.js';
import * as guarded from '../src/guarded-fs.js';
import { representativeStateRoot, validatePrivateDirectory } from '../src/representative-db.js';
import { plantLegacyBindings } from './fixtures/representative-state.js';
import { bindingFor } from './fixtures/representative-mock-backend.js';
import { borgConfigRoot } from '../src/private-root.js';
import { execFileSync } from 'node:child_process';

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

function deps(overrides: Partial<HermesPluginDeps> & { hermesEnv?: NodeJS.ProcessEnv; worktrees?: string[] } = {}): HermesPluginDeps {
  const { hermesEnv: extraEnv, worktrees, ...rest } = overrides;
  const env = hermesEnv(extraEnv);
  return {
    env,
    homedir: () => join(root, 'user-home'),
    sourceDir: packagedHermesPluginDir(),
    hermes: (h) => execFileHermesCli(fake, h, env),
    borgCommand: () => BORG,
    bindings: async () => (worktrees === undefined ? [worktree] : worktrees),
    // An operator at a terminal who confirms the one DM shown (see the discovery tests for the rest).
    isTTY: () => true,
    prompt: async () => 'y',
    now: () => new Date(),
    activation: fileActivationStore(),
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

const originalStateRoot = process.env.BORG_STATE_ROOT;
/** Borg's activation records: the real `<borg config>/hermes-plugin` under the test's own state root. */
const stateDir = () => join(root, '.config', 'borgmcp', 'hermes-plugin');

beforeEach(() => {
  // Canonical (the S1 walk refuses a symlinked ancestor such as macOS /var -> /private/var).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-hermes-plugin-')));
  process.env.BORG_STATE_ROOT = root;
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
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = originalStateRoot;
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
    expect(writes().at(-1)?.argv).toEqual(['gateway', 'restart']);
    // Nothing is stopped or restarted in Hermes Desktop (F5).
    expect(calls().some(({ argv }) => argv[0] === 'serve' || argv[0] === 'dashboard')).toBe(false);

    const [backup] = backups();
    const backupPath = join(home, 'backups', 'borg-representative', backup);
    expect(readFileSync(backupPath, 'utf8')).toBe(ORIGINAL_CONFIG);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'backups', 'borg-representative')).mode & 0o777).toBe(0o700);
    const text = out.join('');
    expect(text).toContain(`Conversation: ${DM} (confirmed by you)`);
    expect(text).toContain(`Backup of config.yaml (for manual recovery): ${backupPath}`);
    expect(text).toContain('Hermes Desktop: new chats get the Borg tools.');
    expect(text).not.toContain('/reload-mcp');
    expect(text.indexOf('hermes gateway restart, only when')).toBeLessThan(text.indexOf('Running `hermes gateway restart`'));
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
    expect(out.join('')).toContain('installed, configured and active; nothing was changed');
    expect(out.join('')).not.toContain('Hermes Desktop');
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

  it('reads 5.x bindings read only and never creates representative state, on success too', async () => {
    plantLegacyBindings(root, [bindingFor(worktree)]);
    const d = deps({ bindings: defaultHermesPluginDeps().bindings });
    expect(await install({ dryRun: true }, d)).toBe(0);
    expect(await install({}, d)).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.worktree).toBe(worktree);
    expect(existsSync(representativeStateRoot())).toBe(false);
  });

  it('--no-restart skips the restart and leaves the activation pending; a normal rerun finishes it', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    expect(writes().some(({ argv }) => argv[0] === 'gateway' && argv[1] === 'restart')).toBe(false);
    expect(out.join('')).toContain('Restart skipped (--no-restart); the activation stays pending');
    resetLog(); out = [];
    expect(await install()).toBe(0);
    expect(writes().map(({ argv }) => argv)).toEqual([['gateway', 'restart']]);
    expect(out.join('')).toContain('finishing the pending activation');
    resetLog(); out = [];
    expect(await install()).toBe(0);
    expect(writes()).toEqual([]);
    expect(out.join('')).toContain('installed, configured and active');
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
  it('reverses its own keys through the Hermes CLI and removes a new plugin directory when a write fails', async () => {
    setRules([{ match: 'config set mcp_servers.borg-representative', code: 1, stderr: 'boom' }]);
    expect(await install()).toBe(1);
    // Every Borg key is gone; at most the now-empty `plugins.entries` mapping Hermes created for it remains.
    const { entries, ...plugins } = config().plugins;
    expect(entries ?? {}).toEqual({});
    expect({ ...config(), plugins }).toEqual(JSON.parse(ORIGINAL_CONFIG));
    expect(existsSync(pluginDir())).toBe(false);
    const message = err.join('');
    expect(message).toContain('boom');
    expect(message).toContain(`Reversed: plugins.entries.${HERMES_PLUGIN_NAME}.allow_gateway_injection`);
    expect(message).toMatch(/config\.yaml as it was before this run: .*borg-representative\/config\.yaml\./);
    // Every reversal goes through `hermes config`; the backup is never copied back.
    expect(writes().filter(({ argv }) => argv[1] === 'unset').length).toBeGreaterThan(0);
    expect(writes().some(({ argv }) => argv[0] === 'gateway')).toBe(false);
    expect(existsSync(stateDir())).toBe(true);
    expect(readdirSync(stateDir())).toEqual([]); // no pending activation
  });

  it('fails when the read-back differs from the intended value, then reverses that key too', async () => {
    setRules([{ match: `config set plugins.entries.${HERMES_PLUGIN_NAME}.settings.worktree`, store: '/somewhere/else' }]);
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('Hermes stored');
    // The stored value is not what Borg wrote, so it counts as someone else's and is left.
    expect(err.join('')).toContain(`plugins.entries.${HERMES_PLUGIN_NAME}.settings.worktree (changed outside this run)`);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings).toEqual({ worktree: '/somewhere/else' });
  });

  it('restores a previous value rather than deleting it', async () => {
    writeFileSync(join(home, 'config.yaml'), JSON.stringify({
      plugins: { entries: { [HERMES_PLUGIN_NAME]: { settings: { session_key: 'agent:main:slack:dm:OLD' } } } },
    }));
    setRules([{ match: 'config set mcp_servers.borg-representative', code: 1 }]);
    expect(await install({ sessionKey: DM })).toBe(1);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME]).toEqual({ settings: { session_key: 'agent:main:slack:dm:OLD' } });
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

  it('keeps an edit someone else made during the run', async () => {
    setRules([{ match: 'config set mcp_servers.borg-representative', code: 1, touch: true }]);
    expect(await install()).toBe(1);
    const after = config();
    expect(after.touched_by_someone_else).toBe(true);
    expect(after.plugins.entries?.[HERMES_PLUGIN_NAME]).toBeUndefined();
    expect(err.join('')).toMatch(/config\.yaml as it was before this run: .*config\.yaml\./);
  });

  it('leaves a key someone else changed after Borg wrote it', async () => {
    const d = deps();
    const original = d.hermes;
    d.hermes = (h) => {
      const cli = original(h);
      return async (argv) => {
        if (argv[0] === 'config' && argv[1] === 'set' && argv[2] === 'mcp_servers.borg-representative') {
          const current = config();
          current.plugins.entries[HERMES_PLUGIN_NAME].settings.session_key = 'agent:main:slack:dm:THEIRS';
          writeFileSync(join(home, 'config.yaml'), JSON.stringify(current));
          return { code: 1, stdout: '', stderr: 'injected failure' };
        }
        return cli(argv);
      };
    };
    expect(await install({}, d)).toBe(1);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.session_key).toBe('agent:main:slack:dm:THEIRS');
    expect(err.join('')).toContain(`plugins.entries.${HERMES_PLUGIN_NAME}.settings.session_key (changed outside this run)`);
    // A key left in place keeps Borg's plugin files too: the install stays whole for a rerun.
    expect(existsSync(join(pluginDir(), 'plugin.yaml'))).toBe(true);
  });

  it('reports a failed restart after a completed configuration', async () => {
    setRules([{ match: 'gateway restart', code: 1, stderr: 'Gateway service restart failed.' }]);
    expect(await install()).toBe(1);
    expect(config().plugins.enabled).toContain(HERMES_PLUGIN_NAME);
    expect(err.join('')).toContain('Run `hermes gateway restart` where the gateway runs to load the plugin');
    // The activation stays pending: a rerun restarts again.
    setRules([]);
    resetLog();
    expect(await install()).toBe(0);
    expect(writes().map(({ argv }) => argv)).toEqual([['gateway', 'restart']]);
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
      expect(statusCalls).toHaveLength(3); // when the config is written, before and after the restart
      expect(out.join('')).toContain('The Hermes gateway restarted (PID 100 -> 101)');
    }
  });

  it.each([
    ['manual', 'was started by hand'],
    ['multiplexed', "gateway runs inside the default profile's gateway"],
    ['stopped', 'is not running; it will load the plugin when it starts'],
    ['odd', 'did not show a service-managed gateway'],
  ])('never runs gateway restart for a %s gateway, and says what to do', async (mode, message) => {
    setGateway({ mode, pid: 100 });
    expect(await install()).toBe(0);
    expect(restarts()).toEqual([]);
    expect(existsSync(join(home, 'fake-foreground-gateway'))).toBe(false);
    expect(calls().some(({ argv }) => argv[0] === 'serve')).toBe(false);
    expect(out.join('')).toContain(message);
  });

  it('fails when the restart cannot be confirmed', async () => {
    setGateway({ mode: 'launchd', pid: 100, restartKeepsPid: true });
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('The gateway restart is unconfirmed');
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
    expect(await install({}, deps({ isTTY: () => false }))).toBe(1);
    const message = err.join('');
    expect(message).toContain(`${DM}  (Theo[31m DM)`);
    expect(message).toContain('agent:main:discord:dm:42  (Other)');
    expect(message).not.toContain('\u001b');
    expect(message).not.toContain('bad key');
    expect(writes()).toEqual([]);
  });

  it('lets a terminal user pick one candidate', async () => {
    writeSessions({ [DM]: {}, 'agent:main:discord:dm:42': {} });
    const answers = ['1', 'y'];
    const questions: string[] = [];
    expect(await install({}, deps({ isTTY: () => true, prompt: async (question) => { questions.push(question); return answers.shift() ?? null; } }))).toBe(0);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings.session_key).toBe('agent:main:discord:dm:42');
    expect(questions[1]).toContain('Wake agent:main:discord:dm:42');
    expect(questions[1]).toContain('[y/N]');
  });

  it('never picks a single candidate without confirmation (design rev 2 §6)', async () => {
    // No terminal: refused, naming the candidate and the exact command.
    expect(await install({}, deps({ isTTY: () => false }))).toBe(1);
    const message = err.join('');
    expect(message).toContain('does not choose the conversation to wake without your confirmation');
    expect(message).toContain(`1. ${DM}  (Theo DM)`);
    expect(message).toContain(`borg representative hermes-plugin install --hermes-home '${home}' --session-key '${DM}'`);
    expect(writes()).toEqual([]);

    // A terminal: the single candidate is shown and asked about; the default is no.
    for (const answer of ['', 'n', null]) {
      err = []; out = [];
      const questions: string[] = [];
      expect(await install({}, deps({ prompt: async (question) => { questions.push(question); return answer; } }))).toBe(1);
      expect(out.join('')).toContain(`1. ${DM}  (Theo DM)`);
      expect(questions).toEqual([`Wake ${DM}  (Theo DM) for Borg Coordinator replies? [y/N] `]);
      expect(err.join('')).toContain('The conversation was not confirmed; nothing was changed.');
      expect(writes()).toEqual([]);
    }
  });

  it('a dry run shows the single candidate as the one install would ask about, without asking', async () => {
    let asked = false;
    expect(await install({ dryRun: true }, deps({ isTTY: () => false, prompt: async () => { asked = true; return 'y'; } }))).toBe(0);
    expect(asked).toBe(false);
    expect(out.join('')).toContain(`Conversation: ${DM} (the only gateway DM conversation; install asks you to confirm it)`);
  });

  it('opens sessions.json non-blocking: a FIFO swapped in after the lstat is refused promptly', async () => {
    const path = join(home, 'sessions', 'sessions.json');
    const originalOpen = guarded.open;
    let swapped = false;
    const spy = vi.spyOn(guarded, 'open').mockImplementation((async (target: unknown, ...rest: unknown[]) => {
      if (target === path && !swapped) {
        swapped = true; rmSync(path); execFileSync('mkfifo', ['-m', '0600', path]);
      }
      return (originalOpen as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof guarded.open);
    const started = Date.now();
    try {
      const outcome = await Promise.race([
        discoverSessionKeys(home),
        new Promise<string>((done) => setTimeout(() => done('timed out'), 2_000)),
      ]);
      expect(outcome).toBe('unavailable');
    } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
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
    expect(await install({}, deps({ worktrees: ['/a', '/b'], isTTY: () => false }))).toBe(1);
    expect(err.join('')).toContain('Several representative worktrees are prepared. Run install with the one to use:');
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
    expect(writes().at(-1)?.argv).toEqual(['gateway', 'restart']);
    expect(calls().some(({ argv }) => argv[0] === 'serve')).toBe(false);
    expect(backups().length).toBeGreaterThanOrEqual(2);
    expect(out.join('')).toContain('Hermes Desktop: run /reload-mcp in each open chat, or restart Hermes Desktop');

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

  it('reverses its own keys when an uninstall write fails, and keeps the install', async () => {
    expect(await install()).toBe(0);
    const before = config();
    setRules([{ match: `config unset plugins.entries.${HERMES_PLUGIN_NAME}`, code: 1 }]);
    expect(await uninstall()).toBe(1);
    expect(config()).toEqual(before);
    expect(err.join('')).toContain('Reversed: plugins.enabled');
    expect(existsSync(join(pluginDir(), 'plugin.yaml'))).toBe(true);
  });

  it('removes the Python bytecode cache with the plugin files, so the directory goes too', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    mkdirSync(join(pluginDir(), '__pycache__'));
    writeFileSync(join(pluginDir(), '__pycache__', '__init__.cpython-313.pyc'), 'cache');
    expect(await uninstall({ noRestart: true })).toBe(0);
    expect(existsSync(pluginDir())).toBe(false);
    // --no-restart: the unload stays pending until a rerun confirms it.
    expect(activationPending(await deps().activation.read(home))).toBe(true);
    expect(await uninstall()).toBe(0);
    expect(readdirSync(stateDir())).toEqual([]);
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
    expect(writes().at(-1)?.argv).toEqual(['gateway', 'restart']);
  });

  it('reports, without prompting, when it cannot choose a conversation', async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), 'plugin.yaml'), 'name: borg-representative-push\n');
    writeSessions({ [DM]: {}, 'agent:main:discord:dm:42': {} });
    expect(await activation()).toBe(1);
    expect(err.join('')).toContain('does not choose the conversation to wake without your confirmation');
    expect(writes()).toEqual([]);
  });

  it("treats a plugin directory without Borg's plugin.yaml as no install", async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), 'notes.txt'), 'mine');
    expect(await activation()).toBe(0);
    expect(calls()).toEqual([]);
    expect(readdirSync(pluginDir())).toEqual(['notes.txt']);
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

describe('status report', () => {
  const statusDeps = (d = deps()) => ({ ...d, env: { ...d.env, HERMES_HOME: home } });

  it('reports not installed without running hermes', async () => {
    expect(await hermesPluginStatus(statusDeps())).toEqual({ installed: false, hermes_home: home });
    expect(calls()).toEqual([]);
  });

  it('reports the conversation and the open-gateway switches of an installed plugin, through reads only', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    writeFileSync(join(home, '.env'), 'TELEGRAM_ALLOW_ALL_USERS=1\n');
    resetLog();
    expect(await hermesPluginStatus(statusDeps())).toEqual({
      installed: true, hermes_home: home, activation_pending: true, desktop_reload_pending: false,
      session_key: DM, open_gateway: ['TELEGRAM_ALLOW_ALL_USERS'],
    });
    expect(writes()).toEqual([]);
  });
});

describe('gateway status parsing', () => {
  it('counts only positive service lines as supervised', () => {
    expect(parseGatewayStatus('✓ Gateway is supervised by launchd (PID 42)\n')).toEqual({ kind: 'service', pid: '42' });
    expect(parseGatewayStatus('✓ User gateway service is running\n Main PID: 7 (python)\n')).toEqual({ kind: 'service', pid: '7' });
    expect(parseGatewayStatus('✓ System gateway service is running\n')).toEqual({ kind: 'service', pid: null });
    expect(parseGatewayStatus('✓ Gateway is running (PID: 9)\n  (Running manually, not as a system service)\n')).toEqual({ kind: 'manual', pid: '9' });
    expect(parseGatewayStatus('⚠ Gateway service is registered but launchd is not supervising it\n')).toEqual({ kind: 'unknown' });
    expect(parseGatewayStatus('✗ Gateway service is not loaded\n')).toEqual({ kind: 'stopped' });
    expect(parseGatewayStatus('')).toEqual({ kind: 'unknown' });
  });
});

describe('CR S4 lifecycle probes (review 846e63fe)', () => {
  it('CR uninstall with Python cache stays uninstalled on update', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    mkdirSync(join(pluginDir(), '__pycache__'));
    writeFileSync(join(pluginDir(), '__pycache__', '__init__.cpython-313.pyc'), 'cache');
    expect(await runHermesPluginUninstall({ hermesHome: home, dryRun: false, noRestart: true }, deps())).toBe(0);
    resetLog();
    expect(await activateHermesPlugin(deps({ env: { HERMES_HOME: home } }))).toBe(0);
    expect(existsSync(join(pluginDir(), 'plugin.yaml'))).toBe(false);
    expect(writes()).toEqual([]);
  });

  it('CR rerun completes activation after restart failure', async () => {
    setGateway({ mode: 'launchd', pid: 100, restartKeepsPid: true });
    expect(await install()).toBe(1);
    setGateway({ mode: 'launchd', pid: 100 });
    resetLog();
    expect(await install()).toBe(0);
    expect(calls().some(({ argv }) => argv.join(' ') === 'gateway restart')).toBe(true);
  });

  it('CR service without PID cannot confirm restart', async () => {
    const d = deps();
    const original = d.hermes;
    d.hermes = (h) => {
      const cli = original(h);
      return async (argv) => argv.join(' ') === 'gateway status'
        ? { code: 0, stdout: 'User gateway service is running\n', stderr: '' }
        : cli(argv);
    };
    expect(await install({}, d)).toBe(1);
  });

  it('CR preserves concurrent config edit after a successful write', async () => {
    const d = deps();
    const original = d.hermes;
    d.hermes = (h) => {
      const cli = original(h);
      return async (argv) => {
        if (argv[0] === 'config' && argv[1] === 'set' && argv[2].endsWith('.worktree')) {
          return { code: 1, stdout: '', stderr: 'injected failure' };
        }
        const result = await cli(argv);
        if (argv[0] === 'config' && argv[1] === 'set' && argv[2].endsWith('.session_key')) {
          writeFileSync(join(home, 'config.yaml'), JSON.stringify({ ...config(), unrelated_operator_edit: 'keep' }));
        }
        return result;
      };
    };
    expect(await install({}, d)).toBe(1);
    expect(config().unrelated_operator_edit).toBe('keep');
  });
});

describe('activation state (F2, F6)', () => {
  it('counts a hand-started gateway as reloaded once its PID differs from the one at write time', async () => {
    setGateway({ mode: 'manual', pid: 200 });
    expect(await install()).toBe(0);
    expect(out.join('')).toContain('Action needed: the Hermes gateway was started by hand');
    resetLog(); out = [];
    expect(await install()).toBe(0);
    expect(out.join('')).toContain('Action needed'); // same PID: still pending
    setGateway({ mode: 'manual', pid: 201 });
    resetLog(); out = [];
    expect(await install()).toBe(0);
    expect(out.join('')).toContain('was restarted since this change was written (PID 201)');
    expect(restartsIn(calls())).toEqual([]);
    resetLog(); out = [];
    expect(await install()).toBe(0);
    expect(out.join('')).toContain('installed, configured and active');
    expect(calls().some(({ argv }) => argv[0] === 'gateway')).toBe(false);
  });

  it('never confirms a restart when the PID after it is missing', async () => {
    const d = deps();
    const original = d.hermes;
    let restarted = false;
    d.hermes = (h) => {
      const cli = original(h);
      return async (argv) => {
        if (argv.join(' ') === 'gateway restart') restarted = true;
        if (argv.join(' ') === 'gateway status' && restarted) return { code: 0, stdout: 'User gateway service is running\n', stderr: '' };
        return cli(argv);
      };
    };
    expect(await install({}, d)).toBe(1);
    expect(err.join('')).toContain('The gateway restart is unconfirmed');
    expect(err.join('')).toContain('before 100, after unknown');
  });
});

function restartsIn(list: Array<{ argv: string[] }>) {
  return list.filter(({ argv }) => argv[0] === 'gateway' && argv[1] === 'restart');
}

describe('Hermes Desktop (F5)', () => {
  it('prints the reload line for a changed entry, reports it pending in status, and clears it when the entry is unchanged', async () => {
    expect(await install()).toBe(0);
    const other = join(root, 'worktrees', 'second');
    mkdirSync(other, { recursive: true });
    out = [];
    expect(await install({ worktree: other }, deps({ worktrees: [worktree, other] }))).toBe(0);
    expect(out.join('')).toContain('Hermes Desktop: run /reload-mcp in each open chat, or restart Hermes Desktop');
    expect(out.join('')).toContain('cannot confirm this step');
    const statusDeps = { ...deps(), env: { ...deps().env, HERMES_HOME: home } };
    expect(await hermesPluginStatus(statusDeps)).toMatchObject({ activation_pending: false, desktop_reload_pending: true });
    out = [];
    expect(await install({ worktree: other }, deps({ worktrees: [worktree, other] }))).toBe(0);
    expect(out.join('')).not.toContain('Hermes Desktop');
    expect(await hermesPluginStatus(statusDeps)).toMatchObject({ desktop_reload_pending: false });
  });
});

describe('backup directory mode (P3)', () => {
  it('brings an existing borg-representative backup directory to 0700', async () => {
    mkdirSync(join(home, 'backups', 'borg-representative'), { recursive: true, mode: 0o755 });
    chmodSync(join(home, 'backups', 'borg-representative'), 0o755);
    expect(await install()).toBe(0);
    expect(statSync(join(home, 'backups', 'borg-representative')).mode & 0o777).toBe(0o700);
  });
});

// Review 40f9dcf8 (round 2) probes as regression controls. The record is now a
// desired-generation model (dispatch 350da38d), so "gateway_pending" reads as
// activationPending(record), and the PID sampled at a write is desired.gateway_pid.
describe('CR round 2 boundary probes', () => {
  const recordPath = () => {
    const dir = stateDir();
    return join(dir, readdirSync(dir).find((name) => name.endsWith('.json'))!);
  };

  it('keeps new config pending when the manual PID changed before this write', async () => {
    setGateway({ mode: 'manual', pid: 200 });
    expect(await install()).toBe(0);
    setGateway({ mode: 'manual', pid: 201 });
    const other = join(root, 'second'); mkdirSync(other);
    expect(await install({ worktree: other }, deps({ worktrees: [worktree, other] }))).toBe(0);
    expect(activationPending(await deps().activation.read(home))).toBe(true);
    expect((await deps().activation.read(home))?.desired.gateway_pid).toBe('201'); // sampled at this write
  });

  it('refuses an unsafe symlink ancestor activation record', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    const dir = stateDir();
    const outside = join(root, 'untrusted-state');
    renameSync(dir, outside); chmodSync(outside, 0o777); symlinkSync(outside, dir);
    const path = join(outside, readdirSync(outside)[0]);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...record, activated: record.desired.id })); chmodSync(path, 0o666);
    err = [];
    expect(await install()).toBe(1);
    expect(err.join('')).toContain('Unsafe Borg state path');
    expect(err.join('')).toContain(dir);
  });

  it('refuses a record file with a loose mode or another shape, naming it', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    const path = recordPath();
    chmodSync(path, 0o644);
    err = [];
    expect(await install()).toBe(1);
    expect(err.join('')).toContain(`Unsafe Borg state file ${path}`);
    chmodSync(path, 0o600);
    const target = join(root, 'elsewhere.json'); writeFileSync(target, readFileSync(path)); chmodSync(target, 0o600);
    rmSync(path); symlinkSync(target, path);
    err = [];
    expect(await install()).toBe(1);
    expect(err.join('')).toContain(`Unsafe Borg state file ${path}`);
  });

  it('malformed PID cannot falsely complete manual activation', async () => {
    setGateway({ mode: 'manual', pid: 200 });
    expect(await install()).toBe(0);
    const path = recordPath();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...record, desired: { ...record.desired, gateway_pid: 'not-a-pid' } }));
    expect(await install()).toBe(0);
    expect(activationPending(await deps().activation.read(home))).toBe(true);
    expect(out.join('')).not.toContain('was restarted since');
  });

  it('chmod cannot follow a replacement symlink after the owner check', async () => {
    const dir = join(home, 'backups', 'borg-representative');
    mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o755);
    const victim = join(root, 'unrelated'); mkdirSync(victim); chmodSync(victim, 0o755);
    // The mode is set through a no-follow descriptor, so the swap is placed at
    // the open of that descriptor, the last point before the mode change.
    const originalOpen = guarded.open;
    let swapped = false;
    const spy = vi.spyOn(guarded, 'open').mockImplementation((async (path: unknown, ...rest: unknown[]) => {
      if (path === dir && !swapped) {
        swapped = true; renameSync(dir, `${dir}-old`); symlinkSync(victim, dir);
      }
      return (originalOpen as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof guarded.open);
    try { await install(); } finally { spy.mockRestore(); }
    expect(swapped).toBe(true);
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  it('rerun finishes a failed uninstall restart', async () => {
    expect(await install()).toBe(0);
    setGateway({ mode: 'launchd', pid: 101, restartKeepsPid: true });
    const command = { hermesHome: home, dryRun: false, noRestart: false };
    expect(await runHermesPluginUninstall(command, deps())).toBe(1);
    setGateway({ mode: 'launchd', pid: 101 }); resetLog();
    expect(await runHermesPluginUninstall(command, deps())).toBe(0);
    expect(restartsIn(calls()).length).toBe(1);
    expect(await deps().activation.read(home)).toBeNull();
  });
});

describe('CR round 2 rollback and prompt probes', () => {
  it('documents the accepted same-key interval between the rollback check and the reversal (decision 350da38d)', async () => {
    // Not a guarantee: Hermes writes config without lock or compare, so an edit
    // to the same key between Borg's check and its reversal is not detected.
    const d = deps(); const original = d.hermes;
    let rollback = false; let swapped = false;
    d.hermes = (h) => {
      const cli = original(h);
      return async (argv) => {
        if (argv[0] === 'config' && argv[1] === 'set' && argv[2].endsWith('.worktree')) {
          rollback = true; return { code: 1, stdout: '', stderr: 'fail worktree' };
        }
        const result = await cli(argv);
        if (rollback && !swapped && argv[0] === 'config' && argv[1] === 'get' && argv[2].endsWith('.session_key')) {
          swapped = true;
          const current = config(); current.plugins.entries[HERMES_PLUGIN_NAME].settings.session_key = 'agent:main:slack:dm:THEIRS';
          writeFileSync(join(home, 'config.yaml'), JSON.stringify(current));
        }
        return result;
      };
    };
    expect(await install({}, d)).toBe(1);
    expect(swapped).toBe(true);
    // The accepted residual: the edit made inside the interval is not preserved.
    expect(config().plugins.entries?.[HERMES_PLUGIN_NAME]?.settings?.session_key).toBeUndefined();
  });

  it('update activation never prompts even on a TTY with several choices', async () => {
    expect(await install()).toBe(0);
    const current = config(); delete current.plugins.entries[HERMES_PLUGIN_NAME].settings.session_key;
    writeFileSync(join(home, 'config.yaml'), JSON.stringify(current));
    writeSessions({ [DM]: {}, 'agent:main:slack:dm:OTHER': {} });
    let prompted = false;
    const d = deps({ env: { HERMES_HOME: home }, isTTY: () => true, prompt: async () => { prompted = true; return null; } });
    expect(await activateHermesPlugin(d)).toBe(1);
    expect(prompted).toBe(false);
    expect(err.join('')).toContain('does not choose the conversation to wake without your confirmation');
  });
});

describe('no pathname chmod in the installer (P3a)', () => {
  it('sets modes only through descriptors', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'hermes-plugin-install.ts'), 'utf8');
    expect(source).not.toMatch(/(?<![.\w])chmod\(/);
    expect(source).not.toMatch(/import \{[^}]*\bchmod\b[^}]*\} from '\.\/guarded-fs\.js'/);
  });
});

// Review 08793b26 (round 3) probes as regression controls. The record path is
// now validated by S1's validatePrivateDirectory (dispatch 0644303f), so an
// unsafe default layout is refused on write as well as on read.
describe('CR round 3 boundaries', () => {
  it.each(['symlink-config', 'mode-0755'])('matches S1 default-path safety: %s', async (kind) => {
    const oldRoot = process.env.BORG_STATE_ROOT;
    const isolated = join(root, 'default-home'); mkdirSync(isolated, { mode: 0o700 });
    process.env.BORG_STATE_ROOT = isolated;
    try {
      const cfg = join(isolated, '.config');
      if (kind === 'symlink-config') {
        const elsewhere = join(root, 'config-elsewhere'); mkdirSync(elsewhere, { mode: 0o700 }); symlinkSync(elsewhere, cfg);
      } else mkdirSync(cfg, { mode: 0o700 });
      const borg = borgConfigRoot(); mkdirSync(borg, { mode: kind === 'mode-0755' ? 0o755 : 0o700 });
      if (kind === 'mode-0755') chmodSync(borg, 0o755);
      const dir = join(borg, 'hermes-plugin'); mkdirSync(dir, { mode: 0o700 });
      const store = fileActivationStore();
      const id = '11111111-1111-4111-8111-111111111111';
      const record = {
        version: 3 as const, hermes_home: home, desired: { id, digest: 'a'.repeat(64), gateway_pid: '200' }, activated: id, desktop_reload: false,
      };
      await expect(store.write(record)).rejects.toThrow(/Unsafe Borg state path/);
      await expect(validatePrivateDirectory(dir, false)).rejects.toThrow();
      await expect(store.read(home)).rejects.toThrow(/Unsafe Borg state path/);
    } finally {
      if (oldRoot === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = oldRoot;
    }
  });

  it('keeps a rewritten earlier digest pending after --no-restart', async () => {
    expect(await install()).toBe(0); // A is confirmed
    const other = join(root, 'other'); mkdirSync(other);
    const d = deps({ worktrees: [worktree, other] });
    expect(await install({ worktree: other, noRestart: true }, d)).toBe(0); // desired B, activated A
    setGateway({ mode: 'launchd', pid: 777 }); // user restarted into B
    expect(await install({ worktree, noRestart: true }, d)).toBe(0); // write A again
    expect(activationPending(await d.activation.read(home))).toBe(true);
    // The next plain run finishes it instead of taking the active no-op branch.
    resetLog();
    expect(await install({ worktree }, d)).toBe(0);
    expect(restartsIn(calls())).toHaveLength(1);
  });

  it('refuses a FIFO record promptly instead of blocking in open', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    const dir = stateDir();
    const path = join(dir, readdirSync(dir).find((name) => name.endsWith('.json'))!);
    rmSync(path);
    execFileSync('mkfifo', ['-m', '0600', path]);
    const started = Date.now();
    const outcome = await Promise.race([
      deps().activation.read(home).then(() => 'read', (error: unknown) => (error instanceof Error ? error.message : String(error))),
      new Promise<string>((done) => setTimeout(() => done('timed out'), 2_000)),
    ]);
    expect(outcome).toContain(`Unsafe Borg state file ${path}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('borg update never picks a conversation (design rev 2 §6)', () => {
  it('reuses only the configured key; without one it refuses without asking and stays pending', async () => {
    expect(await install()).toBe(0);
    const current = config(); delete current.plugins.entries[HERMES_PLUGIN_NAME].settings.session_key;
    writeFileSync(join(home, 'config.yaml'), JSON.stringify(current));
    resetLog(); err = [];
    let asked = false;
    const d = deps({ env: { HERMES_HOME: home }, prompt: async () => { asked = true; return 'y'; } });
    expect(await activateHermesPlugin(d)).toBe(1); // one DM candidate, a terminal and a 'y' ready: still no pick
    expect(asked).toBe(false);
    // `borg update` uses the default Hermes home, so the retry names none.
    expect(err.join('')).toContain(`borg representative hermes-plugin install --session-key '${DM}'`);
    expect(writes()).toEqual([]);
  });
});

/** Split a printed POSIX command the way a shell would for single-quoted words. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    words.push(match[1] !== undefined ? match[1].replace(/'\\''/g, "'") : match[2]);
  }
  return words;
}

describe('CR round 5 probes (review bc13269c)', () => {
  it('F7: update refuses a missing session key before creating any representative state (real bindings seam)', async () => {
    mkdirSync(pluginDir(), { recursive: true });
    writeFileSync(join(pluginDir(), 'plugin.yaml'), 'name: borg-representative-push\n');
    writeFileSync(join(pluginDir(), '__init__.py'), '# plugin\n');
    // One prepared 5.x binding, so the run gets past the worktree check to the session key.
    plantLegacyBindings(root, [bindingFor(worktree)]);
    expect(existsSync(representativeStateRoot())).toBe(false);
    const d = deps({ env: { HERMES_HOME: home }, bindings: defaultHermesPluginDeps().bindings });
    expect(await activateHermesPlugin(d)).toBe(1);
    expect(err.join('')).toContain('does not choose the conversation to wake without your confirmation');
    expect(writes()).toEqual([]);
    expect(existsSync(representativeStateRoot())).toBe(false);
    expect(existsSync(join(root, '.config', 'borgmcp', 'representative'))).toBe(false);
  });

  it('F8: the printed retry parses to the same Hermes home and worktree, shell-quoted', async () => {
    const odd = join(root, "worktree with 'quote' and $HOME");
    mkdirSync(odd, { recursive: true });
    const d = deps({ isTTY: () => false, worktrees: [worktree, odd] });
    expect(await install({ worktree: odd }, d)).toBe(1);
    const line = err.join('').split('\n').map((text) => text.trim()).find((text) => text.startsWith('borg representative hermes-plugin install'))!;
    const words = shellWords(line);
    expect(words.slice(0, 2)).toEqual(['borg', 'representative']);
    const parsed = parseRepresentativeArgs(words.slice(2));
    expect(parsed).toEqual({
      ok: true,
      command: { action: 'hermes-plugin-install', hermesHome: home, worktree: odd, sessionKey: DM, dryRun: false, noRestart: false },
    });
  });

  it('F8: a --no-restart hint and an uninstall rerun keep the selected home', async () => {
    expect(await install({ noRestart: true })).toBe(0);
    expect(out.join('')).toContain(`Run \`borg representative hermes-plugin install --hermes-home '${home}'\` without --no-restart`);
    out = [];
    expect(await runHermesPluginUninstall({ hermesHome: home, dryRun: false, noRestart: true }, deps())).toBe(0);
    expect(out.join('')).toContain(`Run \`borg representative hermes-plugin uninstall --hermes-home '${home}'\` without --no-restart`);
  });
});

describe('CR round 6 probes (review 55e7f87e): binding refusals before any state', () => {
  const realBindings = () => deps({ bindings: defaultHermesPluginDeps().bindings });

  it('zero 5.x bindings: refuses "no representative connection" and creates no state', async () => {
    expect(existsSync(representativeStateRoot())).toBe(false);
    expect(await install({ sessionKey: DM }, realBindings())).toBe(1);
    expect(err.join('')).toContain('No representative connection is prepared');
    expect(writes()).toEqual([]);
    expect(existsSync(representativeStateRoot())).toBe(false);
  });

  it('two 5.x bindings: refuses "several representative worktrees" and creates no state', async () => {
    const second = join(root, 'worktrees', 'second');
    mkdirSync(second, { recursive: true });
    plantLegacyBindings(root, [bindingFor(worktree), bindingFor(second, { boundAt: '2026-02-01T00:00:00.000Z' })]);
    expect(await install({ sessionKey: DM }, { ...realBindings(), isTTY: () => false })).toBe(1);
    expect(err.join('')).toContain('Several representative worktrees are prepared');
    expect(writes()).toEqual([]);
    expect(existsSync(representativeStateRoot())).toBe(false);
  });

  it('an explicit worktree that is not a 5.x binding: refused, no state', async () => {
    plantLegacyBindings(root, [bindingFor(worktree)]);
    expect(await install({ sessionKey: DM, worktree: join(root, 'not-prepared') }, realBindings())).toBe(1);
    expect(err.join('')).toContain('is not a prepared representative worktree');
    expect(existsSync(representativeStateRoot())).toBe(false);
  });
});

describe('6.0.1: every refusal before any question (dispatch dc4f374f)', () => {
  const threeWorktrees = () => {
    const paths = ['one', 'two', "three 'q' $HOME"].map((name) => join(root, 'worktrees', name));
    for (const path of paths) mkdirSync(path, { recursive: true });
    return paths;
  };
  const twoDms = { [DM]: { display_name: 'Theo DM' }, 'agent:main:discord:dm:42': { display_name: 'Other' } };

  it('two DMs and three worktrees at a terminal: asks for the worktree first, then the DM, then [y/N], and installs', async () => {
    const paths = threeWorktrees();
    writeSessions(twoDms);
    const questions: string[] = [];
    const answers = ['2', '1', 'y'];
    const d = deps({ worktrees: paths, prompt: async (question) => { questions.push(question); return answers.shift() ?? null; } });
    expect(await install({}, d)).toBe(0);
    expect(questions).toEqual([
      'Use which worktree? [1-3] ',
      'Wake which conversation? [1-2] ',
      `Wake agent:main:discord:dm:42  (Other) for Borg Coordinator replies? [y/N] `,
    ]);
    expect(config().plugins.entries[HERMES_PLUGIN_NAME].settings).toMatchObject({ worktree: paths[1], session_key: 'agent:main:discord:dm:42' });
  });

  it('asks nothing when a later check would refuse: no DM found, or a relative borg path', async () => {
    const paths = threeWorktrees();
    rmSync(join(home, 'sessions'), { recursive: true });
    let asked = 0;
    const d = deps({ worktrees: paths, prompt: async () => { asked++; return '1'; } });
    expect(await install({}, d)).toBe(1);
    expect(err.join('')).toContain('No gateway DM conversation was found');
    expect(asked).toBe(0);

    writeSessions(twoDms); err = [];
    expect(await install({}, { ...d, borgCommand: () => 'borg' })).toBe(1);
    expect(err.join('')).toContain('borg executable path is not absolute');
    expect(asked).toBe(0);
    expect(writes()).toEqual([]);
  });

  it('without a terminal, the several-worktrees refusal prints one exact command per worktree (real parser)', async () => {
    const paths = threeWorktrees();
    writeSessions(twoDms);
    for (const sessionKey of [DM, undefined]) {
      err = [];
      expect(await install(sessionKey ? { sessionKey } : {}, deps({ worktrees: paths, isTTY: () => false }))).toBe(1);
      const lines = err.join('').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('borg representative hermes-plugin install'));
      expect(lines).toHaveLength(3);
      lines.forEach((line, index) => {
        const words = shellWords(line);
        expect(parseRepresentativeArgs(words.slice(2))).toEqual({
          ok: true,
          command: {
            action: 'hermes-plugin-install', hermesHome: home, worktree: paths[index],
            ...(sessionKey ? { sessionKey } : {}), dryRun: false, noRestart: false,
          },
        });
      });
    }
    expect(writes()).toEqual([]);
  });

  it('a worktree choice at the terminal that is not a number refuses with nothing changed', async () => {
    const paths = threeWorktrees();
    const d = deps({ worktrees: paths, prompt: async () => 'x' });
    expect(await install({ sessionKey: DM }, d)).toBe(1);
    expect(err.join('')).toContain('No worktree was chosen; nothing was changed.');
    expect(writes()).toEqual([]);
  });
});

