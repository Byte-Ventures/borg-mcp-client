import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __clearServerTrustCacheForTest,
  createPinnedServerFetch,
  loadBorgServerTrust,
} from '../src/server-trust.js';
import { BorgServerTrustError } from '../src/server-errors.js';

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

// CR5 TLS LATTICE: a raw CA / cert-chain / SAN failure from the pinned transport
// must be a TERMINAL BorgServerTrustError (→ `trust-mismatch`), while a connection
// refusal stays a raw transport error (→ `unreachable`). Exercised against a REAL
// TLS server presenting a wrong certificate — the production wrong-cert regression.
describe('CR5 pinned-transport trust verdicts (real wrong cert)', () => {
  const dirs: string[] = [];
  const servers: HttpsServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'borg-tls-'));
    dirs.push(d);
    return d;
  }
  function genSelfSigned(dir: string, name: string, subj: string, san?: string): { cert: string; key: string } {
    const keyPath = join(dir, `${name}.key`);
    const certPath = join(dir, `${name}.crt`);
    const args = [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-nodes', '-subj', subj,
    ];
    if (san) args.push('-addext', `subjectAltName=${san}`);
    execFileSync('openssl', args, { stdio: 'ignore' });
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  }
  async function startTls(cert: string, key: string): Promise<string> {
    const server = createHttpsServer({ cert, key }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  async function freeClosedPort(cert: string, key: string): Promise<string> {
    const probe = createHttpsServer({ cert, key });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return `https://127.0.0.1:${port}`;
  }

  it('a CA/chain mismatch (server cert not signed by the pinned CA) → terminal BorgServerTrustError', async () => {
    const dir = tmp();
    const server = genSelfSigned(dir, 'srv', '/CN=127.0.0.1', 'IP:127.0.0.1');
    const wrongCa = genSelfSigned(dir, 'wrongca', '/CN=wrong-ca');
    const origin = await startTls(server.cert, server.key);
    const pinned = createPinnedServerFetch(origin, wrongCa.cert);
    await expect(pinned(`${origin}/api/cubes`)).rejects.toBeInstanceOf(BorgServerTrustError);
  });

  it('a SAN/hostname mismatch (chain verifies, wrong SAN) → terminal BorgServerTrustError', async () => {
    const dir = tmp();
    // Self-signed cert with a SAN for a DIFFERENT IP; pin the SAME cert as the CA so
    // the chain verifies but the hostname check fails (ERR_TLS_CERT_ALTNAME_INVALID).
    const san = genSelfSigned(dir, 'san', '/CN=elsewhere', 'IP:10.99.99.99');
    const origin = await startTls(san.cert, san.key);
    const pinned = createPinnedServerFetch(origin, san.cert);
    await expect(pinned(`${origin}/api/cubes`)).rejects.toBeInstanceOf(BorgServerTrustError);
  });

  it('a connection refusal (server down) is NOT trust — it stays a raw transport error (→ unreachable)', async () => {
    const dir = tmp();
    const ca = genSelfSigned(dir, 'ca', '/CN=ca');
    const origin = await freeClosedPort(ca.cert, ca.key);
    const pinned = createPinnedServerFetch(origin, ca.cert);
    await expect(pinned(`${origin}/api/cubes`)).rejects.not.toBeInstanceOf(BorgServerTrustError);
  });

  it('an abort DOMException with numeric code remains a raw cancellation, never a trust verdict', async () => {
    const dir = tmp();
    const serverCert = genSelfSigned(dir, 'srv', '/CN=127.0.0.1', 'IP:127.0.0.1');
    const server = createHttpsServer({ cert: serverCert.cert, key: serverCert.key });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();
    const pinned = createPinnedServerFetch(origin, serverCert.cert);
    const request = pinned(`${origin}/api/cubes`, { signal: controller.signal });
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(request).rejects.not.toBeInstanceOf(BorgServerTrustError);
  });

  it('a post-header pinned abort does not invoke the trust classifier as a TypeError', async () => {
    const dir = tmp();
    const serverCert = genSelfSigned(dir, 'srv', '/CN=127.0.0.1', 'IP:127.0.0.1');
    const server = createHttpsServer({ cert: serverCert.cert, key: serverCert.key }, (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const controller = new AbortController();
    const response = await createPinnedServerFetch(origin, serverCert.cert)(`${origin}/stream`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    controller.abort(new DOMException('cancelled', 'AbortError'));

    await expect(pending).rejects.not.toThrow(/startsWith/);
    reader.releaseLock();
  });
});
