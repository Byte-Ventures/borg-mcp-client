import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultUpdateDeps } from '../src/update-cmd.js';

const roots: string[] = [];
const originalPath = process.env.PATH;

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
    prefixB,
    fetch,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('default npm update adapter', () => {
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
});
