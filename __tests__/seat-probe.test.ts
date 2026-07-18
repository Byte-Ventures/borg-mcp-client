import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('indeterminate: a 5xx is transient/ambiguous, never destructive', async () => {
    await expect(probe(vi.fn(async () => new Response('boom', { status: 500 })))).resolves.toBe('indeterminate');
  });

  it('indeterminate: a 404 stays non-destructive', async () => {
    await expect(probe(vi.fn(async () => new Response('nope', { status: 404 })))).resolves.toBe('indeterminate');
  });

  it('indeterminate: a network error stays non-destructive', async () => {
    await expect(probe(vi.fn(async () => { throw new Error('ECONNREFUSED'); }))).resolves.toBe('indeterminate');
  });

  it('trust-mismatch: a pinned-identity mismatch is a TERMINAL trust error, not transient/indeterminate', async () => {
    await expect(probe(vi.fn(), 'spki-sha256:DIFFERENT')).resolves.toBe('trust-mismatch');
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

  it('drone-SESSION 401 with ANY non-SESSION_REJECTED typed code → CREDENTIAL_REJECTED (never reset)', async () => {
    for (const code of ['AUTH_INVALID', 'AUTH_EXPIRED', 'AUTH_MISSING', 'SESSION_REVOKED', 'ACCESS_DENIED']) {
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
