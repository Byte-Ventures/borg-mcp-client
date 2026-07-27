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
import { afterEach, describe, expect, it } from 'vitest';
import { buildDefaultUpdateDeps } from '../src/update-cmd.js';

const roots: string[] = [];
const originalPath = process.env.PATH;

function fakeNpm(registry: string, viewResponse: unknown = {
  name: 'borgmcp',
  version: '2.3.0',
  'dist.integrity': `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  'dependencies.borgmcp-shared': '0.6.5',
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
else if (args[0] === 'view') process.stdout.write(JSON.stringify(${JSON.stringify(viewResponse)}));
else if (args[0] === 'install') process.exit(0);
else process.exit(91);
`);
  chmodSync(npmPath, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  return {
    log: () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]),
    setPrefix: (prefix: string) => writeFileSync(statePath, JSON.stringify({ registry, prefix })),
    prefixB,
  };
}

afterEach(() => {
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

  it('accepts npm 12 single-element manifest arrays', async () => {
    const manifest = {
      name: 'borgmcp',
      version: '2.3.0',
      'dist.integrity': `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      'dependencies.borgmcp-shared': '0.6.5',
    };
    const npm = fakeNpm('https://registry.npmjs.org/', [manifest]);

    await expect(buildDefaultUpdateDeps().publishedPackage('borgmcp', 'latest'))
      .resolves.toMatchObject({ name: 'borgmcp', version: '2.3.0' });
    expect(npm.log().some(([command]) => command === 'view')).toBe(true);
  });

  it('retains a bounded object shape for an unexpected version-keyed response', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/', { '2.4.0': {} });

    await expect(buildDefaultUpdateDeps().publishedPackage('borgmcp', 'latest'))
      .resolves.toMatchObject({ manifestShape: 'object keys=[2.4.0]' });
    expect(npm.log().some(([command]) => command === 'view')).toBe(true);
  });

  it('bounds and escapes registry-supplied manifest shape keys', async () => {
    const longKey = `x${'y'.repeat(100)}`;
    const controlKey = '\n\u001b]0;unsafe\u0007';
    const npm = fakeNpm('https://registry.npmjs.org/', { [longKey]: {}, [controlKey]: {} });

    const manifest = await buildDefaultUpdateDeps().publishedPackage('borgmcp', 'latest');
    expect(manifest.manifestShape).toMatch(/^object keys=\[.{1,97}\]$/u);
    expect(manifest.manifestShape).not.toContain('\n');
    expect(manifest.manifestShape).not.toContain('\u001b');
    expect(manifest.manifestShape).toContain('\\n\\u001b');
    expect(npm.log().some(([command]) => command === 'view')).toBe(true);
  });

  it('rejects ambiguous multi-element manifest arrays', async () => {
    const npm = fakeNpm('https://registry.npmjs.org/', [{}, {}]);

    await expect(buildDefaultUpdateDeps().publishedPackage('borgmcp', 'latest'))
      .rejects.toThrow(/ambiguous borgmcp@latest manifest response \(array length 2\)/);
    expect(npm.log().some(([command]) => command === 'view')).toBe(true);
  });
});
