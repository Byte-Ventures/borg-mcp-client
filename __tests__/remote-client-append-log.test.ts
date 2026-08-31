import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '14', request_id: requestId, payload };
}

describe('appendLog mandatory explicit audience', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'POST') {
        const request = JSON.parse(String(init?.body)).payload;
        const direct = Array.isArray(request.to);
        return new Response(JSON.stringify(localEnvelope({
          entry: {
            id: '44444444-4444-4444-8444-444444444444',
            cube_id: CUBE_ID,
            drone_id: DRONE_ID,
            drone_label: 'builder-1',
            role_name: 'Builder',
            message: request.message,
            visibility: direct ? 'direct' : 'broadcast',
            recipient_drone_ids: direct ? [DRONE_ID] : [],
            created_at: '2026-05-29T20:00:00.000Z',
          },
          deduplicated: false,
          routing: { class: request.class ?? null, recipients: direct ? [DRONE_ID] : [] },
        })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
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

  afterEach(() => vi.resetModules());

  function postBody() {
    const post = fetchSpy.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` &&
      init?.method === 'POST'
    );
    expect(post).toBeDefined();
    return JSON.parse(String(post![1]?.body)).payload;
  }

  it('sends explicit broadcast without public visibility or recipient ids', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'hello', { to: 'broadcast' });
    expect(postBody()).toMatchObject({
      message: 'hello',
      post_id: expect.any(String),
      to: 'broadcast',
    });
    expect(postBody()).not.toHaveProperty('visibility');
    expect(postBody()).not.toHaveProperty('recipientDroneIds');
  });

  it('passes non-empty recipient selectors to the server without local resolution', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'direct', { to: ['builder-1', 'id:12345678'] });
    expect(postBody()).toMatchObject({ to: ['builder-1', 'id:12345678'] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps class as metadata without changing the explicit audience', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'STARTING: work', {
      to: ['coordinator'],
      class: 'status-claim',
    });
    expect(postBody()).toMatchObject({
      message: 'STARTING: work',
      to: ['coordinator'],
      class: 'status-claim',
    });
  });

  it('forwards documents with an explicit audience', async () => {
    const { appendLog } = await import('../src/remote-client.js');
    await appendLog(SESSION, ORIGIN, 'See durable detail.', {
      to: 'broadcast',
      documents: ['doc_01jz7example'],
    });
    expect(postBody()).toMatchObject({
      to: 'broadcast',
      documents: ['doc_01jz7example'],
    });
  });

  it.each(([
    undefined,
    null,
    [],
    'builder-1',
    ['', 'builder-1'],
    [42],
    ['builder-1', 'builder-1'],
    [' builder-1'],
    ['builder-1 '],
    ['builder\u0000one'],
    Array.from({ length: 101 }, (_, index) => `builder-${index}`),
    ['a'.repeat(121)],
    ['é'.repeat(61)],
  ] as unknown[]).map((value) => [value]))(
    'rejects invalid or omitted to before authority or network use %#',
    async (to) => {
      const { appendLog } = await import('../src/remote-client.js');
      await expect(appendLog(SESSION, ORIGIN, 'hello', { to } as never)).rejects.toThrow(/to|selector/);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('preserves a typed server selector refusal', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({
      protocol_version: '14',
      request_id: 'routing-refusal-1',
      error: { code: 'INVALID_INPUT', message: 'Unknown recipient.' },
    }), { status: 400 }));
    const { appendLog } = await import('../src/remote-client.js');

    await expect(appendLog(SESSION, ORIGIN, 'REVIEW-READY', { to: ['missing'] }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(postBody()).toMatchObject({ to: ['missing'] });
  });
});
