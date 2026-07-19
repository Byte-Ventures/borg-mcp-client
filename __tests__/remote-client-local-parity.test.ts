import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const LOG_ID = '44444444-4444-4444-8444-444444444444';
const CROSS_CUBE_LOG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const RESOLVED_SINCE = '2026-07-19T17:00:00.000Z';

function envelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

function errorEnvelope(message: string) {
  return {
    protocol_version: '2',
    request_id: 'local-error-1',
    error: { code: 'INVALID_INPUT', message },
  };
}

describe('local roster-anchor and taxonomy-patch parity', () => {
  let localFetch: ReturnType<typeof vi.fn>;
  let hostedFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    hostedFetch = vi.fn();
    vi.stubGlobal('fetch', hostedFetch);
    localFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';

      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(envelope({
          cube: {
            id: CUBE_ID,
            name: 'local-cube',
            message_taxonomy: [{ class: 'status', prefixes: ['DONE:'], routing: 'broadcast' }],
          },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(envelope({
          roles: [{ id: ROLE_ID, name: 'Builder' }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        const since = url.searchParams.get('since');
        if (since === 'not-an-anchor') {
          return new Response(JSON.stringify(errorEnvelope('since must be an activity entry id or ISO timestamp')), { status: 400 });
        }
        if (since === CROSS_CUBE_LOG_ID) {
          return new Response(JSON.stringify(errorEnvelope('since activity entry does not belong to this cube')), { status: 404 });
        }
        return new Response(JSON.stringify(envelope({
          drones: [{
            id: DRONE_ID,
            label: 'builder-1',
            role_id: ROLE_ID,
            last_seen: RESOLVED_SINCE,
            last_log_post_at: RESOLVED_SINCE,
            seen_since: true,
          }],
          since: RESOLVED_SINCE,
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/taxonomy-patch` && method === 'POST') {
        return new Response(JSON.stringify(envelope({
          cube: { id: CUBE_ID, name: 'local-cube' },
        })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}${url.search}`);
    });

    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: TRUST_IDENTITY,
        fetchImpl: localFetch,
      })),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it.each([LOG_ID, RESOLVED_SINCE])('passes roster anchor %s to the local drones route', async (since) => {
    const { getRoster } = await import('../src/remote-client.js');
    const result = await getRoster(SESSION, ORIGIN, since, TRUST_IDENTITY);

    expect(result).toEqual({
      drones: [expect.objectContaining({
        id: DRONE_ID,
        last_log_post_at: RESOLVED_SINCE,
        seen_since: true,
      })],
      roles: [{ id: ROLE_ID, name: 'Builder' }],
      message_taxonomy: [{ class: 'status', prefixes: ['DONE:'], routing: 'broadcast' }],
      since: RESOLVED_SINCE,
    });
    const dronesCall = localFetch.mock.calls.find(([input]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/drones`
    );
    expect(new URL(String(dronesCall![0])).searchParams.get('since')).toBe(since);
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['not-an-anchor', 400],
    [CROSS_CUBE_LOG_ID, 404],
  ])('surfaces a typed server-derived roster failure for %s', async (since, status) => {
    const { getRoster } = await import('../src/remote-client.js');
    await expect(getRoster(SESSION, ORIGIN, since, TRUST_IDENTITY)).rejects.toMatchObject({
      name: 'BorgServerHttpError',
      status,
    });
    expect(hostedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'add', class_def: { class: 'qa', prefixes: ['QA:'], routing: 'broadcast' } },
    { action: 'replace', class_def: { class: 'qa', prefixes: ['QA-PASS:'], routing: 'broadcast' } },
    { action: 'remove', class: 'qa' },
  ] as const)('sends taxonomy $action through the local cube-scoped route', async (op) => {
    const { patchTaxonomyClass } = await import('../src/remote-client.js');
    await expect(patchTaxonomyClass(CUBE_ID, op)).resolves.toMatchObject({
      cube: { id: CUBE_ID },
    });

    expect(localFetch).toHaveBeenCalledTimes(1);
    const [input, init] = localFetch.mock.calls[0];
    expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/taxonomy-patch`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).payload).toEqual(op);
    expect(hostedFetch).not.toHaveBeenCalled();
  });
});
