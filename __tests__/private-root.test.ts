import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('refuses a symlinked HOME boundary before creating .config', async () => {
    const actualHome = mkdtempSync(join(tmpdir(), 'borg-private-home-'));
    fixtures.push(actualHome);
    const linkedHome = join(tmpdir(), `borg-private-home-link-${Date.now()}`);
    symlinkSync(actualHome, linkedHome);
    fixtures.push(linkedHome);
    process.env.HOME = linkedHome;

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    await expect(ensurePrivateBorgConfigRoot()).rejects.toThrow('real directory');
    expect(() => lstatSync(join(actualHome, '.config'))).toThrow();
  });

  it('refuses a writable .config ancestor without creating the Borg root', async () => {
    const home = fixtureHome();
    const config = join(home, '.config');
    mkdirSync(config, { recursive: true, mode: 0o770 });
    const { chmodSync } = await import('node:fs');
    chmodSync(config, 0o770);

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    await expect(ensurePrivateBorgConfigRoot()).rejects.toThrow('insecure permissions');
    expect(() => lstatSync(join(config, 'borgmcp'))).toThrow();
  });

  it('keeps Borg child directories at 0700 and files at 0600 under umask 022', async () => {
    const home = fixtureHome();
    const priorUmask = process.umask(0o022);
    try {
      const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
      const root = await ensurePrivateBorgConfigRoot();
      const inbox = join(root.path, 'inboxes', 'cube-1');
      await root.ensureDirectory(inbox);
      const state = join(inbox, 'drone-1.log');
      await root.appendFile(state, 'entry\n');
      await root.atomicWrite(join(root.path, 'launch.json'), '{"projects":{}}\n');
      await root.close();

      expect(lstatSync(inbox).mode & 0o777).toBe(0o700);
      expect(lstatSync(state).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root.path, 'launch.json')).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(priorUmask);
    }
    expect(readFileSync(join(home, '.config', 'borgmcp', 'launch.json'), 'utf8')).toContain('projects');
  });

  it('preserves unrelated safe-root content while tightening only the root', async () => {
    const home = fixtureHome();
    const rootPath = join(home, '.config', 'borgmcp');
    mkdirSync(rootPath, { recursive: true, mode: 0o755 });
    const unrelated = join(rootPath, 'operator-note.txt');
    writeFileSync(unrelated, 'leave unchanged\n');
    const { chmodSync } = await import('node:fs');
    chmodSync(rootPath, 0o755);

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    const root = await ensurePrivateBorgConfigRoot();
    await root.close();

    expect(lstatSync(rootPath).mode & 0o777).toBe(0o700);
    expect(readFileSync(unrelated, 'utf8')).toBe('leave unchanged\n');
    expect(lstatSync(unrelated).mode & 0o777).toBe(0o644);
  });

  it('rejects a pre-existing Borg file symlink without touching its target', async () => {
    const home = fixtureHome();
    const rootPath = join(home, '.config', 'borgmcp');
    mkdirSync(rootPath, { recursive: true, mode: 0o700 });
    const outside = join(home, 'outside-secret.txt');
    writeFileSync(outside, 'keep\n');
    symlinkSync(outside, join(rootPath, 'launch.json'));

    const { ensurePrivateBorgConfigRoot } = await import('../src/private-root.js');
    const root = await ensurePrivateBorgConfigRoot();
    await expect(root.atomicWrite(join(rootPath, 'launch.json'), 'replace\n')).rejects.toThrow('regular file');
    await root.close();
    expect(readFileSync(outside, 'utf8')).toBe('keep\n');
  });
});
