import { describe, expect, it, vi } from 'vitest';
import {
  offerFirstRunServerInstall,
  type FirstRunServerInstallDeps,
} from '../src/first-run-server.js';
import type { InstalledPackage, PublishedPackage } from '../src/update-cmd.js';

const SERVER: PublishedPackage = {
  name: 'borgmcp-server',
  version: '0.6.0',
  sharedVersion: '0.7.0',
  integrity: `sha512-${Buffer.alloc(64, 7).toString('base64')}`,
};

const INSTALLED: InstalledPackage = {
  name: 'borgmcp-server',
  version: '0.6.0',
  sharedVersion: '0.7.0',
  packageRoot: '/npm/lib/node_modules/borgmcp-server',
  binPath: '/npm/lib/node_modules/borgmcp-server/dist/main.js',
};

function deps(overrides: Partial<FirstRunServerInstallDeps> = {}) {
  let installed: InstalledPackage | null = null;
  const stdout = vi.fn();
  const stderr = vi.fn();
  const value: FirstRunServerInstallDeps = {
    currentServer: vi.fn(async () => installed),
    publishedPackage: vi.fn(async () => SERVER),
    installGlobal: vi.fn(async () => { installed = INSTALLED; }),
    confirm: vi.fn(async () => 'yes'),
    isTTY: vi.fn(() => true),
    stdout,
    stderr,
    clientSharedVersion: vi.fn(() => '0.7.0'),
    ...overrides,
  };
  return { value, stdout, stderr };
}

describe('offerFirstRunServerInstall', () => {
  it('does nothing when the verified npm-global server is already present', async () => {
    const d = deps({ currentServer: vi.fn(async () => INSTALLED) });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'present',
      server: INSTALLED,
    });
    expect(d.value.publishedPackage).not.toHaveBeenCalled();
    expect(d.value.confirm).not.toHaveBeenCalled();
    expect(d.value.installGlobal).not.toHaveBeenCalled();
  });

  it('fails closed without registry, prompt, or installation work outside an interactive terminal', async () => {
    const d = deps({ isTTY: vi.fn(() => false) });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'non-interactive',
    });
    expect(d.value.publishedPackage).not.toHaveBeenCalled();
    expect(d.value.confirm).not.toHaveBeenCalled();
    expect(d.value.installGlobal).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('`borg setup`'));
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('`borg assimilate --host <host>`'));
  });

  it('installs and verifies the exact compatible server selected by the client', async () => {
    const d = deps();

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'installed',
      server: INSTALLED,
    });
    expect(d.value.publishedPackage).toHaveBeenCalledWith('borgmcp-server', 'latest');
    expect(d.value.confirm).toHaveBeenCalledWith(expect.stringContaining(
      'Command: npm install --global --ignore-scripts borgmcp-server@0.6.0',
    ));
    expect(d.value.installGlobal).toHaveBeenCalledWith(
      'borgmcp-server',
      '0.6.0',
      { ignoreScripts: true },
    );
    expect(d.stdout).toHaveBeenCalledWith(expect.stringContaining('`borg server setup`'));
    expect(d.stdout).toHaveBeenCalledWith(expect.stringContaining('`borg server start`'));
  });

  it.each(['no', 'eof', 'interrupted'] as const)(
    'leaves no installation state and prints the exact recovery command after %s',
    async (decision) => {
      const d = deps({ confirm: vi.fn(async () => decision) });

      await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
        kind: 'declined',
      });
      expect(d.value.installGlobal).not.toHaveBeenCalled();
      expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
        '`npm install --global --ignore-scripts borgmcp-server@0.6.0`',
      ));
    },
  );

  it('refuses a published server whose exact shared pin differs from the client', async () => {
    const d = deps({
      publishedPackage: vi.fn(async () => ({ ...SERVER, sharedVersion: '0.6.4' })),
    });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'failed',
    });
    expect(d.value.confirm).not.toHaveBeenCalled();
    expect(d.value.installGlobal).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
      'but this client requires borgmcp-shared@0.7.0',
    ));
  });

  it('fails closed when the installed server cannot be verified after npm returns', async () => {
    const d = deps({
      installGlobal: vi.fn(async () => {}),
    });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'failed',
    });
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
      'installation could not be completed and verified',
    ));
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
      '`npm install --global --ignore-scripts borgmcp-server@0.6.0`',
    ));
  });
});
