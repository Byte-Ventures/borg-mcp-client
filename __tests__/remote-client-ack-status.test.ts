import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  decodeAckStatusRequestEnvelope,
} from 'borgmcp-shared/protocol';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const RECIPIENT_ID = '55555555-5555-4555-8555-555555555555';
const CLAIMANT_ID = '66666666-6666-4666-8666-666666666666';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function envelope(payload: unknown) {
  return { protocol_version: PROTOCOL_VERSION, request_id: 'response-1', payload };
}

const missingAcknowledgement = {
  entry_id: ENTRY_ID,
  visibility: 'direct',
  recipients: [{
    drone_id: RECIPIENT_ID,
    drone_label: null,
    drone_role: null,
    acknowledged_at: null,
  }],
  claims: [],
};

describe('local acknowledgement-status transport', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const getCursor = vi.fn();
  const advanceCursor = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    getCursor.mockReset();
    advanceCursor.mockReset();
    fetchSpy = vi.fn(async () => new Response(JSON.stringify(envelope(missingAcknowledgement)), {
      status: 200,
    }));
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

  it('queries the exact authenticated cube route and preserves nullable missing acknowledgement', async () => {
    const { getAckStatus } = await import('../src/remote-client.js');
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: ENTRY_ID }, TRUST_IDENTITY))
      .resolves.toEqual(missingAcknowledgement);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0];
    expect(new URL(String(input)).pathname)
      .toBe(`/api/cubes/${CUBE_ID}/logs/${ENTRY_ID}/ack-status`);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${SESSION}` });
    expect(decodeAckStatusRequestEnvelope(JSON.parse(String(init?.body))).payload)
      .toEqual({ entry_id: ENTRY_ID });
    expect(getCursor).not.toHaveBeenCalled();
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('preserves acknowledged recipients, separate advisory claims, and nullable current metadata', async () => {
    const acknowledgedAt = '2026-08-16T17:00:00.000Z';
    const claimedAt = '2026-08-16T17:01:00.000Z';
    const result = {
      ...missingAcknowledgement,
      recipients: [{
        drone_id: RECIPIENT_ID,
        drone_label: 'builder-1',
        drone_role: null,
        acknowledged_at: acknowledgedAt,
      }],
      claims: [{
        drone_id: CLAIMANT_ID,
        drone_label: null,
        drone_role: 'Code Reviewer',
        claimed_at: claimedAt,
      }],
    };
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope(result)), { status: 200 }));
    const { getAckStatus } = await import('../src/remote-client.js');
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: ENTRY_ID }, TRUST_IDENTITY))
      .resolves.toEqual(result);
  });

  it('keeps typed unknown-entry refusal distinct from a known missing acknowledgement', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      request_id: 'response-1',
      error: { code: 'NOT_FOUND', message: 'untrusted detail' },
    }), { status: 404 }));
    const { getAckStatus } = await import('../src/remote-client.js');
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: ENTRY_ID }, TRUST_IDENTITY))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('rejects malformed input before network use', async () => {
    const { getAckStatus } = await import('../src/remote-client.js');
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: 'not-a-uuid' }, TRUST_IDENTITY))
      .rejects.toThrow(/36 UTF-8 bytes|UUID/i);
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: ENTRY_ID, extra: true }, TRUST_IDENTITY))
      .rejects.toThrow(/field/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown response field', { ...missingAcknowledgement, extra: true }],
    ['mismatched entry id', { ...missingAcknowledgement, entry_id: '77777777-7777-4777-8777-777777777777' }],
    ['collapsed claim shape', { ...missingAcknowledgement, claims: [{ drone_id: CLAIMANT_ID, acknowledged_at: null }] }],
  ])('rejects %s', async (_label, payload) => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope(payload)), { status: 200 }));
    const { getAckStatus } = await import('../src/remote-client.js');
    await expect(getAckStatus(SESSION, ORIGIN, { entry_id: ENTRY_ID }, TRUST_IDENTITY)).rejects.toThrow();
  });
});
