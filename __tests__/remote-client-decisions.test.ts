import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * gh#740: recordDecision / listDecisions / removeDecision wire shape.
 *
 * Adapted to the LOCAL server path (cloud severance):
 *  - recordDecision POSTs an enveloped { topic, decision, rationale } to
 *    /api/cubes/:cubeId/decisions.
 *  - listDecisions reads the registry with PUT /api/cubes/:cubeId/decisions
 *    (the local protocol uses PUT for the read) and filters by topic
 *    CLIENT-side — there is no ?topic= query param on the local wire.
 *  - removeDecision is not carried by the local server: it fails closed with
 *    a "does not support" error BEFORE any network call (egress-safe). The old
 *    decision-removal route is not exposed by the local server.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

describe('decision registry request shapes (local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: TRUST_IDENTITY,
        fetchImpl: fetchSpy,
      })),
    }));
    vi.doMock('../src/config.js', () => ({
      getServerCredential: vi.fn(async () => 'p'.repeat(43)),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        name: 'local-cube',
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('recordDecision POSTs {topic, decision, rationale?} to the local decisions route', async () => {
    fetchSpy = vi.fn(async () => new Response(
      JSON.stringify(localEnvelope({ decision: { id: 'd1', topic: 't', status: 'active' } })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const { recordDecision } = await import('../src/remote-client.js');
    const out = await recordDecision(SESSION, ORIGIN, {
      topic: 'pricing-model',
      decision: 'pooled',
      rationale: 'gh#738',
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(`/api/cubes/${CUBE_ID}/decisions`);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body)).payload).toEqual({
      topic: 'pricing-model',
      decision: 'pooled',
      rationale: 'gh#738',
    });
    expect(out.decision.id).toBe('d1');
  });

  it('listDecisions reads the local registry with PUT (no ?topic= query param)', async () => {
    fetchSpy = vi.fn(async () => new Response(
      JSON.stringify(localEnvelope({ decisions: [] })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const { listDecisions } = await import('../src/remote-client.js');
    await listDecisions(SESSION, ORIGIN);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe(`/api/cubes/${CUBE_ID}/decisions`);
    expect(String(url)).not.toContain('?topic=');
    expect(init!.method).toBe('PUT');
  });

  it('listDecisions filters by topic client-side (local wire carries no topic query)', async () => {
    fetchSpy = vi.fn(async () => new Response(
      JSON.stringify(localEnvelope({
        decisions: [
          { id: 'd1', topic: 'release cadence', status: 'active' },
          { id: 'd2', topic: 'pricing-model', status: 'active' },
        ],
      })),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const { listDecisions } = await import('../src/remote-client.js');
    const out = await listDecisions(SESSION, ORIGIN, 'release cadence');
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).not.toContain('?topic=');
    expect(out.decisions).toEqual([{ id: 'd1', topic: 'release cadence', status: 'active' }]);
  });

  it('removeDecision fails closed on the local path before any network call', async () => {
    fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    const { removeDecision } = await import('../src/remote-client.js');
    await expect(removeDecision(SESSION, ORIGIN, { topic: 'release-cadence' }))
      .rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
