import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalHome = process.env.HOME;
const fixtures: string[] = [];
const origin = 'https://127.0.0.1:7091';
const trustIdentity = 'sha256:server-identity';
const clientId = '11111111-1111-4111-8111-111111111111';
const credential = 'c'.repeat(43);

function accountFor(serverOrigin: string, identity: string): string {
  const hash = createHash('sha256').update(serverOrigin).update('\0').update(identity).digest('hex');
  return `borg-server-credential:${hash}`;
}

function fixture(mode = 0o755): { home: string; root: string; file: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'borg-credential-compat-')));
  const root = join(home, '.borg');
  const file = join(root, 'credentials');
  mkdirSync(root, { mode });
  chmodSync(root, mode);
  fixtures.push(home);
  process.env.HOME = home;
  vi.resetModules();
  return { home, root, file };
}

function serverProvisionedFile(file: string): void {
  const record = JSON.stringify({
    version: 2,
    origin,
    trustIdentity,
    credential,
    clientId,
    serverCapabilities: ['create_cube'],
  });
  writeFileSync(file, JSON.stringify({
    version: 1,
    accounts: { [accountFor(origin, trustIdentity)]: record },
  }, null, 2) + '\n', { mode: 0o600 });
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.resetModules();
});

describe('server/client credential file compatibility', () => {
  it('reads the exact owner record provisioned by local server setup', async () => {
    const { file } = fixture();
    serverProvisionedFile(file);
    const config = await import('../src/config.js');

    await expect(config.getServerCredentialRecord(origin, trustIdentity)).resolves.toEqual({
      origin,
      trustIdentity,
      credential,
      clientId,
      serverCapabilities: ['create_cube'],
    });
  });

  it('explicit remote enrollment preserves the setup account in the same file', async () => {
    const { file } = fixture();
    serverProvisionedFile(file);
    const config = await import('../src/config.js');
    const remoteOrigin = 'https://server.example.com';
    const remoteTrust = 'sha256:remote';

    await config.storeServerCredential({
      origin: remoteOrigin,
      trustIdentity: remoteTrust,
      credential: 'r'.repeat(43),
      clientId: '22222222-2222-4222-8222-222222222222',
      serverCapabilities: [],
    });

    const stored = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Record<string, string> };
    expect(Object.keys(stored.accounts)).toEqual(expect.arrayContaining([
      accountFor(origin, trustIdentity),
      accountFor(remoteOrigin, remoteTrust),
    ]));
    await expect(config.getServerCredential(origin, trustIdentity)).resolves.toBe(credential);
  });

  it('rejects a symlinked credential file without reading its target', async () => {
    const { root, file } = fixture();
    const target = join(root, 'target');
    writeFileSync(target, '{"secret":"not-readable-through-link"}', { mode: 0o600 });
    symlinkSync(target, file);
    const config = await import('../src/config.js');
    await expect(config.getServerCredential(origin, trustIdentity)).rejects.toThrow(/symlink/i);
  });

  it('accepts owner-controlled 0755 parent but rejects group-writable parent and loose files', async () => {
    const accepted = fixture(0o755);
    serverProvisionedFile(accepted.file);
    let config = await import('../src/config.js');
    await expect(config.getServerCredential(origin, trustIdentity)).resolves.toBe(credential);

    const looseRoot = fixture(0o775);
    serverProvisionedFile(looseRoot.file);
    config = await import('../src/config.js');
    await expect(config.getServerCredential(origin, trustIdentity)).rejects.toThrow(/write access|permissions/i);

    chmodSync(looseRoot.root, 0o755);
    chmodSync(looseRoot.file, 0o640);
    await expect(config.getServerCredential(origin, trustIdentity)).rejects.toThrow(/0600|permissions/i);
  });
});
