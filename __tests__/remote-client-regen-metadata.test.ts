import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * regen() advisory metadata.
 *
 * The deleted file asserted that reported_model / working_repo identity were
 * marshalled into the CLOUD /api/drone/regen query string (with origin
 * canonicalization stripping embedded secrets). After cloud severance, regen on
 * the LOCAL path composes the cube/role/drone/roster through /api/cubes routes
 * and NEVER emits the advisory model or working-repo identity anywhere on the
 * wire. The security intent of the canonicalization test — that a secret-bearing
 * origin must not leak — is preserved here as an egress invariant: no request
 * URL or body may carry the advisory metadata, so no secret can escape. The old
 * cloud query-string route is dead code.
 */

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function localEnvelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '2', request_id: requestId, payload };
}

describe('regen() advisory metadata (local path)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          cube: { id: CUBE_ID, name: 'local-cube', cube_directive: '' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          roles: [{ id: ROLE_ID, name: 'Builder', is_human_seat: false }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          drones: [{ id: DRONE_ID, label: 'builder-1', role_id: ROLE_ID }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'PUT') {
        return new Response(JSON.stringify(localEnvelope({
          entries: [], cursor: null, behind_by: 0, has_more: false, claims: [],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'PUT') {
        return new Response(JSON.stringify(localEnvelope({
          decisions: [
            { id: 'd1', topic: 'release cadence', decision: 'weekly', status: 'active' },
          ],
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
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => null),
      advanceLocalServerCursor: vi.fn(async () => {}),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('composes the cube locally and emits no advisory model or working-repo metadata', async () => {
    const { regen } = await import('../src/remote-client.js');

    const out = await regen(SESSION, ORIGIN, {
      reportedModel: 'gpt-5',
      workingRepo: {
        name: 'borg-mcp',
        origin: 'github.com/borgmcp/borg-mcp',
      },
    });

    expect(out).toMatchObject({
      cube: { id: CUBE_ID },
      role: { id: ROLE_ID },
      drone: { id: DRONE_ID },
    });

    for (const [url, init] of fetchSpy.mock.calls) {
      const requestUrl = String(url);
      expect(requestUrl.startsWith(`${ORIGIN}/api/cubes`)).toBe(true);
      for (const leak of ['reported_model', 'gpt-5', 'working_repo', 'borgmcp/borg-mcp']) {
        expect(requestUrl).not.toContain(leak);
        expect(String(init?.body ?? '')).not.toContain(leak);
      }
    }
  });

  it('composes locally when no advisory metadata is supplied', async () => {
    const { regen } = await import('../src/remote-client.js');
    const out = await regen(SESSION, ORIGIN);
    expect(out).toMatchObject({ cube: { id: CUBE_ID }, drone: { id: DRONE_ID } });
    for (const [url] of fetchSpy.mock.calls) {
      expect(new URL(String(url)).search).toBe('');
    }
  });

  it('fetches the cube decisions and includes them in the composed regen payload (rendered by regen-format)', async () => {
    const { regen } = await import('../src/remote-client.js');
    const { formatRegenMarkdown } = await import('../src/regen-format.js');

    const out = await regen(SESSION, ORIGIN);

    // The local composition fetched the ratified decisions via the existing
    // listDecisions route (PUT /api/cubes/:id/decisions) and included them.
    const decisionsCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        new URL(String(url)).pathname === `/api/cubes/${CUBE_ID}/decisions` &&
        (init?.method ?? 'GET') === 'PUT',
    );
    expect(decisionsCall).toBeDefined();
    expect(out.decisions).toEqual([
      { id: 'd1', topic: 'release cadence', decision: 'weekly', status: 'active' },
    ]);

    // The regen renderer surfaces the decisions section from the composed payload.
    const rendered = formatRegenMarkdown(out as any);
    expect(rendered).toContain('## Ratified decisions');
    expect(rendered).toContain('**release cadence:** weekly');
  });

  it('degrades gracefully when the decisions fetch fails (regen still composes without decisions)', async () => {
    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          cube: { id: CUBE_ID, name: 'local-cube', cube_directive: '' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          roles: [{ id: ROLE_ID, name: 'Builder', is_human_seat: false }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(localEnvelope({
          drones: [{ id: DRONE_ID, label: 'builder-1', role_id: ROLE_ID }],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'PUT') {
        return new Response(JSON.stringify(localEnvelope({
          entries: [], cursor: null, behind_by: 0, has_more: false, claims: [],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'PUT') {
        return new Response('server error', { status: 500 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: TRUST_IDENTITY, fetchImpl: fetchSpy })),
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { regen } = await import('../src/remote-client.js');
    const out = await regen(SESSION, ORIGIN);
    expect(out).toMatchObject({ cube: { id: CUBE_ID }, drone: { id: DRONE_ID } });
    expect(out.decisions).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('never lets a secret-bearing raw origin reach the wire on the local path', async () => {
    const { regen } = await import('../src/remote-client.js');

    await regen(SESSION, ORIGIN, {
      workingRepo: {
        name: 'attacker-controlled',
        origin: 'ssh://git:ssh-secret@github.com/borgmcp/private-repo.git?token=query-secret#fragment-secret',
      },
    });

    for (const [url, init] of fetchSpy.mock.calls) {
      const requestUrl = String(url);
      for (const unsafePart of ['ssh-secret', 'query-secret', 'fragment-secret', 'attacker-controlled', 'private-repo']) {
        expect(requestUrl).not.toContain(unsafePart);
        expect(String(init?.body ?? '')).not.toContain(unsafePart);
      }
    }
  });
});
