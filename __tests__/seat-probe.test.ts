import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Executable production-chain regression (SR-six 02b6f245 / thirty-seven; CR #6):
// the real defaultProbeSeat → whoami → localAuthorityContext → authedFetch path
// must PRESERVE the distinct cause — a pin-matched drone-SESSION 401 → `rejected`
// (→ offline reset), any OTHER 401 → `credential-rejected` (non-destructive
// re-enroll), a trust/identity mismatch → `trust-mismatch` (terminal), a 410
// DRONE_EVICTED → `evicted`, and only 404/5xx/network as `indeterminate`
// (genuinely transient). No collapsing to `indeterminate`; no stubbing of the
// gating probe.

const ORIGIN = 'https://localhost:8787';
const TRUST = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';

function envelope(payload: unknown, requestId = 'r1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

const ACTIVE_CUBE = {
  cubeId: CUBE_ID,
  droneId: DRONE_ID,
  name: 'local-cube',
  droneLabel: 'builder-1',
  apiUrl: ORIGIN,
  serverTrustIdentity: TRUST,
  sessionToken: SESSION,
  roleName: 'Builder',
};

function wireMocks(opts: { fetchImpl: any; trustIdentity?: string }) {
  vi.doMock('../src/config.js', () => ({
    getServerCredential: vi.fn(async () => 'parent-enrollment-token'),
  }));
  vi.doMock('../src/server-trust.js', () => ({
    loadBorgServerTrust: vi.fn(async () => ({
      identity: opts.trustIdentity ?? TRUST,
      fetchImpl: opts.fetchImpl,
    })),
  }));
  vi.doMock('../src/cubes.js', () => ({
    getActiveCube: vi.fn(async () => ACTIVE_CUBE),
  }));
}

// A bounded shared-v2 typed error envelope. Only the exact SESSION_REJECTED code
// (on a drone-session request) may trigger the destructive reset.
function errorEnvelope(code: string, message = 'rejected') {
  return JSON.stringify({ protocol_version: '2', error: { code, message } });
}
const sessionRejected401 = () => vi.fn(async () => new Response(
  errorEnvelope('SESSION_REJECTED', 'the seat is bound to another session'),
  { status: 401 },
));

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('defaultProbeSeat production chain (real whoami → authedFetch verdicts)', () => {
  beforeEach(() => vi.resetModules());

  async function probe(fetchImpl: any, trustIdentity?: string): Promise<string> {
    wireMocks({ fetchImpl, trustIdentity });
    const { defaultProbeSeat } = await import('../src/seat-probe.js');
    return defaultProbeSeat(SESSION, ORIGIN, TRUST);
  }

  // (The `live` and `evicted` end-to-end cases are covered by the local-server
  // route-adapter suite and the evicted-reattach + drone-lifecycle tests; this
  // file focuses on the security-critical 401-classifier verdicts.)
  it('rejected: a 401 whose bounded-decoded v2 envelope carries the EXACT SESSION_REJECTED code', async () => {
    await expect(probe(sessionRejected401())).resolves.toBe('rejected');
  });

  it('credential-rejected: a BARE 401 with no typed envelope is NOT a session rejection (non-destructive re-enroll)', async () => {
    await expect(probe(vi.fn(async () => new Response('unauthorized', { status: 401 })))).resolves.toBe('credential-rejected');
  });

  it('credential-rejected: a 401 with a MALFORMED body fails closed to a non-destructive credential rejection', async () => {
    await expect(probe(vi.fn(async () => new Response('{ not json', { status: 401 })))).resolves.toBe('credential-rejected');
  });

  it('credential-rejected: a 401 with a DIFFERENT typed code (CREDENTIAL_REJECTED) is a credential rejection, not a takeover', async () => {
    await expect(probe(vi.fn(async () => new Response(errorEnvelope('CREDENTIAL_REJECTED'), { status: 401 })))).resolves.toBe('credential-rejected');
  });

  it('server-failure: a 5xx is the server\'s own error (typed by status, never destructive)', async () => {
    await expect(probe(vi.fn(async () => new Response('boom', { status: 500 })))).resolves.toBe('server-failure');
  });

  it('endpoint-mismatch: a 404 is a protocol/version mismatch (typed by status), non-destructive', async () => {
    await expect(probe(vi.fn(async () => new Response('nope', { status: 404 })))).resolves.toBe('endpoint-mismatch');
  });

  it('indeterminate: an unexpected non-ok status (e.g. 418) stays ambiguous, never destructive', async () => {
    await expect(probe(vi.fn(async () => new Response('teapot', { status: 418 })))).resolves.toBe('indeterminate');
  });

  it('unreachable: a transport errno (ECONNREFUSED on the error cause) is classified by CODE, not message text', async () => {
    await expect(probe(vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }))).resolves.toBe('unreachable');
  });

  it('unreachable: a top-level errno code is also transport-classified', async () => {
    await expect(probe(vi.fn(async () => {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }))).resolves.toBe('unreachable');
  });

  it('trust-mismatch: a pinned-identity mismatch is a TERMINAL typed trust verdict, not transient/indeterminate', async () => {
    await expect(probe(vi.fn(), 'spki-sha256:DIFFERENT')).resolves.toBe('trust-mismatch');
  });
});

