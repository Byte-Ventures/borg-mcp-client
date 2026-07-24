import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from 'borgmcp-shared/templates';
import { UNREPORTED_DRONE_RUNTIME_METADATA } from './fixtures/runtime-metadata.js';

const ACTIVE_CUBE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_CUBE_ID = '99999999-9999-4999-8999-999999999999';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN_A = 'https://127.0.0.1:7091';
const ORIGIN_C = 'https://127.0.0.1:7093';
const TRUST_IDENTITY = 'spki-sha256:test-server';

function envelope(payload: unknown) {
  return JSON.stringify({ protocol_version: '3', request_id: 'apply-template-tool-test', payload });
}

describe('borg_apply-template orchestration authority', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let authority: any;

  beforeEach(() => {
    vi.resetModules();
    authority = {
      active: {
        cubeId: ACTIVE_CUBE_ID,
        droneId: DRONE_ID,
        name: 'active',
        sessionToken: 's'.repeat(43),
        apiUrl: ORIGIN_A,
        serverTrustIdentity: TRUST_IDENTITY,
      },
      connection: { apiUrl: ORIGIN_A, authToken: 'manage-a', serverTrustIdentity: TRUST_IDENTITY },
    };
    let swapped = false;
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (!swapped) {
        swapped = true;
        authority.active.apiUrl = ORIGIN_C;
      }
      const base = `/api/cubes/${TARGET_CUBE_ID}`;
      if (url.pathname === base && method === 'GET') {
        return new Response(envelope({ cube: { id: TARGET_CUBE_ID, name: 'target', cube_directive: '', message_taxonomy: [] } }), { status: 200 });
      }
      if (url.pathname === `${base}/roles` && method === 'GET') {
        return new Response(envelope({ roles: [{ id: ROLE_ID, name: 'Builder', short_description: '', detailed_description: '' }] }), { status: 200 });
      }
      if (url.pathname === `${base}/drones` && method === 'GET') {
        return new Response(envelope({ drones: [{ id: DRONE_ID, role_id: ROLE_ID, ...UNREPORTED_DRONE_RUNTIME_METADATA }] }), { status: 200 });
      }
      if (url.pathname === `${base}/roles` && method === 'POST') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'created' } }), { status: 201 });
      }
      if (url.pathname.startsWith(`${base}/roles/`) && method === 'PATCH') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'Builder' } }), { status: 200 });
      }
      if (url.pathname.endsWith('/section-patch') && method === 'POST') {
        return new Response(envelope({ role: { id: ROLE_ID, name: 'Builder' } }), { status: 200 });
      }
      if (url.pathname === `${base}/taxonomy-patch` && method === 'POST') {
        return new Response(envelope({ cube: { id: TARGET_CUBE_ID } }), { status: 200 });
      }
      if (url.pathname === base && method === 'PATCH') {
        return new Response(envelope({ cube: { id: TARGET_CUBE_ID } }), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });
    vi.doMock('../src/server-trust.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/server-trust.js')>(),
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
    }));
  });

  it('keeps the real apply reads, mutations, readback, and directive patch on server A after the active state swaps to C', async () => {
    const { runApplyTemplateTool } = await import('../src/index.js');

    const result = await runApplyTemplateTool(TARGET_CUBE_ID, getTemplate('software-dev')!, authority);
    const requests = fetchSpy.mock.calls.map(([input, init]) => ({
      origin: new URL(String(input)).origin,
      path: new URL(String(input)).pathname,
      method: init?.method ?? 'GET',
    }));
    const base = `/api/cubes/${TARGET_CUBE_ID}`;

    expect(result.summary.created).toBeGreaterThan(0);
    expect(result.summary.updated).toBeGreaterThan(0);
    expect(result.cubeDirectiveNote).toContain('directive applied');
    expect(authority.active.apiUrl).toBe(ORIGIN_C);
    expect(requests.every((request) => request.origin === ORIGIN_A)).toBe(true);
    expect(requests.some((request) => request.origin === ORIGIN_C)).toBe(false);
    expect(requests.filter((request) => request.method === 'GET').map((request) => request.path)).toEqual([
      base,
      `${base}/roles`,
      `${base}/drones`,
      base,
      `${base}/roles`,
      `${base}/drones`,
    ]);
    const mutations = requests.filter((request) => request.method !== 'GET');
    expect(mutations.length).toBeGreaterThan(1);
    expect(mutations.every((request) => request.path.startsWith(base))).toBe(true);
    expect(mutations).toContainEqual({ origin: ORIGIN_A, path: `${base}/roles`, method: 'POST' });
    expect(mutations).toContainEqual({ origin: ORIGIN_A, path: `${base}/roles/${ROLE_ID}`, method: 'PATCH' });
    expect(mutations).toContainEqual({ origin: ORIGIN_A, path: `${base}/roles/${ROLE_ID}/section-patch`, method: 'POST' });
    expect(mutations).toContainEqual({ origin: ORIGIN_A, path: `${base}/taxonomy-patch`, method: 'POST' });
    expect(mutations.at(-1)).toEqual({ origin: ORIGIN_A, path: base, method: 'PATCH' });
  });
});
