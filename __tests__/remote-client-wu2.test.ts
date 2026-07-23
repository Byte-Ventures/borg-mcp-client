import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from 'borgmcp-shared/templates';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://127.0.0.1:7091';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function envelope(payload: unknown) {
  return JSON.stringify({ protocol_version: '3', request_id: 'wu2-test', payload });
}

describe('Sprint 10 WU2 local adapter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let roleFixtures: any[];

  beforeEach(() => {
    vi.resetModules();
    roleFixtures = [{ id: ROLE_ID, name: 'Drone', is_default: true }];
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';

      if (url.pathname === '/api/cubes' && method === 'POST') {
        return new Response(envelope({
          cube_id: CUBE_ID,
          human_seat_role_id: ROLE_ID,
          default_worker_role_id: ROLE_ID,
        }), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(envelope({ cube: { id: CUBE_ID, name: 'adopted' } }), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        return new Response(envelope({ cube: { id: CUBE_ID, name: 'adopted' } }), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(envelope({ roles: roleFixtures }), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(envelope({ drones: [{ id: DRONE_ID, role_id: ROLE_ID }] }), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'POST') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'created' } }), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/taxonomy-patch` && method === 'POST') {
        return new Response(envelope({ cube: { id: CUBE_ID, message_taxonomy: [] } }), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}/section-patch` && method === 'POST') {
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
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        name: 'active',
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
      })),
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
});