// CR5 TLS LATTICE — the LIVE wrong-cert case through the REAL probe chain: a raw
// CA/cert/SAN failure from the pinned transport (createPinnedServerFetch, unmocked)
// must surface as `trust-mismatch` (terminal), never `indeterminate`/`unreachable`;
// a genuine connection refusal must stay `unreachable`.
describe('defaultProbeSeat real wrong-cert chain (CR5 TLS lattice)', () => {
  const dirs: string[] = [];
  const servers: HttpsServer[] = [];
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.resetModules();
    vi.clearAllMocks();
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'borg-probe-tls-'));
    dirs.push(d);
    return d;
  }
  function genSelfSigned(dir: string, name: string, subj: string, san?: string): { cert: string; key: string } {
    const keyPath = join(dir, `${name}.key`);
    const certPath = join(dir, `${name}.crt`);
    const args = ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '2', '-nodes', '-subj', subj];
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

  // Wire the probe chain with the REAL createPinnedServerFetch (only loadBorgServerTrust
  // is stubbed, to hand back the real pinned transport for `origin`).
  async function probeRealPinned(origin: string, caPem: string): Promise<string> {
    const actual = await vi.importActual<typeof import('../src/server-trust.js')>('../src/server-trust.js');
    const pinned = actual.createPinnedServerFetch(origin, caPem);
    vi.doMock('../src/config.js', () => ({ getServerCredential: vi.fn(async () => 'parent-enrollment-token') }));
    vi.doMock('../src/cubes.js', () => ({ getActiveCube: vi.fn(async () => ({ ...ACTIVE_CUBE, apiUrl: origin })) }));
    vi.doMock('../src/server-trust.js', () => ({ ...actual, loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST, fetchImpl: pinned })) }));
    const { defaultProbeSeat } = await import('../src/seat-probe.js');
    return defaultProbeSeat(SESSION, origin, TRUST);
  }

  it('a live server presenting a WRONG cert (CA mismatch) → trust-mismatch through the real probe chain', async () => {
    const dir = tmp();
    const server = genSelfSigned(dir, 'srv', '/CN=127.0.0.1', 'IP:127.0.0.1');
    const wrongCa = genSelfSigned(dir, 'wrongca', '/CN=wrong-ca');
    const origin = await startTls(server.cert, server.key);
    await expect(probeRealPinned(origin, wrongCa.cert)).resolves.toBe('trust-mismatch');
  });

  it('a live server that is DOWN (connection refused) → unreachable, never trust-mismatch', async () => {
    const dir = tmp();
    const ca = genSelfSigned(dir, 'ca', '/CN=ca');
    // Bind then close to obtain a definitely-closed port on 127.0.0.1.
    const probe = createHttpsServer({ cert: ca.cert, key: ca.key });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const origin = `https://127.0.0.1:${port}`;
    await expect(probeRealPinned(origin, ca.cert)).resolves.toBe('unreachable');
  });
});

