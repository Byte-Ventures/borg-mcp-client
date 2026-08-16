import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
} from 'borgmcp-shared/protocol';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555';
const ENTRY_ID = 'abcdef12-4444-4444-8444-444444444444';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function envelope(payload: unknown) {
  return { protocol_version: PROTOCOL_VERSION, request_id: 'response-1', payload };
}

const entry = {
  id: ENTRY_ID,
  cube_id: CUBE_ID,
  drone_id: DRONE_ID,
  drone_label: 'builder-1',
  role_name: 'Builder',
  message: 'Complete directed entry',
  visibility: 'direct',
  recipient_drone_ids: [RECIPIENT_ID],
  created_at: '2026-08-16T18:00:00.000Z',
};

describe('local single-entry transport', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const getCursor = vi.fn();
  const advanceCursor = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    getCursor.mockReset();
    advanceCursor.mockReset();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs/abcdef12` ||
          url.pathname === `/api/cubes/${CUBE_ID}/logs/${ENTRY_ID}`) {
        expect(init?.method).toBe('GET');
        const selector = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
        expect(selector).toMatch(/^(?:abcdef12|abcdef12-4444-4444-8444-444444444444)$/);
        expect(init?.body).toBeUndefined();
        return new Response(JSON.stringify(envelope({ entry })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}`) {
        return new Response(JSON.stringify(envelope({ cube: { id: CUBE_ID, name: 'test-cube' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles`) {
        return new Response(JSON.stringify(envelope({ roles: [{ id: ROLE_ID, name: 'Builder' }] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones`) {
        return new Response(JSON.stringify(envelope({
          drones: [{
            id: DRONE_ID,
            label: 'builder-1',
            role_id: ROLE_ID,
            agent_kind: null,
            reported_model: null,
            working_repo_name: null,
            working_repo_origin: null,
            runtime_metadata_reported: false,
          }],
        })), { status: 200 });
      }
      throw new Error(`unexpected request ${init?.method} ${url.pathname}`);
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
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: getCursor,
      advanceLocalServerCursor: advanceCursor,
    }));
  });

  afterEach(() => vi.resetModules());

  it.each(['ABCDEF12', ENTRY_ID])(
    'reads selector %s through the selected cube without cursor mutation',
    async (selector) => {
    const { readLogEntry } = await import('../src/remote-client.js');
    await expect(readLogEntry(SESSION, ORIGIN, { entry_id: selector }, TRUST_IDENTITY))
      .resolves.toMatchObject({ entry, drones: [{ id: DRONE_ID }], roles: [{ id: ROLE_ID }] });
    expect(getCursor).not.toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
    },
  );

  it.each([
    [404, 'NOT_FOUND'],
    [409, 'LOG_ENTRY_PREFIX_AMBIGUOUS'],
  ])('preserves typed %s refusal %s', async (status, code) => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      request_id: 'response-1',
      error: { code, message: 'untrusted detail' },
    }), { status }));
    const { readLogEntry } = await import('../src/remote-client.js');
    await expect(readLogEntry(SESSION, ORIGIN, { entry_id: 'abcdef12' }, TRUST_IDENTITY))
      .rejects.toMatchObject({ status, code });
    expect(getCursor).not.toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it.each([
    { entry_id: 'abcdef1' },
    { entry_id: 'abcdef123' },
    { entry_id: 'not-hex!!' },
    { entry_id: ENTRY_ID, cursor: null },
  ])('rejects malformed input before network use %#', async (input) => {
    const { readLogEntry } = await import('../src/remote-client.js');
    await expect(readLogEntry(SESSION, ORIGIN, input, TRUST_IDENTITY)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a malformed entry result', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify(envelope({
      entry: { ...entry, recipient_drone_ids: 'not-an-array' },
    })), { status: 200 }));
    const { readLogEntry } = await import('../src/remote-client.js');
    await expect(readLogEntry(SESSION, ORIGIN, { entry_id: 'abcdef12' }, TRUST_IDENTITY))
      .rejects.toThrow();
  });

  it('rejects an entry id that does not match the requested selector', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify(envelope({
      entry: { ...entry, id: '99999999-9999-4999-8999-999999999999' },
    })), { status: 200 }));
    const { readLogEntry } = await import('../src/remote-client.js');
    await expect(readLogEntry(SESSION, ORIGIN, { entry_id: 'abcdef12' }, TRUST_IDENTITY))
      .rejects.toThrow(/does not match/);
  });
});
