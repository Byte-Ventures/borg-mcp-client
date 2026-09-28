/**
 * `borg representative hermes-plugin install`: copies exactly the packaged Hermes
 * push plugin files into <Hermes home>/plugins, refuses to overwrite without
 * --force, and never touches Hermes config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
import {
  HERMES_PLUGIN_FILES,
  HERMES_PLUGIN_NAME,
  packagedHermesPluginDir,
  runHermesPluginInstall,
  type HermesPluginInstallDeps,
} from '../src/hermes-plugin-install.js';
import { parseRepresentativeArgs } from '../src/representative-cmd.js';

let root: string;
let home: string;
let out: string[];
let err: string[];

function deps(overrides: Partial<HermesPluginInstallDeps> = {}): HermesPluginInstallDeps {
  return {
    env: {},
    homedir: () => join(root, 'user-home'),
    sourceDir: packagedHermesPluginDir(),
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    ...overrides,
  };
}

const target = () => join(home, 'plugins', HERMES_PLUGIN_NAME);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'borg-hermes-plugin-'));
  home = join(root, 'hermes-home');
  mkdirSync(home);
  writeFileSync(join(home, 'config.yaml'), 'model: keep-me\n');
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('hermes-plugin install argument parsing', () => {
  it('accepts install with optional absolute --hermes-home and --force', () => {
    expect(parseRepresentativeArgs(['hermes-plugin', 'install'])).toEqual({
      ok: true, command: { action: 'hermes-plugin-install', force: false },
    });
    expect(parseRepresentativeArgs(['hermes-plugin', 'install', '--hermes-home', '/h', '--force'])).toEqual({
      ok: true, command: { action: 'hermes-plugin-install', force: true, hermesHome: '/h' },
    });
  });

  it('rejects other subcommands, relative homes, missing values and unknown flags', () => {
    expect(parseRepresentativeArgs(['hermes-plugin'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['hermes-plugin', 'remove'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['hermes-plugin', 'install', '--hermes-home', 'rel'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['hermes-plugin', 'install', '--hermes-home'])).toMatchObject({ ok: false });
    expect(parseRepresentativeArgs(['hermes-plugin', 'install', '--enable'])).toMatchObject({ ok: false });
  });
});

describe('hermes-plugin install', () => {
  it('copies exactly the packaged plugin files and prints the config to add', async () => {
    expect(await runHermesPluginInstall({ hermesHome: home, force: false }, deps())).toBe(0);
    expect(readdirSync(target()).sort()).toEqual([...HERMES_PLUGIN_FILES].sort());
    for (const name of HERMES_PLUGIN_FILES) {
      expect(readFileSync(join(target(), name))).toEqual(readFileSync(join(packagedHermesPluginDir(), name)));
      expect(statSync(join(target(), name)).mode & 0o777).toBe(0o644);
    }
    const printed = out.join('');
    expect(printed).toContain(`- ${HERMES_PLUGIN_NAME}`);
    expect(printed).toContain('allow_gateway_injection: true');
    expect(printed).toContain('session_key:');
    expect(printed).toContain('lazy: true');
    expect(printed).toContain('Desktop chat cannot be woken');
    expect(printed).toContain('hermes gateway restart');
    expect(err).toEqual([]);
  });

  it('never edits Hermes config and creates nothing outside plugins/', async () => {
    expect(await runHermesPluginInstall({ hermesHome: home, force: false }, deps())).toBe(0);
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toBe('model: keep-me\n');
    expect(readdirSync(home).sort()).toEqual(['config.yaml', 'plugins']);
    expect(readdirSync(join(home, 'plugins'))).toEqual([HERMES_PLUGIN_NAME]);
  });

  it('refuses to overwrite an existing install without --force and replaces files with it', async () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), '__init__.py'), '# stale\n');
    writeFileSync(join(target(), 'operator-notes.txt'), 'keep\n');
    expect(await runHermesPluginInstall({ hermesHome: home, force: false }, deps())).toBe(1);
    expect(err.join('')).toContain('--force');
    expect(readFileSync(join(target(), '__init__.py'), 'utf8')).toBe('# stale\n');

    err = [];
    expect(await runHermesPluginInstall({ hermesHome: home, force: true }, deps())).toBe(0);
    expect(readFileSync(join(target(), '__init__.py'))).toEqual(readFileSync(join(packagedHermesPluginDir(), '__init__.py')));
    expect(readFileSync(join(target(), 'operator-notes.txt'), 'utf8')).toBe('keep\n');
    expect(out.join('')).toContain('Replaced');
  });

  it('refuses a symbolic-link target even with --force', async () => {
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(home, 'plugins'));
    symlinkSync(elsewhere, target());
    expect(await runHermesPluginInstall({ hermesHome: home, force: true }, deps())).toBe(1);
    expect(err.join('')).toContain('symbolic link');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(lstatSync(target()).isSymbolicLink()).toBe(true);
  });

  it('refuses a missing Hermes home instead of creating one', async () => {
    const missing = join(root, 'no-hermes');
    expect(await runHermesPluginInstall({ hermesHome: missing, force: false }, deps())).toBe(1);
    expect(err.join('')).toContain('No Hermes home');
    expect(existsSync(missing)).toBe(false);
  });

  it('defaults to $HERMES_HOME, then ~/.hermes', async () => {
    expect(await runHermesPluginInstall({ force: false }, deps({ env: { HERMES_HOME: home } }))).toBe(0);
    expect(existsSync(target())).toBe(true);

    const userHome = join(root, 'user-home');
    mkdirSync(join(userHome, '.hermes'), { recursive: true });
    expect(await runHermesPluginInstall({ force: false }, deps())).toBe(0);
    expect(existsSync(join(userHome, '.hermes', 'plugins', HERMES_PLUGIN_NAME, 'plugin.yaml'))).toBe(true);
  });

  it('refuses when a packaged file is missing and writes nothing', async () => {
    const partial = join(root, 'partial');
    mkdirSync(partial);
    writeFileSync(join(partial, 'plugin.yaml'), 'name: x\n');
    expect(await runHermesPluginInstall({ hermesHome: home, force: false }, deps({ sourceDir: partial }))).toBe(1);
    expect(err.join('')).toContain('__init__.py');
    expect(existsSync(join(home, 'plugins'))).toBe(false);
  });
});
