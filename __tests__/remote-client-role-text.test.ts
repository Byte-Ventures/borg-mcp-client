import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_MANIFEST } from '../src/tool-manifest.js';

/**
 * MCP role-text proxy policy.
 *
 * The core invariant is unchanged after cloud severance: the client publishes
 * NO client-side maxLength for role-text tools — the 51,200-char limit is owned
 * by the server, and the client never truncates or length-rejects before the
 * wire. client#39 routes role updates through the verified local authority to
 * the cube-scoped coordination route (/api/cubes/:cubeId/roles/:roleId) with a
 * protocol-enveloped body, so oversized text now reaches the wire intact rather
 * than being turned away — proving no client-side length gate short-circuits
 * ahead of the server. The manifest invariant below is the authoritative
 * no-client-maxLength assertion and is preserved verbatim.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const ROLE_TEXT_LIMIT = 51_200;

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

describe('MCP role-text proxy policy (local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}` && init?.method === 'PATCH') {
        const payload = JSON.parse(String(init?.body)).payload;
        return new Response(JSON.stringify(localEnvelope({
          role: { id: ROLE_ID, name: 'Builder', detailed_description: payload.detailed_description },
        })), { status: 200 });
      }
      return new Response(null, { status: 204 });
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

  function patchBody() {
    const patch = fetchSpy.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}` &&
      init?.method === 'PATCH'
    );
    expect(patch).toBeDefined();
    return JSON.parse(String(patch![1]?.body)).payload;
  }

  it('forwards oversized role text to the wire intact (no client-side length gate)', async () => {
    const repair = 'x'.repeat(ROLE_TEXT_LIMIT + 100);
    const { updateRole } = await import('../src/remote-client.js');
    await updateRole(ROLE_ID, { detailed_description: repair });
    expect(patchBody()).toEqual({ detailed_description: repair });
  });

  it('does not length-reject an oversized update client-side (reaches the local route)', async () => {
    const oversized = 'x'.repeat(ROLE_TEXT_LIMIT + 1);
    const { updateRole } = await import('../src/remote-client.js');
    await updateRole(ROLE_ID, { detailed_description: oversized });
    expect(patchBody().detailed_description).toHaveLength(oversized.length);
  });

  it('does not publish a conflicting client-side maxLength for role-text tools', () => {
    for (const name of ['borg_create-role', 'borg_update-role', 'borg_patch-role-section']) {
      const tool = TOOL_MANIFEST.find((entry) => entry.name === name)!;
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      const field = name === 'borg_patch-role-section' ? properties.body : properties.detailed_description;
      expect(field.maxLength).toBeUndefined();
    }
  });
});
