import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

const emptyMetadata = {
  agent_kind: null,
  reported_model: null,
  working_repo_name: null,
  working_repo_origin: null,
};

function localEnvelope(payload: unknown) {
  return { protocol_version: '3', request_id: 'local-response-1', payload };
}

describe('regen() runtime metadata self-heal', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let metadata = { ...emptyMetadata };
  let reported = false;

  beforeEach(() => {
    vi.resetModules();
    metadata = { ...emptyMetadata };
    reported = false;
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones/self/metadata` && method === 'PATCH') {
        const patch = JSON.parse(String(init?.body)).payload;
        metadata = { ...metadata, ...patch };
        reported = true;
        return new Response(JSON.stringify(localEnvelope({
          runtime_metadata: metadata,
          runtime_metadata_reported: reported,
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({ cube: { id: CUBE_ID, name: 'local-cube', cube_directive: '' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({ roles: [{ id: ROLE_ID, name: 'Builder', is_human_seat: false }] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          drones: [{
            id: DRONE_ID,
            label: 'builder-1',
            role_id: ROLE_ID,
            ...metadata,
            runtime_metadata_reported: reported,
          }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'PUT') {
        return new Response(JSON.stringify(localEnvelope({ entries: [], cursor: null, behind_by: 0, has_more: false, claims: [] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'PUT') {
        return new Response(JSON.stringify(localEnvelope({ decisions: [] })), { status: 200 });
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
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => null),
      advanceLocalServerCursor: vi.fn(async () => {}),
    }));
  });

  afterEach(() => vi.resetModules());

  it('patches known metadata through the own-session route before composing identity', async () => {
    const { regen } = await import('../src/remote-client.js');
    const result = await regen(SESSION, ORIGIN, {
      agentKind: 'codex',
      reportedModel: 'openai/gpt-5.6-sol',
      workingRepo: {
        name: 'Byte-Ventures/borg-mcp-client',
        origin: 'https://github.com/Byte-Ventures/borg-mcp-client',
        state: 'known',
      },
      serverTrustIdentity: TRUST_IDENTITY,
    });

    expect(result.drone).toMatchObject({
      agent_kind: 'codex',
      reported_model: 'openai/gpt-5.6-sol',
      working_repo_name: 'Byte-Ventures/borg-mcp-client',
      runtime_metadata_reported: true,
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${ORIGIN}/api/cubes/${CUBE_ID}/drones/self/metadata`);
    expect(init).toMatchObject({
      method: 'PATCH',
      headers: expect.objectContaining({ Authorization: `Bearer ${SESSION}` }),
    });
    expect(JSON.parse(String(init?.body)).payload).toEqual({
      agent_kind: 'codex',
      reported_model: 'openai/gpt-5.6-sol',
      working_repo_name: 'Byte-Ventures/borg-mcp-client',
      working_repo_origin: 'https://github.com/Byte-Ventures/borg-mcp-client',
    });
  });

  it('preserves omission when no runtime facts are supplied', async () => {
    const { regen } = await import('../src/remote-client.js');
    const result = await regen(SESSION, ORIGIN, { serverTrustIdentity: TRUST_IDENTITY });
    expect(result.drone.runtime_metadata_reported).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/drones/self/metadata'))).toBe(false);
  });

  it('uses explicit nulls for detected unknown repository and CLI state', async () => {
    const { regen } = await import('../src/remote-client.js');
    await regen(SESSION, ORIGIN, {
      agentKind: null,
      workingRepo: { name: null, origin: null, state: 'unknown' },
      serverTrustIdentity: TRUST_IDENTITY,
    });
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)).payload).toEqual({
      agent_kind: null,
      working_repo_name: null,
      working_repo_origin: null,
    });
  });

  it('retains prior safe repository metadata when local collection is rejected', async () => {
    const { regen } = await import('../src/remote-client.js');
    await regen(SESSION, ORIGIN, {
      agentKind: 'claude',
      workingRepo: {
        name: null,
        origin: null,
        state: 'rejected',
      },
      serverTrustIdentity: TRUST_IDENTITY,
    });
    const body = String(fetchSpy.mock.calls[0][1]?.body);
    expect(JSON.parse(body).payload).toEqual({ agent_kind: 'claude' });
    expect(body).not.toContain('credential');
  });

  it('never routes metadata to a different active server', async () => {
    const { regen } = await import('../src/remote-client.js');
    await regen(SESSION, ORIGIN, {
      agentKind: 'opencode',
      serverTrustIdentity: TRUST_IDENTITY,
    });
    expect(fetchSpy.mock.calls.every(([url]) => String(url).startsWith(`${ORIGIN}/`))).toBe(true);
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('localhost:9999'))).toBe(true);
  });
});
