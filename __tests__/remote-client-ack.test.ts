import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * gh#418: ackLogEntry gains an optional kind. The default keeps the wire
 * shape stable for pre-#418 callers; kind='claim' sends the claim kind.
 *
 * Adapted to the LOCAL server path (cloud severance): ackLogEntry now routes
 * through the verified local authority to POST /api/cubes/:cubeId/acks with a
 * protocol-enveloped { entry_id, kind } body. The gh#418 kind contract is
 * preserved on this wire (default 'ack', explicit 'claim'). The old cloud
 * retired acknowledgement route is absent and no longer asserted.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

describe('ackLogEntry request body (gh#418 claim kind, local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));

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

  it('defaults to { kind: "ack" } and hits the local cube ack route (back-compat)', async () => {
    const { ackLogEntry } = await import('../src/remote-client.js');
    await ackLogEntry(SESSION, ORIGIN, 'entry-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(`/api/cubes/${CUBE_ID}/acks`);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body)).payload).toEqual({ entry_id: 'entry-1', kind: 'ack' });
  });

  it('sends { kind: "claim" } when claiming', async () => {
    const { ackLogEntry } = await import('../src/remote-client.js');
    await ackLogEntry(SESSION, ORIGIN, 'entry-1', 'claim');
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init!.body)).payload).toEqual({ entry_id: 'entry-1', kind: 'claim' });
  });
});
