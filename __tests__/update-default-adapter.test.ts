import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import which from 'which';
import {
  BORG_PLUGIN_SOURCE,
  openCodePluginPath,
} from '../src/opencode-plugin.js';
import { BORG_STATE_ROOT_ENV } from '../src/private-root.js';
import {
  buildDefaultUpdateDeps,
  runUpdate,
  type PublishedPackage,
  type UpdateDeps,
} from '../src/update-cmd.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalStateRoot = process.env[BORG_STATE_ROOT_ENV];
const CLIENT_TARGET: PublishedPackage = {
  name: 'borgmcp',
  version: '2.3.0',
  integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  sharedVersion: '0.6.5',
};
const SERVER_TARGET: PublishedPackage = {
  name: 'borgmcp-server',
  version: '0.4.0',
  integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
  sharedVersion: '0.6.5',
};

function installed(
  target: PublishedPackage,
  version = target.version,
  sharedVersion = target.sharedVersion,
) {
  const packageRoot = `/npm/lib/node_modules/${target.name}`;
  return {
    name: target.name,
    version,
    sharedVersion,
    packageRoot,
    binPath: `${packageRoot}/dist/${target.name === 'borgmcp' ? 'claude.js' : 'cli.js'}`,
  };
}

function updateDeps(
  adapter: UpdateDeps,
  overrides: Partial<UpdateDeps>,
): UpdateDeps {
  return {
    ...adapter,
    currentClient: vi.fn(async () => installed(CLIENT_TARGET)),
    currentServer: vi.fn(async () => null),
    publishedPackage: vi.fn(async (name) =>
      name === 'borgmcp' ? CLIENT_TARGET : SERVER_TARGET),
    publishedVersions: vi.fn(async (name) =>
      name === 'borgmcp' ? [CLIENT_TARGET.version] : [SERVER_TARGET.version]),
    reenter: vi.fn(async () => 0),
    serverJson: vi.fn(async () => ({
      status: 'running',
      installed_controller: 'borgmcp-server@0.4.0',
      prepared_runtime: 'borgmcp-server@0.4.0',
      prepared_integrity: SERVER_TARGET.integrity,
      running_runtime: 'borgmcp-server@0.4.0',
      running_integrity: SERVER_TARGET.integrity,
      build_identity: 'a'.repeat(40),
      endpoint: 'https://127.0.0.1:7091',
      mode: 'managed',
      service_adapter: 'launchd',
      data_identity: 'available',
      next_action: null,
    })),
    verifyRunningProtocol: vi.fn(async () => undefined),
    refreshAgentIntegrations: vi.fn(async () => undefined),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

function fakeNpm(registry: string, manifest: unknown = {
  name: 'borgmcp',
  version: '2.3.0',
  dist: {
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  },
  dependencies: {
    'borgmcp-shared': '0.6.5',
  },
}) {
  const root = mkdtempSync(join(tmpdir(), 'borg-update-npm-context-'));
  roots.push(root);
  const bin = join(root, 'bin');
  const prefixA = join(root, 'prefix-a');
  const prefixB = join(root, 'prefix-b');
  const statePath = join(root, 'state.json');
  const logPath = join(root, 'npm.log');
  mkdirSync(bin);
  mkdirSync(join(prefixA, 'lib', 'node_modules'), { recursive: true });
  mkdirSync(join(prefixB, 'lib', 'node_modules'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ registry, prefix: prefixA }));
  writeFileSync(logPath, '');
  const npmPath = join(bin, 'npm');
  writeFileSync(npmPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
if (args.join(' ') === 'config get registry') process.stdout.write(state.registry + '\\n');
else if (args.join(' ') === 'prefix --global') process.stdout.write(state.prefix + '\\n');
else if (args.join(' ') === 'root --global') process.stdout.write(state.prefix + '/lib/node_modules\\n');
else if (args[0] === 'install') process.exit(0);
else process.exit(91);
`);
  chmodSync(npmPath, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  const fetch = vi.fn(async () => new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  return {
    log: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    setPrefix: (prefix: string) => writeFileSync(statePath, JSON.stringify({ registry, prefix })),
    bin,
    prefixA,
    prefixB,
    fetch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.PATH = originalPath;
  if (originalStateRoot === undefined) delete process.env[BORG_STATE_ROOT_ENV];
  else process.env[BORG_STATE_ROOT_ENV] = originalStateRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('default npm update adapter', () => {
  it('gates OpenCode plugin repair on registration and preserves unreadable failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borg-update-opencode-plugin-'));
    roots.push(root);
    const canonicalRoot = realpathSync(root);
    const stateRoot = join(canonicalRoot, 'state');
    const bin = join(canonicalRoot, 'bin');
    mkdirSync(stateRoot);
    mkdirSync(bin);
    const scripts = {
      'borg-regen': 'regen.js',
      'borg-clear-rewake': 'clear-rewake.js',
      'borg-log-audit': 'log-audit.js',
      'borg-foreign-path-reminder': 'foreign-path-reminder.js',
      'borg-inbox-monitor': 'inbox-monitor.js',
    } as const;
    for (const [name, script] of Object.entries(scripts)) {
      symlinkSync(join(process.cwd(), 'dist', script), join(bin, name));
    }
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
    process.env[BORG_STATE_ROOT_ENV] = stateRoot;
    const plugin = openCodePluginPath(stateRoot);
    const openCodeConfigDir = join(stateRoot, '.config', 'opencode');
    const openCodeConfig = join(openCodeConfigDir, 'opencode.json');
    const deps = buildDefaultUpdateDeps();

    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(existsSync(plugin)).toBe(false);

    mkdirSync(openCodeConfigDir, { recursive: true });
    mkdirSync(join(plugin, '..'));
    writeFileSync(plugin, BORG_PLUGIN_SOURCE);
    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(readFileSync(plugin, 'utf8')).toBe(BORG_PLUGIN_SOURCE);

    const priorSource = readFileSync(
      new URL('./fixtures/opencode-plugin-3.3.0.js', import.meta.url),
      'utf8',
    );
    expect(Buffer.byteLength(priorSource)).toBe(386);
    expect(createHash('sha256').update(priorSource).digest('hex')).toBe(
      '14a64bb955245b818e8afc46a429791868b6ad87d72996d2775b04411095295c',
    );
    writeFileSync(plugin, priorSource);
    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(readFileSync(plugin, 'utf8')).toBe(priorSource);

    writeFileSync(openCodeConfig, JSON.stringify({ mcp: { borg: { type: 'local' } } }));
    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(readFileSync(plugin, 'utf8')).toBe(BORG_PLUGIN_SOURCE);

    const symlinkTarget = join(canonicalRoot, 'operator-data.txt');
    writeFileSync(symlinkTarget, 'operator data');
    rmSync(plugin);
    symlinkSync(symlinkTarget, plugin);
    await expect(deps.refreshAgentIntegrations()).rejects.toThrow(
      /OpenCode borg-orient\.js plugin: refused .*plugin path is a symlink/,
    );
    await expect(deps.refreshAgentIntegrations()).rejects.toThrow(
      /Remove or replace the OpenCode plugin path .* then run: borg update --yes/,
    );
    expect(readFileSync(symlinkTarget, 'utf8')).toBe('operator data');
    rmSync(plugin);

    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(readFileSync(plugin, 'utf8')).toBe(BORG_PLUGIN_SOURCE);

    rmSync(plugin);
    mkdirSync(plugin);
    await expect(deps.refreshAgentIntegrations()).rejects.toThrow(
      /OpenCode borg-orient\.js plugin: refused .*plugin path is not a regular file/,
    );
    await expect(deps.refreshAgentIntegrations()).rejects.toThrow(
      /Remove or replace the OpenCode plugin path .* then run: borg update --yes/,
    );
    rmSync(openCodeConfig);
    await expect(deps.refreshAgentIntegrations()).resolves.toBeUndefined();
    expect(lstatSync(plugin).isDirectory()).toBe(true);
  });

  it('includes bounded server stderr when a JSON command fails before producing JSON', async () => {
    const root = mkdtempSync(join(tmpdir(), 'borg-update-server-json-'));
    roots.push(root);
    const server = join(root, 'borg-mcp-server');
    writeFileSync(server, `#!/usr/bin/env node
process.stderr.write('Migration 17 does not match its recorded checksum\\n');
process.stdout.write('not-json\\n');
process.exit(1);
`);
    chmodSync(server, 0o755);
    const deps = buildDefaultUpdateDeps();

    await expect(deps.serverJson(server, 'status')).rejects.toThrow(
      /server status returned invalid JSON[\s\S]*Migration 17 does not match its recorded checksum/,
    );
  });

  it('rejects a configured alternate registry before lookup or mutation', async () => {
    const npm = fakeNpm('https://mirror.example.invalid/');
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow(/canonical npm registry/);
    expect(npm.log()).toEqual([['config', 'get', 'registry']]);
    expect(npm.log().some(([command]) => command === 'view' || command === 'install')).toBe(false);
    expect(npm.fetch).not.toHaveBeenCalled();
  });

  it('reads the nested registry manifest from the exact canonical endpoint without redirects', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest')).resolves.toEqual({
      name: 'borgmcp',
      version: '2.3.0',
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      sharedVersion: '0.6.5',
    });
    expect(npm.fetch).toHaveBeenCalledWith(
      new URL('https://registry.npmjs.org/borgmcp/latest'),
      {
        headers: { Accept: 'application/json' },
        redirect: 'error',
      },
    );
    expect(npm.log()).toEqual([
      ['config', 'get', 'registry'],
      ['prefix', '--global'],
      ['root', '--global'],
      ['config', 'get', 'registry'],
      ['prefix', '--global'],
      ['root', '--global'],
    ]);
  });

  it('lists exact published versions from the canonical package endpoint without redirects', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/', {
      versions: {
        '0.6.0': {},
        '0.7.0': {},
      },
    });
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedVersions('borgmcp-server')).resolves.toEqual([
      '0.6.0',
      '0.7.0',
    ]);
    expect(npm.fetch).toHaveBeenCalledWith(
      new URL('https://registry.npmjs.org/borgmcp-server'),
      {
        headers: { Accept: 'application/json' },
        redirect: 'error',
      },
    );
  });

  it('fails closed generically when the registry response is not a manifest object', async () => {
    fakeNpm('https://registry.npmjs.org/', ['unexpected']);
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow('registry manifest lookup failed for borgmcp@latest');
  });

  it('fails closed with a designed error when the registry manifest has the wrong package identity', async () => {
    fakeNpm('https://registry.npmjs.org/', {
      name: 'borgmcp-server',
      version: '2.3.0',
      dist: {
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      },
      dependencies: {
        'borgmcp-shared': '0.6.5',
      },
    });
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow(/invalid borgmcp manifest identity/);
  });

  it('fails closed when the registry manifest version is a semver-coercible array', async () => {
    fakeNpm('https://registry.npmjs.org/', {
      name: 'borgmcp',
      version: ['2.3.0'],
      dist: {
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      },
      dependencies: {
        'borgmcp-shared': '0.6.5',
      },
    });
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow(/invalid borgmcp manifest identity/);
  });

  it.each([
    ['missing integrity', {
      name: 'borgmcp',
      version: '2.3.0',
      dist: {},
      dependencies: { 'borgmcp-shared': '0.6.5' },
    }],
    ['non-string shared dependency', {
      name: 'borgmcp',
      version: '2.3.0',
      dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      dependencies: { 'borgmcp-shared': null },
    }],
    ['semver-coercible shared dependency array', {
      name: 'borgmcp',
      version: '2.3.0',
      dist: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      dependencies: { 'borgmcp-shared': ['0.6.5'] },
    }],
  ])('fails closed with a designed field error for a nested manifest with %s', async (testCase, manifest) => {
    fakeNpm('https://registry.npmjs.org/', manifest);
    const deps = buildDefaultUpdateDeps();

    const lookup = deps.publishedPackage('borgmcp', 'latest');
    if (testCase === 'missing integrity') {
      await expect(lookup).rejects.toThrow('registry returned invalid borgmcp SHA-512 integrity');
    } else {
      await expect(lookup).rejects.toThrow('registry returned a non-exact borgmcp borgmcp-shared dependency');
    }
  });

  it('fails closed generically without exposing the registry request error', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    npm.fetch.mockRejectedValueOnce(new Error('registry response secret'));
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow(/^registry manifest lookup failed for borgmcp@latest$/);
    expect(npm.fetch).toHaveBeenCalledOnce();
  });

  it('rejects a changed npm prefix before install and keeps using the originally proven executable', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const deps = buildDefaultUpdateDeps();

    await expect(deps.publishedPackage('borgmcp', 'latest')).resolves.toMatchObject({
      name: 'borgmcp',
      version: '2.3.0',
    });
    npm.setPrefix(npm.prefixB);

    await expect(deps.installGlobal('borgmcp', '2.3.0'))
      .rejects.toThrow(/npm global prefix changed/);
    expect(npm.log().some(([command]) => command === 'install')).toBe(false);
  });

  it('renders a designed refusal when a server bin belongs to another npm prefix', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const packageRoot = join(npm.prefixB, 'lib', 'node_modules', 'borgmcp-server');
    mkdirSync(join(packageRoot, 'dist'), { recursive: true });
    mkdirSync(join(packageRoot, 'node_modules', 'borgmcp-shared'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'borgmcp-server',
      version: '0.4.0',
      bin: { 'borg-mcp-server': './dist/cli.js' },
    }));
    writeFileSync(join(packageRoot, 'node_modules', 'borgmcp-shared', 'package.json'), JSON.stringify({
      name: 'borgmcp-shared',
      version: '0.6.5',
    }));
    const serverBin = join(packageRoot, 'dist', 'cli.js');
    const pathBin = join(npm.bin, 'borg-mcp-server');
    writeFileSync(serverBin, '');
    chmodSync(serverBin, 0o755);
    symlinkSync(serverBin, pathBin);
    expect(which.sync('borg-mcp-server')).toBe(pathBin);
    const deps = buildDefaultUpdateDeps();

    await expect(deps.currentServer()).rejects.toThrow(
      'borg-mcp-server is on PATH from a different npm global prefix',
    );
  });

  it('rejects PATH substitution instead of selecting a different npm for install', async () => {
    const original = fakeNpm('https://registry.npmjs.org/');
    const deps = buildDefaultUpdateDeps();
    await expect(deps.publishedPackage('borgmcp', 'latest')).resolves.toMatchObject({
      name: 'borgmcp',
      version: '2.3.0',
    });
    const replacement = fakeNpm('https://registry.npmjs.org/');

    await expect(deps.installGlobal('borgmcp', '2.3.0'))
      .rejects.toThrow(/active npm executable changed/);
    expect(original.log().some(([command]) => command === 'install')).toBe(false);
    expect(replacement.log()).toEqual([]);
  });

  it('passes --ignore-scripts when the caller requires a lifecycle-safe install', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const deps = buildDefaultUpdateDeps();

    await expect(deps.installGlobal(
      'borgmcp-server',
      '0.6.0',
      { ignoreScripts: true },
    )).resolves.toBeUndefined();

    expect(npm.log().find(([command]) => command === 'install')).toEqual([
      'install',
      '--global',
      '--ignore-scripts',
      expect.stringMatching(/^--prefix=/),
      '--registry=https://registry.npmjs.org/',
      'borgmcp-server@0.6.0',
    ]);
  });

  it('runs the client update install with lifecycle scripts disabled', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const adapter = buildDefaultUpdateDeps();
    const deps = updateDeps(adapter, {
      currentClient: vi.fn()
        .mockResolvedValueOnce(installed(CLIENT_TARGET, '2.2.0', '0.6.4'))
        .mockResolvedValueOnce(installed(CLIENT_TARGET)),
    });

    await expect(runUpdate({ yes: true }, deps)).resolves.toBe(0);
    expect(npm.log().find(([command]) => command === 'install')).toEqual([
      'install',
      '--global',
      '--ignore-scripts',
      expect.stringMatching(/^--prefix=/),
      '--registry=https://registry.npmjs.org/',
      'borgmcp@2.3.0',
    ]);
  });

  it('runs the server update install with lifecycle scripts disabled', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/');
    const adapter = buildDefaultUpdateDeps();
    const deps = updateDeps(adapter, {
      currentServer: vi.fn()
        .mockResolvedValueOnce(installed(SERVER_TARGET, '0.3.0', '0.6.4'))
        .mockResolvedValue(installed(SERVER_TARGET)),
    });

    await expect(runUpdate({
      yes: true,
      target: {
        clientVersion: CLIENT_TARGET.version,
        serverVersion: SERVER_TARGET.version,
        serverPresent: true,
      },
    }, deps)).resolves.toBe(0);
    expect(npm.log().find(([command]) => command === 'install')).toEqual([
      'install',
      '--global',
      '--ignore-scripts',
      expect.stringMatching(/^--prefix=/),
      '--registry=https://registry.npmjs.org/',
      'borgmcp-server@0.4.0',
    ]);
  });
});
