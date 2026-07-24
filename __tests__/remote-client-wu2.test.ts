import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from 'borgmcp-shared/templates';
import { UNREPORTED_DRONE_RUNTIME_METADATA } from './fixtures/runtime-metadata.js';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_CUBE_ID = '99999999-9999-4999-8999-999999999999';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://127.0.0.1:7091';
const ORIGIN_C = 'https://127.0.0.1:7093';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function envelope(payload: unknown) {
  return JSON.stringify({ protocol_version: '3', request_id: 'wu2-test', payload });
}

describe('Sprint 10 WU2 local adapter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let roleFixtures: any[];
  let activeAuthority: any;

  beforeEach(() => {
    vi.resetModules();
    roleFixtures = [{ id: ROLE_ID, name: 'Drone', is_default: true }];
    activeAuthority = {
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      name: 'active',
      sessionToken: SESSION,
      apiUrl: ORIGIN,
      serverTrustIdentity: TRUST_IDENTITY,
    };
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      const cubeMatch = /^\/api\/cubes\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      const requestedCubeId = cubeMatch?.[1];
      const resource = cubeMatch?.[2];

      if (url.pathname === '/api/cubes' && method === 'POST') {
        return new Response(envelope({
          cube_id: CUBE_ID,
          human_seat_role_id: ROLE_ID,
          default_worker_role_id: ROLE_ID,
        }), { status: 201 });
      }
      if (requestedCubeId && !resource && method === 'GET') {
        return new Response(envelope({ cube: { id: requestedCubeId, name: 'adopted' } }), { status: 200 });
      }
      if (requestedCubeId && !resource && method === 'PATCH') {
        return new Response(envelope({ cube: { id: requestedCubeId, name: 'adopted' } }), { status: 200 });
      }
      if (requestedCubeId && resource === 'roles' && method === 'GET') {
        return new Response(envelope({ roles: roleFixtures }), { status: 200 });
      }
      if (requestedCubeId && resource === 'drones' && method === 'GET') {
        return new Response(envelope({ drones: [{ id: DRONE_ID, role_id: ROLE_ID, ...UNREPORTED_DRONE_RUNTIME_METADATA }] }), { status: 200 });
      }
      if (requestedCubeId && resource === 'roles' && method === 'POST') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'created' } }), { status: 201 });
      }
      if (requestedCubeId && resource?.startsWith('roles/') && method === 'PATCH') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'Builder' } }), { status: 200 });
      }
      if (requestedCubeId && resource === 'taxonomy-patch' && method === 'POST') {
        return new Response(envelope({ cube: { id: CUBE_ID, message_taxonomy: [] } }), { status: 200 });
      }
      if (requestedCubeId && resource?.endsWith('/section-patch') && method === 'POST') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'Drone' } }), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}${url.search}`);
    });

    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
    }));
    vi.doMock('../src/config.js', () => ({
      getServerCredential: vi.fn(async () => 'p'.repeat(43)),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => activeAuthority),
    }));
  });

  it('creates a default-seed cube through the retry-safe local route and reads it back', async () => {
    const { createCube } = await import('../src/remote-client.js');

    await expect(createCube('adopted', 'directive', undefined, {
      apiUrl: ORIGIN,
      authToken: 'owner-token',
      serverTrustIdentity: TRUST_IDENTITY,
    })).resolves.toMatchObject({ id: CUBE_ID, name: 'adopted' });

    const [input, init] = fetchSpy.mock.calls.find(([, request]) => request?.method === 'POST')!;
    expect(new URL(String(input)).pathname).toBe('/api/cubes');
    expect(JSON.parse(String(init.body)).payload).toMatchObject({
      name: 'adopted',
      template: 'default',
    });
  });

  it('passes roster since through to the local drones adapter', async () => {
    const { getRoster } = await import('../src/remote-client.js');
    const since = '2026-07-23T15:00:00.000Z';

    await expect(getRoster(SESSION, ORIGIN, since, TRUST_IDENTITY)).resolves.toMatchObject({
      drones: [{ id: DRONE_ID, role_id: ROLE_ID }],
      since,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      `${ORIGIN}/api/cubes/${CUBE_ID}/drones?since=${encodeURIComponent(since)}`,
      expect.anything(),
    );
  });

  it('applies a template without terminating at localUnsupported', async () => {
    const { applyTemplate } = await import('../src/remote-client.js');
    await expect(applyTemplate(CUBE_ID, 'software-dev')).resolves.toMatchObject({ created: expect.any(Number) });
  });

  it('supports a dry-run role sync without terminating at localUnsupported', async () => {
    const { syncRoles } = await import('../src/remote-client.js');
    await expect(syncRoles(CUBE_ID, 'software-dev', false)).resolves.toMatchObject({
      dryRun: true,
      applied: { added: [], acceptedConflicts: [] },
    });
  });

  it('classifies evolved fragments as conflicts and leaves custom roles untouched', async () => {
    const builder = getTemplate('software-dev')!.roles.find((role) => role.name === 'Builder')!;
    roleFixtures = [
      {
        id: ROLE_ID,
        name: 'Builder',
        short_description: 'An operator-customized Builder.',
        detailed_description: builder.detailed_description.replace('Before changing code:', 'Before changing code:\n- Local evolution.'),
        is_default: true,
      },
      { id: DRONE_ID, name: 'Custom role', detailed_description: 'custom' },
    ];

    const { syncRoles } = await import('../src/remote-client.js');
    const result = await syncRoles(CUBE_ID, 'software-dev');
    const builderResult = result.roles.find((role) => role.name === 'Builder');
    expect(builderResult?.status).toBe('existing');
    expect(builderResult?.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'role:Builder:short_description', kind: 'conflict' }),
      expect.objectContaining({ key: 'role:Builder:section:Before changing code', kind: 'conflict' }),
    ]));
    expect(result.roles).toContainEqual({ name: 'Custom role', status: 'custom-skipped', fragments: [] });
    expect(result.rejectedConflicts).toEqual(expect.arrayContaining([
      'role:Builder:short_description',
      'role:Builder:section:Before changing code',
    ]));
  });

  it('uses the requested non-active cube for existing-role apply and sync mutations', async () => {
    roleFixtures = [{
      id: ROLE_ID,
      name: 'Builder',
      short_description: '',
      detailed_description: '',
      is_default: true,
    }];
    const { applyTemplate, syncRoles } = await import('../src/remote-client.js');

    await applyTemplate(TARGET_CUBE_ID, 'software-dev');
    await syncRoles(TARGET_CUBE_ID, 'software-dev', true);

    const mutations = fetchSpy.mock.calls.filter(([, request]) => {
      const method = request?.method ?? 'GET';
      return method === 'PATCH' || method === 'POST';
    });
    expect(mutations.length).toBeGreaterThan(0);
    for (const [input] of mutations) {
      const path = new URL(String(input)).pathname;
      expect(path).toContain(`/api/cubes/${TARGET_CUBE_ID}/`);
      expect(path).not.toContain(`/api/cubes/${CUBE_ID}/`);
    }
  });

  it('keeps every operation request on the original authority after an active-server swap', async () => {
    roleFixtures = [{ id: ROLE_ID, name: 'Builder', short_description: '', detailed_description: '', is_default: true }];
    let swapped = false;
    const originalFetch = fetchSpy;
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (!swapped && (init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/roles')) {
        swapped = true;
        activeAuthority = { ...activeAuthority, apiUrl: ORIGIN_C };
      }
      return originalFetch(input, init);
    });
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
    }));

    const { syncRoles } = await import('../src/remote-client.js');
    await syncRoles(TARGET_CUBE_ID, 'software-dev', true);

    expect(swapped).toBe(true);
    for (const [input] of fetchSpy.mock.calls) {
      expect(String(input).startsWith(`${ORIGIN}/`)).toBe(true);
      expect(String(input)).not.toContain(ORIGIN_C);
    }
  });
});
