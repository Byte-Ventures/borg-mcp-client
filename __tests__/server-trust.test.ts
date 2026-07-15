import { createHash, X509Certificate } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __clearServerTrustCacheForTest,
  createPinnedServerFetch,
  loadBorgServerTrust,
} from '../src/server-trust.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  __clearServerTrustCacheForTest();
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

function testCa(): { certificate: string; fingerprint: string } {
  for (const certificate of rootCertificates) {
    const parsed = new X509Certificate(certificate);
    if (!parsed.ca) continue;
    const fingerprint = createHash('sha256')
      .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    return { certificate, fingerprint };
  }
  throw new Error('Node did not expose a CA root for the trust test');
}

async function trustDirectory(fingerprint: string, certificate: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'borg-server-trust-'));
  tempDirectories.push(directory);
  await Promise.all([
    writeFile(join(directory, 'ca.crt'), certificate, { mode: 0o600 }),
    writeFile(join(directory, 'server.json'), JSON.stringify({
      ca_spki_sha256: fingerprint,
    }), { mode: 0o600 }),
  ]);
  return directory;
}

describe('same-user Borg server trust', () => {
  it('binds the explicit TLS transport to the verified CA SPKI identity', async () => {
    const ca = testCa();
    const directory = await trustDirectory(ca.fingerprint, ca.certificate);

    const trust = await loadBorgServerTrust(
      'https://127.0.0.1:7091',
      directory,
    );

    expect(trust.identity).toBe(`spki-sha256:${ca.fingerprint}`);
    await expect(trust.fetchImpl('https://example.com/healthz')).rejects.toThrow(
      /cross-authority/i,
    );
  });

  it('fails closed when server.json does not match the CA certificate', async () => {
    const ca = testCa();
    const directory = await trustDirectory('0'.repeat(64), ca.certificate);

    await expect(loadBorgServerTrust(
      'https://127.0.0.1:7091',
      directory,
    )).rejects.toThrow(/does not match its pinned identity/i);
  });

  it('refuses trust metadata writable by another user class', async () => {
    const ca = testCa();
    const directory = await trustDirectory(ca.fingerprint, ca.certificate);
    await chmod(join(directory, 'server.json'), 0o644);

    await expect(loadBorgServerTrust(
      'https://127.0.0.1:7091',
      directory,
    )).rejects.toThrow(/private regular files/i);
  });

  it('never constructs a pinned plaintext transport', () => {
    const ca = testCa();
    expect(() => createPinnedServerFetch(
      'http://127.0.0.1:7091',
      ca.certificate,
    )).toThrow(/HTTPS origin/i);
  });
});
