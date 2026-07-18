import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Executable production-chain regression (SR-six 02b6f245 / thirty-seven): the
// real defaultProbeSeat → whoami → localAuthorityContext → authedFetch path must
// classify a pin-matched drone-SESSION 401 as `rejected` (→ scoped reset), a
// parent-enrollment-credential 401 as CREDENTIAL_REJECTED (never a reset), a 410
// DRONE_EVICTED as `evicted`, and 404/5xx/network/trust-mismatch as
// `indeterminate` (non-destructive). No stubbing of the gating probe.

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

const liveFetch = () => vi.fn(async (input: string | URL | Request) => {
  const url = new URL(input.toString());
  if (url.pathname === `/api/cubes/${CUBE_ID}`) {
    return new Response(JSON.stringify(envelope({ cube: { id: CUBE_ID, name: 'local-cube' } })), { status: 200 });
  }
  if (url.pathname === `/api/cubes/${CUBE_ID}/roles`) {
    return new Response(JSON.stringify(envelope({ roles: [{ id: ROLE_ID, name: 'Builder' }] })), { status: 200 });
  }
  if (url.pathname === `/api/cubes/${CUBE_ID}/drones`) {
    return new Response(JSON.stringify(envelope({ drones: [{ id: DRONE_ID, label: 'builder-1', role_id: ROLE_ID }] })), { status: 200 });
  }
  throw new Error(`unexpected ${url.pathname}`);
});

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
  it('rejected: a pin-matched 401 on the drone SESSION bearer (→ scoped reset)', async () => {
    await expect(probe(vi.fn(async () => new Response('unauthorized', { status: 401 })))).resolves.toBe('rejected');
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

  it('indeterminate: a trust-identity mismatch is NOT a session rejection', async () => {
    await expect(probe(vi.fn(), 'spki-sha256:DIFFERENT')).resolves.toBe('indeterminate');
  });
});

describe('authedFetch 401 credential-class classification (session vs enrollment)', () => {
  beforeEach(() => vi.resetModules());

  it('a drone-SESSION 401 throws SESSION_REJECTED (whoami path)', async () => {
    wireMocks({ fetchImpl: vi.fn(async () => new Response('unauthorized', { status: 401 })) });
    const { whoami } = await import('../src/remote-client.js');
    await expect(whoami(SESSION, ORIGIN, TRUST)).rejects.toMatchObject({ code: 'SESSION_REJECTED' });
  });

  it('a parent-ENROLLMENT-credential 401 throws CREDENTIAL_REJECTED, NEVER SESSION_REJECTED (list-cubes path)', async () => {
    wireMocks({ fetchImpl: vi.fn(async () => new Response('unauthorized', { status: 401 })) });
    const { listCubes } = await import('../src/remote-client.js');
    await expect(
      listCubes({ apiUrl: ORIGIN, authToken: 'parent-enrollment-token', serverTrustIdentity: TRUST }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });
});
