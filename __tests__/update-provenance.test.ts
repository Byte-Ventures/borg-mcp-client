import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectNpmPackageAt } from '../src/update-cmd.js';

const roots: string[] = [];

function fixture(options: {
  packageName?: 'borgmcp' | 'borgmcp-server';
  binName?: 'borg' | 'borg-mcp-server';
  binTarget?: string;
  packageRootOutside?: boolean;
} = {}) {
  const packageName = options.packageName ?? 'borgmcp';
  const binName = options.binName ?? 'borg';
  const root = mkdtempSync(join(tmpdir(), 'borg-update-provenance-'));
  roots.push(root);
  const npmRoot = join(root, 'lib', 'node_modules');
  const outsideRoot = join(root, 'outside-package');
  const packageRoot = options.packageRootOutside ? outsideRoot : join(npmRoot, packageName);
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(join(packageRoot, 'node_modules', 'borgmcp-shared'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(npmRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    version: packageName === 'borgmcp' ? '2.3.0' : '0.4.0',
    bin: { [binName]: options.binTarget ?? './dist/main.js' },
  }));
  writeFileSync(join(packageRoot, 'node_modules', 'borgmcp-shared', 'package.json'), JSON.stringify({
    name: 'borgmcp-shared',
    version: '0.6.5',
  }));
  writeFileSync(join(packageRoot, 'dist', 'main.js'), '#!/usr/bin/env node\n');
  if (options.packageRootOutside) symlinkSync(packageRoot, join(npmRoot, packageName));
  const commandPath = join(root, 'bin', binName);
  symlinkSync(join(packageRoot, 'dist', 'main.js'), commandPath);
  return { root, npmRoot, packageRoot, commandPath, packageName, binName };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('npm update provenance', () => {
  it('accepts only the exact bin and shared package inside the active npm global root', async () => {
    const f = fixture();
    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: f.commandPath,
    })).resolves.toMatchObject({
      name: 'borgmcp',
      version: '2.3.0',
      sharedVersion: '0.6.5',
      packageRoot: realpathSync(f.packageRoot),
      binPath: realpathSync(join(f.packageRoot, 'dist', 'main.js')),
    });
  });

  it('rejects a package-root symlink escaping the active npm global root', async () => {
    const f = fixture({ packageRootOutside: true });
    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: f.commandPath,
    })).rejects.toThrow(/not owned by the active npm global root/);
  });

  it('rejects a PATH command resolving to a different installation', async () => {
    const f = fixture();
    const other = join(f.root, 'other.js');
    writeFileSync(other, '');
    rmSync(f.commandPath);
    symlinkSync(other, f.commandPath);

    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: f.commandPath,
    })).rejects.toThrow(/PATH is not the npm-owned package binary/);
  });

  it('rejects a running client entrypoint different from the verified npm bin', async () => {
    const f = fixture();
    const other = join(f.root, 'other.js');
    writeFileSync(other, '');

    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: other,
    })).rejects.toThrow(/running borg entrypoint/);
  });

  it('rejects a manifest bin target escaping its package root', async () => {
    const f = fixture({ binTarget: '../../outside.js' });
    writeFileSync(join(f.root, 'lib', 'outside.js'), '');

    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: f.commandPath,
    })).rejects.toThrow(/outside the npm-owned package/);
  });

  it('rejects a ranged installed shared identity', async () => {
    const f = fixture();
    writeFileSync(join(f.packageRoot, 'node_modules', 'borgmcp-shared', 'package.json'), JSON.stringify({
      name: 'borgmcp-shared',
      version: '^0.6.5',
    }));

    await expect(inspectNpmPackageAt({
      name: f.packageName,
      binName: f.binName,
      npmRoot: f.npmRoot,
      commandPath: f.commandPath,
      invokedPath: f.commandPath,
    })).rejects.toThrow(/shared identity is invalid/);
  });
});
