import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  decodeGetDocumentRequestEnvelope,
  decodeListDocumentsRequestEnvelope,
  decodePutDocumentRequestEnvelope,
  decodeRemoveDocumentRequestEnvelope,
} from 'borgmcp-shared/protocol';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const DOCUMENT_ID = 'doc_01jz7example';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

const metadata = {
  id: DOCUMENT_ID,
  title: 'Architecture notes',
  size_bytes: 7,
  state: 'active',
  content_type: 'text/markdown',
  supersedes: null,
  superseded_by: null,
  author: { drone_id: DRONE_ID, label: 'builder-1', role: 'Builder' },
  created_at: '2026-08-16T08:00:00.000Z',
  removed_by: null,
  removed_at: null,
} as const;

function envelope(payload: unknown) {
  return { protocol_version: PROTOCOL_VERSION, request_id: 'response-1', payload };
}

function decodeDocumentWireRequest(pathname: string, method: string, body: unknown) {
  const parsed = JSON.parse(String(body));
  const collection = `/api/cubes/${CUBE_ID}/documents`;
  if (pathname === collection && method === 'PUT') {
    return decodePutDocumentRequestEnvelope(parsed).payload;
  }
  if (pathname === collection && method === 'GET') {
    return decodeListDocumentsRequestEnvelope(parsed).payload;
  }
  const pathId = decodeURIComponent(pathname.slice(`${collection}/`.length));
  const request = method === 'DELETE'
    ? decodeRemoveDocumentRequestEnvelope(parsed).payload
    : decodeGetDocumentRequestEnvelope(parsed).payload;
  if (request.id !== pathId) throw new Error('Document path and payload ids differ.');
  return request;
}

describe('local document transport', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      const base = `/api/cubes/${CUBE_ID}/documents`;
      if (url.pathname === base && method === 'PUT') {
        decodeDocumentWireRequest(url.pathname, method, init?.body);
        return new Response(JSON.stringify(envelope({
          document: { ...metadata, content: '# Notes' },
        })), { status: 201 });
      }
      if (url.pathname === base && method === 'GET') {
        decodeDocumentWireRequest(url.pathname, method, init?.body);
        return new Response(JSON.stringify(envelope({ documents: [metadata] })), { status: 200 });
      }
      if (url.pathname === `${base}/${DOCUMENT_ID}` && method === 'GET') {
        decodeDocumentWireRequest(url.pathname, method, init?.body);
        return new Response(JSON.stringify(envelope({
          document: { ...metadata, content: '# Notes' },
        })), { status: 200 });
      }
      if (url.pathname === `${base}/${DOCUMENT_ID}` && method === 'DELETE') {
        decodeDocumentWireRequest(url.pathname, method, init?.body);
        return new Response(JSON.stringify(envelope({
          document: {
            ...metadata,
            state: 'removed',
            removed_by: { drone_id: DRONE_ID, label: 'builder-1', role: 'Builder' },
            removed_at: '2026-08-16T08:30:00.000Z',
          },
        })), { status: 200 });
      }
      throw new Error(`unexpected request ${method} ${url.pathname}`);
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

  it('strictly creates, gets, lists, and removes documents through cube routes', async () => {
    const remote = await import('../src/remote-client.js');
    await expect(remote.putDocument(SESSION, ORIGIN, {
      title: 'Architecture notes',
      content_type: 'text/markdown',
      content: '# Notes',
    }, TRUST_IDENTITY)).resolves.toMatchObject({ document: { id: DOCUMENT_ID, content: '# Notes' } });
    await expect(remote.getDocument(SESSION, ORIGIN, { id: DOCUMENT_ID }, TRUST_IDENTITY))
      .resolves.toMatchObject({ document: { id: DOCUMENT_ID } });
    await expect(remote.listDocuments(SESSION, ORIGIN, {}, TRUST_IDENTITY))
      .resolves.toMatchObject({ documents: [{ id: DOCUMENT_ID }] });
    await expect(remote.removeDocument(SESSION, ORIGIN, { id: DOCUMENT_ID }, TRUST_IDENTITY))
      .resolves.toMatchObject({ document: { id: DOCUMENT_ID, state: 'removed' } });

    const methods = fetchSpy.mock.calls.map(([, init]) => init?.method ?? 'GET');
    expect(methods).toEqual(['PUT', 'GET', 'GET', 'DELETE']);
    const envelopes = fetchSpy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(envelopes.map(({ protocol_version }) => protocol_version)).toEqual([
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
      PROTOCOL_VERSION,
    ]);
    expect(envelopes.every(({ request_id }) => typeof request_id === 'string' && request_id.length > 0))
      .toBe(true);
    expect(envelopes.map(({ payload }) => payload)).toEqual([
      { title: 'Architecture notes', content_type: 'text/markdown', content: '# Notes' },
      { id: DOCUMENT_ID },
      {},
      { id: DOCUMENT_ID },
    ]);
  });

  it('rejects malformed input before network use', async () => {
    const { listDocuments, putDocument } = await import('../src/remote-client.js');
    await expect(putDocument(SESSION, ORIGIN, {
      title: 'Architecture notes',
      content_type: 'text/html',
      content: '<b>unsafe</b>',
    }, TRUST_IDENTITY)).rejects.toThrow(/Unsupported document content type/);
    await expect(listDocuments(SESSION, ORIGIN, { unexpected: true }, TRUST_IDENTITY))
      .rejects.toThrow(/Unknown document field/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed document response', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify(envelope({
      document: { ...metadata, size_bytes: 999, content: '# Notes' },
    })), { status: 200 }));
    const { getDocument } = await import('../src/remote-client.js');
    await expect(getDocument(SESSION, ORIGIN, { id: DOCUMENT_ID }, TRUST_IDENTITY))
      .rejects.toThrow(/size does not match/i);
  });

  it('preserves a strict document refusal code without trusting server prose', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      request_id: 'response-1',
      error: { code: 'DOCUMENT_NOT_FOUND', message: 'untrusted document diagnostic' },
    }), { status: 404 }));
    const { getDocument } = await import('../src/remote-client.js');
    await expect(getDocument(SESSION, ORIGIN, { id: DOCUMENT_ID }, TRUST_IDENTITY))
      .rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('refuses absent, malformed, and path-mismatched request envelopes', () => {
    const path = `/api/cubes/${CUBE_ID}/documents/${DOCUMENT_ID}`;
    expect(() => decodeDocumentWireRequest(path, 'GET', undefined)).toThrow();
    expect(() => decodeDocumentWireRequest(path, 'GET', JSON.stringify({
      protocol_version: '9',
      request_id: 'request-1',
      payload: { id: DOCUMENT_ID },
    }))).toThrow(/protocol/i);
    expect(() => decodeDocumentWireRequest(path, 'GET', JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      request_id: 'request-1',
      payload: { id: 'doc_different' },
    }))).toThrow(/path and payload ids differ/);
  });
});