describe('authedFetch 401 typed-code + credential-class classification', () => {
  beforeEach(() => vi.resetModules());

  it('drone-SESSION 401 with the EXACT SESSION_REJECTED code → SESSION_REJECTED', async () => {
    wireMocks({ fetchImpl: sessionRejected401() });
    const { whoami } = await import('../src/remote-client.js');
    await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'SESSION_REJECTED' });
  });

  it('drone-SESSION 401 with a bare/untyped body → CREDENTIAL_REJECTED (bare 401 is never enough)', async () => {
    wireMocks({ fetchImpl: vi.fn(async () => new Response('nope', { status: 401 })) });
    const { whoami } = await import('../src/remote-client.js');
    await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });

  it('parent-ENROLLMENT-credential 401 EVEN WITH a SESSION_REJECTED code → CREDENTIAL_REJECTED (drone-session gate)', async () => {
    wireMocks({ fetchImpl: sessionRejected401() });
    const { listCubes } = await import('../src/remote-client.js');
    await expect(
      listCubes({ apiUrl: ORIGIN, authToken: 'parent-enrollment-token', serverTrustIdentity: TRUST }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });

  it('drone-SESSION 401 with a non-recoverable typed code → CREDENTIAL_REJECTED (never reset)', async () => {
    for (const code of ['AUTH_INVALID', 'AUTH_MISSING', 'SESSION_REVOKED', 'ACCESS_DENIED']) {
      vi.resetModules();
      wireMocks({ fetchImpl: vi.fn(async () => new Response(errorEnvelope(code), { status: 401 })) });
      const { whoami } = await import('../src/remote-client.js');
      await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
    }
  });

  // RQ (a): a WRONG-PROTOCOL-VERSION 401 envelope must fail the bounded decode and
  // fall closed to CREDENTIAL_REJECTED — a SESSION_REJECTED code under the wrong
  // protocol version can NEVER trigger the destructive reset path.
  it('drone-SESSION 401 with a WRONG protocol_version (even carrying SESSION_REJECTED) → CREDENTIAL_REJECTED', async () => {
    const wrongVersion = JSON.stringify({ protocol_version: '1', error: { code: 'SESSION_REJECTED', message: 'rejected' } });
    wireMocks({ fetchImpl: vi.fn(async () => new Response(wrongVersion, { status: 401 })) });
    const { whoami } = await import('../src/remote-client.js');
    await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });

  // RQ (b): a DECLARED + CHUNKED oversized 401 body must trip the bounded read
  // (AUTH_ERROR_ENVELOPE_LIMIT) and fail closed to CREDENTIAL_REJECTED — a hostile
  // server cannot force a reset by padding a SESSION_REJECTED envelope past the cap.
  it('drone-SESSION 401 with a DECLARED + CHUNKED oversized body → bounded-read fail-closed → CREDENTIAL_REJECTED', async () => {
    // > 64 KiB (the auth-error envelope cap). Wrap a real SESSION_REJECTED code in
    // megabytes of padding, delivered as a CHUNKED stream (no Content-Length).
    const huge = 'x'.repeat(200 * 1024);
    const bodyText = JSON.stringify({ protocol_version: '2', pad: huge, error: { code: 'SESSION_REJECTED', message: 'rejected' } });
    const chunkedStream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(bodyText);
        // Emit in 16 KiB chunks so the bounded reader must accumulate + cut off.
        for (let i = 0; i < bytes.length; i += 16 * 1024) {
          controller.enqueue(bytes.subarray(i, i + 16 * 1024));
        }
        controller.close();
      },
    });
    wireMocks({ fetchImpl: vi.fn(async () => new Response(chunkedStream(), { status: 401 })) });
    const { whoami } = await import('../src/remote-client.js');
    await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });
});
