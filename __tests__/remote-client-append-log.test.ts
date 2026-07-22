import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * appendLog directed-message request body.
 *
 * Adapted to the LOCAL server path (cloud severance): appendLog routes through
 * the verified local authority to POST /api/cubes/:cubeId/logs with a
 * protocol-enveloped body. The default broadcast omits visibility; an explicit
 * direct send carries { visibility, recipientDroneIds }. Two further behaviours:
 *  - `class:` (server#48 taxonomy routing) is now forwarded on the local append
 *    request in the `class` field; the server classifies/routes it. It is only
 *    honored when no explicit visibility/recipients override it.
 *  - an explicit `to:` array is resolved against the local roster into
 *    recipientDroneIds (a direct send), rather than passed through verbatim.
 * The pre-network contradiction guard (broadcast + non-empty to:) is unchanged.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '3', request_id: requestId, payload };
}

describe('appendLog directed-message request body (local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          roles: [{ id: ROLE_ID, name: 'Builder', is_human_seat: false }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          drones: [{ id: DRONE_ID, label: 'builder-1', role_id: ROLE_ID }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'POST') {
        const request = JSON.parse(String(init?.body)).payload;
        return new Response(JSON.stringify(localEnvelope({
          entry: {
            id: 'entry-1',
            cube_id: CUBE_ID,
            drone_id: DRONE_ID,
            message: request.message,
            visibility: request.visibility ?? 'broadcast',
            recipient_drone_ids: request.recipientDroneIds ?? [],
            created_at: '2026-05-29T20:00:00.000Z',
          },
        })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: TRUST_IDENTITY,
        fetchImpl: fetchSpy,
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
    vi.resetModules();
  });

  function postBody() {
    const post = fetchSpy.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` &&
      init?.method === 'POST'
    );
    expect(post).toBeDefined();
    return JSON.parse(String(post![1]?.body)).payload;
  }

  it('omits visibility fields for default broadcast back-compat', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'hello');
    expect(postBody()).toEqual({ message: 'hello' });
  });

  it('sends direct visibility and recipient ids when requested', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'secret', {
      visibility: 'direct',
      recipientDroneIds: ['drone-2'],
    });
    expect(postBody()).toEqual({
      message: 'secret',
      visibility: 'direct',
      recipientDroneIds: ['drone-2'],
    });
  });

  it('forwards opts.class on the local append for server#48 taxonomy routing', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'STARTING: work', { class: 'status-claim' });
    // class reaches the request body in the server-expected `class` field, with
    // no visibility/recipients so the server performs class-based routing.
    expect(postBody()).toEqual({ message: 'STARTING: work', class: 'status-claim' });
  });

  it('resolves an explicit empty to array into a direct send with no recipients', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'hello', { to: [] });
    expect(postBody()).toEqual({
      message: 'hello',
      visibility: 'direct',
      recipientDroneIds: [],
    });
  });

  it('rejects contradictory to: plus broadcast before authority lookup or POST', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await expect(appendLog(SESSION, ORIGIN, 'contradictory routing', {
      to: ['builder-1'],
      visibility: 'broadcast',
    })).rejects.toThrow(
      /Remove visibility to direct to recipients, or remove to: to broadcast/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
