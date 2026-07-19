import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * client#39 — local-adapter path/envelope fixes for the migrated working
 * context WRITE surface.
 *
 * Under a verified local (self-hosted) authority the management writes must
 * ride the server#51 coordination routes with a protocol-enveloped body:
 *  - directive SET   → PATCH /api/cubes/:cubeId              { cube_directive }
 *  - role create     → POST  /api/cubes/:cubeId/roles        { name, ... }
 *  - role update     → PATCH /api/cubes/:cubeId/roles/:roleId
 *  - section patch   → POST  /api/cubes/:cubeId/roles/:roleId/section-patch
 *
 * These assert the EXACT request the local adapter issues: cube-scoped path
 * plus the enveloped payload the server decodes. The cloud paths the old code
 * used (/api/roles/:roleId, /api/roles/:roleId/section-patch, and raw
 * non-enveloped bodies) are incompatible with the local server and are gone.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

describe('local-adapter management writes (client#39)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(localEnvelope({
          cube: { id: CUBE_ID, name: 'Hive', cube_directive: 'ship it' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'POST') {
        return new Response(JSON.stringify(localEnvelope({
          role: { id: ROLE_ID, name: 'Builder' },
        })), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(localEnvelope({
          role: { id: ROLE_ID, name: 'Builder' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}/section-patch` && method === 'POST') {
        return new Response(JSON.stringify(localEnvelope({
          role: { id: ROLE_ID, name: 'Builder' },
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

  function call(pathname: string, method: string) {
    const found = fetchSpy.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === pathname && (init?.method ?? 'GET') === method
    );
    expect(found).toBeDefined();
    return {
      url: `${ORIGIN}${pathname}`,
      body: JSON.parse(String(found![1]?.body)),
    };
  }

  it('SETs the cube directive via the manage-scoped cube PATCH', async () => {
    const { updateCube } = await import('../src/remote-client.js');
    const out = await updateCube(CUBE_ID, { cube_directive: 'ship it' });
    const { body } = call(`/api/cubes/${CUBE_ID}`, 'PATCH');
    expect(body.payload).toEqual({ cube_directive: 'ship it' });
    expect(body.request_id).toEqual(expect.any(String));
    expect(out.cube.id).toBe(CUBE_ID);
  });

  it('rejects a local cube rename (no server route) before any network call', async () => {
    const { updateCube } = await import('../src/remote-client.js');
    await expect(updateCube(CUBE_ID, { name: 'Renamed' }))
      .rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates a role via the cube-scoped roles route', async () => {
    const { createRole } = await import('../src/remote-client.js');
    await createRole(CUBE_ID, {
      name: 'Builder',
      short_description: 'builds',
      detailed_description: 'Workflow: build',
      is_default: true,
      role_class: 'queen',
    });
    const { body } = call(`/api/cubes/${CUBE_ID}/roles`, 'POST');
    expect(body.payload).toEqual({
      name: 'Builder',
      short_description: 'builds',
      detailed_description: 'Workflow: build',
      is_default: true,
      role_class: 'queen',
    });
  });

  it('updates a role via the cube-scoped role PATCH (not the cloud /api/roles path)', async () => {
    const { updateRole } = await import('../src/remote-client.js');
    await updateRole(ROLE_ID, { detailed_description: 'Workflow: revised', role_class: 'worker' });
    const { body } = call(`/api/cubes/${CUBE_ID}/roles/${ROLE_ID}`, 'PATCH');
    expect(body.payload).toEqual({
      detailed_description: 'Workflow: revised',
      role_class: 'worker',
    });
  });

  it('patches a role section via the cube-scoped section-patch route', async () => {
    const { patchRoleSection } = await import('../src/remote-client.js');
    await patchRoleSection(ROLE_ID, { action: 'replace', heading: 'Workflow', body: 'do the thing' });
    const { body } = call(`/api/cubes/${CUBE_ID}/roles/${ROLE_ID}/section-patch`, 'POST');
    expect(body.payload).toEqual({
      action: 'replace',
      heading: 'Workflow',
      body: 'do the thing',
    });
  });
});
