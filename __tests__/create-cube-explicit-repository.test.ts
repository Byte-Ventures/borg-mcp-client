import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCreateCubeRequest } from 'borgmcp-shared/protocol';
import { normalizeExplicitRepository } from '../src/remote-client';

// client#499: the borg_create-cube tool binds a cube to an EXPLICIT repository
// (no cwd inference). The normalizer turns the argument into the wire's
// { repository, working_repo_name } pair.
describe('normalizeExplicitRepository', () => {
  it('classifies a canonical git remote URL as an origin identity and derives the name', () => {
    expect(normalizeExplicitRepository('https://github.com/Byte-Ventures/borg-mcp-client')).toEqual({
      repository: { kind: 'origin', value: 'https://github.com/Byte-Ventures/borg-mcp-client' },
      workingRepoName: 'borg-mcp-client',
    });
  });

  it('honors an explicit working_repo_name override for an origin', () => {
    expect(normalizeExplicitRepository('https://github.com/owner/repo', 'My Repo')).toEqual({
      repository: { kind: 'origin', value: 'https://github.com/owner/repo' },
      workingRepoName: 'My Repo',
    });
  });

  it('classifies a UUID as a local identity when a name is supplied', () => {
    const uuid = '11111111-2222-4333-8444-555566667777';
    expect(normalizeExplicitRepository(uuid, 'local-project')).toEqual({
      repository: { kind: 'local', value: uuid },
      workingRepoName: 'local-project',
    });
  });

  it('refuses a UUID local repository with no working_repo_name (nothing to derive)', () => {
    expect(() => normalizeExplicitRepository('11111111-2222-4333-8444-555566667777'))
      .toThrow(/working_repo_name is required/);
  });

  it('refuses an absent, empty, non-string, or non-URL non-UUID repository', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}, 'not a url or uuid', 'ftp://x']) {
      expect(() => normalizeExplicitRepository(bad as unknown)).toThrow(/repository/i);
    }
  });

  it('refuses a PRESENT non-string working_repo_name (no silent coercion) — both kinds', () => {
    const uuid = '11111111-2222-4333-8444-555566667777';
    for (const bad of [42, {}, [], true]) {
      expect(() => normalizeExplicitRepository('https://github.com/owner/repo', bad as unknown)).toThrow(/working_repo_name must be a string/);
      expect(() => normalizeExplicitRepository(uuid, bad as unknown)).toThrow(/working_repo_name must be a string/);
    }
  });

  it('refuses a working_repo_name that violates the wire pattern/limit — both kinds', () => {
    const uuid = '11111111-2222-4333-8444-555566667777';
    const tooLong = 'a'.repeat(121);
    for (const bad of [tooLong, 'bad/slash', 'no*stars', 'name#hash', '-leading-dash']) {
      expect(() => normalizeExplicitRepository('https://github.com/owner/repo', bad)).toThrow(/working_repo_name must start/);
      expect(() => normalizeExplicitRepository(uuid, bad)).toThrow(/working_repo_name must start/);
    }
  });
});

// createCube created-vs-resolved boundary: 'created' PATCHes the directive;
// 'resolved' (the repository already has a cube) reports it WITHOUT patching.
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://localhost:8787';
const TRUST = 'spki-sha256:test';
const CONN = { apiUrl: ORIGIN, authToken: 's'.repeat(43), serverTrustIdentity: TRUST };
const REPO = { repository: { kind: 'origin' as const, value: 'https://github.com/owner/repo' }, workingRepoName: 'repo' };
const env = (payload: unknown) => ({ protocol_version: '14', request_id: 'local-response-1', payload });
// The full CreateCubeResponse the shared contract requires (client strictly decodes it).
const CREATE_RESPONSE = (result: 'created' | 'resolved') => ({
  result,
  cube_id: CUBE_ID,
  name: 'c',
  working_repo_name: 'repo',
  repository: { kind: 'origin', value: 'https://github.com/owner/repo' },
  template: 'software-dev',
  human_seat_role_id: '22222222-2222-4222-8222-222222222222',
  default_worker_role_id: '33333333-3333-4333-8333-333333333333',
  access: 'manage',
});

