import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// gh#499: the borg_create-cube tool POSTs /api/cubes with only
// {retry_key, name, template}, but the server contract requires
// working_repo_name + repository (the CLI create path sources them from the
// caller's git context). The tool must resolve and send them like the CLI,
// so the request stops failing HTTP 400.
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
// Connection override → localOwnerConnection short-circuits (no getActiveCube /
// credential lookup); the mocked server-trust supplies the fetch spy.
const CONN = { apiUrl: ORIGIN, authToken: SESSION, serverTrustIdentity: TRUST_IDENTITY };

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '12', request_id: requestId, payload };
}

describe('createCube sends the server-required repository fields', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let postBodies: any[];

  beforeEach(() => {
    vi.resetModules();
    postBodies = [];
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)).payload : undefined;
      if (url.pathname === '/api/cubes' && method === 'POST') {
        postBodies.push(body);
        return new Response(JSON.stringify(localEnvelope({
          result: 'created',
          cube_id: CUBE_ID,
          human_seat_role_id: '22222222-2222-4222-8222-222222222222',
          default_worker_role_id: '33333333-3333-4333-8333-333333333333',
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(localEnvelope({ cube: { id: CUBE_ID } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({ cube: { id: CUBE_ID, name: 'stress-x', cube_directive: '' } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({ roles: [] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({ drones: [] })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
    }));
    // Deterministic repo identity resolved from the caller's cwd (as the CLI does).
    vi.doMock('../src/repository-identity.js', () => ({
      resolveGitRepositoryContext: vi.fn(async () => ({
        root: '/repo', commonDir: '/repo/.git', derivedName: 'my-repo-derived-name',
        publicRepository: { kind: 'origin', value: 'github.com/Byte-Ventures/borg-mcp-client' },
        publicRepositoryName: 'Byte-Ventures/borg-mcp-client',
      })),
      getOrCreateRepositoryIdentity: vi.fn(async (ctx: any) => ctx.publicRepository),
    }));
  });

  afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });

  it('includes working_repo_name and repository in the POST /api/cubes body', async () => {
    const { createCube } = await import('../src/remote-client.js');
    await createCube('stress-x', 'a directive', { template: 'default' }, CONN);
    expect(postBodies).toHaveLength(1);
    const body = postBodies[0];
    expect(body.name).toBe('stress-x');
    expect(body.template).toBe('default');
    expect(typeof body.retry_key).toBe('string');
    // The fields the server requires (gh#499); working_repo_name is the
    // context's derivedName, matching the CLI create path.
    expect(body.working_repo_name).toBe('my-repo-derived-name');
    expect(body.repository).toEqual({ kind: 'origin', value: 'github.com/Byte-Ventures/borg-mcp-client' });
  });

  it('refuses with a clear client-side error when the cwd is not a git repository', async () => {
    vi.doMock('../src/repository-identity.js', () => ({
      resolveGitRepositoryContext: vi.fn(async () => null),
      getOrCreateRepositoryIdentity: vi.fn(),
    }));
    const { createCube } = await import('../src/remote-client.js');
    await expect(createCube('stress-x', '', { template: 'default' }, CONN)).rejects.toThrow(/git repositor/i);
    // No cube POST was attempted.
    expect(postBodies).toHaveLength(0);
  });

  it('does not overwrite an existing repo cube when the server resolves instead of creating', async () => {
    let patchCalled = false;
    fetchSpy.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)).payload : undefined;
      if (url.pathname === '/api/cubes' && method === 'POST') {
        postBodies.push(body);
        return new Response(JSON.stringify(localEnvelope({
          result: 'resolved',
          cube_id: CUBE_ID,
          human_seat_role_id: '22222222-2222-4222-8222-222222222222',
          default_worker_role_id: '33333333-3333-4333-8333-333333333333',
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'PATCH') {
        patchCalled = true; // record — the CODE must refuse before reaching here
        return new Response(JSON.stringify(localEnvelope({ cube: { id: CUBE_ID } })), { status: 200 });
      }
      return new Response(JSON.stringify(localEnvelope({ cube: { id: CUBE_ID }, roles: [], drones: [] })), { status: 200 });
    });
    const { createCube } = await import('../src/remote-client.js');
    // The code must refuse a resolved (pre-existing) cube, not silently patch it.
    await expect(createCube('stress-x', 'new directive', { template: 'default' }, CONN))
      .rejects.toThrow(/already exists|resolved|repository/i);
    expect(patchCalled).toBe(false);
  });
});
