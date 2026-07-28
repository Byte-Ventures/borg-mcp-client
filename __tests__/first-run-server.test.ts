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
    publishedVersions: vi.fn(async () => [SERVER.version]),
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
    expect(d.value.publishedVersions).toHaveBeenCalledWith('borgmcp-server');
    expect(d.value.publishedPackage).toHaveBeenCalledWith('borgmcp-server', '0.6.0');
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

  it('selects the newest older server compatible with the client when latest has moved ahead', async () => {
    const releases: Record<string, PublishedPackage> = {
      '0.7.0': { ...SERVER, version: '0.7.0', sharedVersion: '0.8.0' },
      '0.6.1': { ...SERVER, version: '0.6.1' },
      '0.6.0': SERVER,
    };
    let installed: InstalledPackage | null = null;
    const d = deps({
      currentServer: vi.fn(async () => installed),
      publishedVersions: vi.fn(async () => ['0.6.0', '0.7.0', '0.6.1']),
      publishedPackage: vi.fn(async (_name, version) => releases[version]),
      installGlobal: vi.fn(async (_name, version) => {
        installed = { ...INSTALLED, version };
      }),
    });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'installed',
      server: { ...INSTALLED, version: '0.6.1' },
    });
    expect(d.value.publishedPackage).toHaveBeenNthCalledWith(1, 'borgmcp-server', '0.7.0');
    expect(d.value.publishedPackage).toHaveBeenNthCalledWith(2, 'borgmcp-server', '0.6.1');
    expect(d.value.publishedPackage).not.toHaveBeenCalledWith('borgmcp-server', '0.6.0');
    expect(d.value.installGlobal).toHaveBeenCalledWith(
      'borgmcp-server',
      '0.6.1',
      { ignoreScripts: true },
    );
  });

  it('fails closed with actionable direction when no compatible server release exists', async () => {
    const d = deps({
      publishedVersions: vi.fn(async () => ['0.7.0']),
      publishedPackage: vi.fn(async () => ({
        ...SERVER,
        version: '0.7.0',
        sharedVersion: '0.8.0',
      })),
    });

    await expect(offerFirstRunServerInstall(d.value)).resolves.toEqual({
      kind: 'failed',
    });
    expect(d.value.confirm).not.toHaveBeenCalled();
    expect(d.value.installGlobal).not.toHaveBeenCalled();
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
      'no published borgmcp-server release uses borgmcp-shared@0.7.0',
    ));
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining('`borg update`'));
    expect(d.stderr).toHaveBeenCalledWith(expect.stringContaining(
      '`borg assimilate --host <host>`',
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