describe('createCube created-vs-resolved boundary', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let patched: boolean;

  function stub(result: 'created' | 'resolved') {
    patched = false;
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/cubes' && method === 'POST') {
        // Full CreateCubeResponse shape (strictly decoded client-side).
        return new Response(JSON.stringify(env(CREATE_RESPONSE(result))), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        patched = true;
        return new Response(JSON.stringify(env({ cube: { id: CUBE_ID } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(env({ cube: { id: CUBE_ID, name: 'c', cube_directive: 'existing' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles`) return new Response(JSON.stringify(env({ roles: [] })), { status: 200 });
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones`) return new Response(JSON.stringify(env({ drones: [] })), { status: 200 });
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST, fetchImpl: fetchSpy })),
    }));
  }

  beforeEach(() => vi.resetModules());
  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('rejects the removed legacy default template at the tag-14 request boundary', () => {
    expect(() => decodeCreateCubeRequest({
      retry_key: 'legacy-default-template',
      name: 'c',
      working_repo_name: 'repo',
      repository: REPO.repository,
      template: 'default',
    })).toThrow(/template/);
  });

  it('created: sends the repository fields, PATCHes the directive, returns result=created', async () => {
    stub('created');
    const { createCube } = await import('../src/remote-client.js');
    const r = await createCube('c', 'new directive', REPO, CONN);
    expect(r.result).toBe('created');
    const body = JSON.parse(String(fetchSpy.mock.calls.find(([, i]) => i?.method === 'POST')![1].body)).payload;
    expect(body).toMatchObject({ working_repo_name: 'repo', repository: REPO.repository, template: 'software-dev' });
    expect(patched).toBe(true);
  });

  it('resolved: does NOT PATCH the existing directive and returns result=resolved', async () => {
    stub('resolved');
    const { createCube } = await import('../src/remote-client.js');
    const r = await createCube('c', 'directive that must NOT land', REPO, CONN);
    expect(r.result).toBe('resolved');
    expect(r.cube).toMatchObject({ id: CUBE_ID, cube_directive: 'existing' });
    expect(patched).toBe(false); // the round-1 stomp defect must not recur
  });

  it('threads an explicitly selected named template', async () => {
    stub('created');
    const { createCube } = await import('../src/remote-client.js');
    await createCube('c', 'directive', { ...REPO, template: 'starter' }, CONN);
    const body = JSON.parse(String(fetchSpy.mock.calls.find(([, i]) => i?.method === 'POST')![1].body)).payload;
    expect(body.template).toBe('starter');
  });

  it('refuses when no explicit repository is provided', async () => {
    stub('created');
    const { createCube } = await import('../src/remote-client.js');
    await expect(createCube('c', 'd', { message_taxonomy: null } as any, CONN)).rejects.toThrow(/explicit repository/);
  });

  it('fails closed on a missing/invalid response result — never PATCHes (client#499 CR)', async () => {
    // The POST response omits `result`; the strict CreateCubeResponse decode
    // must reject it rather than falling through to a 'created' PATCH.
    patched = false;
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/cubes' && method === 'POST') {
        const noResult = { ...CREATE_RESPONSE('created') } as Record<string, unknown>;
        delete noResult.result; // missing required result
        return new Response(JSON.stringify(env(noResult)), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') { patched = true; return new Response(JSON.stringify(env({ cube: { id: CUBE_ID } })), { status: 200 }); }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    vi.doMock('../src/server-trust.js', () => ({ loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST, fetchImpl: fetchSpy })) }));
    const { createCube } = await import('../src/remote-client.js');
    await expect(createCube('c', 'directive', REPO, CONN)).rejects.toThrow();
    expect(patched).toBe(false); // fail-closed: no directive PATCH on an undecodable response
  });
});
