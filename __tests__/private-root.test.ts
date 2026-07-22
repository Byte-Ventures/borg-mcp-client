import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const fixtures: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.resetModules();
});

function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'borg-private-root-'));
  fixtures.push(home);
  process.env.HOME = home;
  return home;
}

describe('private Borg config root', () => {
  it('creates ~/.config/borgmcp at 0700 under umask 022', async () => {
    const home = fixtureHome();
    const priorUmask = process.umask(0o022);
    try {
      const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
      const root = await ensurePrivateBorgConfigRoot();
      await root.close();
    } finally {
      process.umask(priorUmask);
    }

    expect(lstatSync(join(home, '.config', 'borgmcp')).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing current-user non-writable 0755 root to 0700', async () => {
    const home = fixtureHome();
    const rootPath = join(home, '.config', 'borgmcp');
    mkdirSync(rootPath, { recursive: true, mode: 0o755 });
    const { chmodSync } = await import('node:fs');
    chmodSync(rootPath, 0o755);

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    const root = await ensurePrivateBorgConfigRoot();
    await root.close();

    expect(lstatSync(rootPath).mode & 0o777).toBe(0o700);
  });

  it('refuses a group-writable root without changing it', async () => {
    const home = fixtureHome();
    const rootPath = join(home, '.config', 'borgmcp');
    mkdirSync(rootPath, { recursive: true, mode: 0o770 });
    const { chmodSync } = await import('node:fs');
    chmodSync(rootPath, 0o770);

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    await expect(ensurePrivateBorgConfigRoot()).rejects.toThrow('insecure permissions');
    expect(lstatSync(rootPath).mode & 0o777).toBe(0o770);
  });

  it('refuses a symlinked config ancestor before creating the Borg root', async () => {
    const home = fixtureHome();
    const outside = mkdtempSync(join(tmpdir(), 'borg-private-outside-'));
    fixtures.push(outside);
    symlinkSync(outside, join(home, '.config'));

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    await expect(ensurePrivateBorgConfigRoot()).rejects.toThrow('must be a real directory');
    expect(() => lstatSync(join(outside, 'borgmcp'))).toThrow();
  });
});
