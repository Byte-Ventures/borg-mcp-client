import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const COORDINATOR_ROLE_ID = '55555555-5555-4555-8555-555555555555';
const COORDINATOR_DRONE_ID = '66666666-6666-4666-8666-666666666666';
const LOG_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);

function envelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '1', request_id: requestId, payload };
}

describe('local server route adapter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const getIdToken = vi.fn(async () => 'cloud-token-must-not-be-read');
  const getRefreshToken = vi.fn(async () => 'cloud-refresh-must-not-be-read');
  const getServerCredential = vi.fn(async () => 'parent-enrollment-token');
  const advanceCursor = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    getIdToken.mockClear();
    getRefreshToken.mockClear();
    getServerCredential.mockClear();
    advanceCursor.mockClear();

    fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input.toString());
      const method = init?.method ?? 'GET';
      if (url.pathname === '/api/cubes' && method === 'GET') {
        return new Response(JSON.stringify(envelope({ cubes: [{ id: CUBE_ID, name: 'local-cube' }] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}` && method === 'GET') {
        return new Response(JSON.stringify(envelope({ cube: {
          id: CUBE_ID,
          name: 'local-cube',
          cube_directive: 'Local directive',
        } })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles` && method === 'GET') {
        return new Response(JSON.stringify(envelope({ roles: [
          {
            id: ROLE_ID,
            name: 'Builder',
            detailed_description: 'Build carefully.',
            role_class: 'worker',
            is_human_seat: false,
          },
          {
            id: COORDINATOR_ROLE_ID,
            name: 'Release Coordinator',
            detailed_description: 'Coordinate carefully.',
            role_class: 'worker',
            is_human_seat: true,
          },
        ] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones` && method === 'GET') {
        return new Response(JSON.stringify(envelope({ drones: [
          {
            id: DRONE_ID,
            label: 'builder-1',
            role_id: ROLE_ID,
          },
          {
            id: COORDINATOR_DRONE_ID,
            label: 'coordinator-1',
            role_id: COORDINATOR_ROLE_ID,
          },
        ] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'PUT') {
        return new Response(JSON.stringify(envelope({
          entries: [{
            id: LOG_ID,
            cube_id: CUBE_ID,
            drone_id: DRONE_ID,
            message: 'local log',
            visibility: 'direct',
            // `to:` is routing/wake metadata, not a client-side read ACL. The
            // adapter must render every entry returned by the server even when
            // the recipient metadata names another drone.
            recipient_drone_ids: [COORDINATOR_DRONE_ID],
            created_at: '2026-07-14T14:00:00.000Z',
          }],
          cursor: { id: LOG_ID, created_at: '2026-07-14T14:00:00.000Z' },
          behind_by: 0,
          has_more: false,
          claims: [],
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'POST') {
        const request = JSON.parse(String(init?.body)).payload;
        return new Response(JSON.stringify(envelope({ entry: {
          id: LOG_ID,
          cube_id: CUBE_ID,
          drone_id: DRONE_ID,
          message: request.message,
          visibility: request.visibility ?? 'broadcast',
          recipient_drone_ids: request.recipientDroneIds ?? [],
          created_at: '2026-07-14T14:00:00.000Z',
        } })), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/acks` && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'PUT') {
        return new Response(JSON.stringify(envelope({ decisions: [{ topic: 'local', decision: 'stay local' }] })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/config.js', () => ({
      getIdToken,
      getRefreshToken,
      getServerCredential,
      clearTokens: vi.fn(async () => {}),
    }));
    vi.doMock('../src/auth.js', () => ({
      refreshIdToken: vi.fn(async () => {}),
      RefreshTokenInvalidError: class extends Error {},
      RefreshTransientError: class extends Error {},
    }));
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
        name: 'local-cube',
        droneLabel: 'builder-1',
        roleName: 'Builder',
        sessionToken: SESSION,
        apiUrl: ORIGIN,
        serverTrustIdentity: TRUST_IDENTITY,
        localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
        localSessionGeneration: 2,
      })),
    }));
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => null),
      advanceLocalServerCursor: advanceCursor,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('composes core MCP reads and logs only through local cube routes', async () => {
    const remote = await import('../src/remote-client.js');

    const cubeInfo = await remote.getCubeInfo(SESSION, ORIGIN);
    expect(cubeInfo.cube).toMatchObject({ id: CUBE_ID });
    expect(cubeInfo.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ROLE_ID }),
    ]));
    await expect(remote.whoami(SESSION, ORIGIN)).resolves.toEqual({
      cube_id: CUBE_ID,
      cube_name: 'local-cube',
      drone_id: DRONE_ID,
      drone_label: 'builder-1',
      role_id: ROLE_ID,
      role_name: 'Builder',
    });
    await expect(remote.regen(SESSION, ORIGIN)).resolves.toMatchObject({
      cube: { id: CUBE_ID },
      role: { id: ROLE_ID },
      drone: { id: DRONE_ID },
      behind_by: 1,
    });
    await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
      .resolves.toMatchObject({
        entries: [{
          id: LOG_ID,
          visibility: 'direct',
          recipient_drone_ids: [COORDINATOR_DRONE_ID],
        }],
        behind_by: 0,
      });
    await expect(remote.appendLog(SESSION, ORIGIN, 'posted locally'))
      .resolves.toMatchObject({ entry: { id: LOG_ID } });
    await remote.ackLogEntry(SESSION, ORIGIN, LOG_ID);
    await expect(remote.listDecisions(SESSION, ORIGIN, 'local'))
      .resolves.toEqual({ decisions: [{ topic: 'local', decision: 'stay local' }] });

    const calls = fetchSpy.mock.calls.map(([input, init]) => ({
      url: String(input),
      headers: new Headers(init?.headers),
    }));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ url }) => url.startsWith(`${ORIGIN}/api/cubes`))).toBe(true);
    expect(calls.every(({ url }) => !url.includes('/api/drone/'))).toBe(true);
    expect(calls.every(({ headers }) => headers.get('Authorization') === `Bearer ${SESSION}`)).toBe(true);
    expect(calls.every(({ headers }) => !headers.has('X-Drone-Session'))).toBe(true);
    expect(getIdToken).not.toHaveBeenCalled();
    expect(getRefreshToken).not.toHaveBeenCalled();
  });

  it('uses the parent credential only for pre-attach cube selection', async () => {
    const remote = await import('../src/remote-client.js');
    const connection = {
      apiUrl: ORIGIN,
      authToken: 'p'.repeat(43),
      serverTrustIdentity: TRUST_IDENTITY,
    };

    await expect(remote.listCubes(connection)).resolves.toEqual({
      cubes: [{ id: CUBE_ID, name: 'local-cube' }],
    });
    const cube = await remote.getCube(CUBE_ID, connection);
    expect(cube).toMatchObject({ id: CUBE_ID });
    expect(cube.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ROLE_ID }),
    ]));
    expect(cube.drones).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: DRONE_ID }),
    ]));
    expect(fetchSpy.mock.calls.every(([, init]) =>
      new Headers(init?.headers).get('Authorization') === `Bearer ${'p'.repeat(43)}`
    )).toBe(true);
  });

  it.each([
    ['exact label', ['coordinator-1']],
    ['displayed short UUID', ['`id:66666666`']],
    ['role slug', ['release-coordinator']],
  ])('maps local to: recipients by %s into the directed server contract', async (_case, to) => {
    const remote = await import('../src/remote-client.js');

    await expect(remote.appendLog(SESSION, ORIGIN, 'directed locally', {
      to,
      serverTrustIdentity: TRUST_IDENTITY,
    })).resolves.toMatchObject({
      entry: {
        visibility: 'direct',
        recipient_drone_ids: [COORDINATOR_DRONE_ID],
      },
    });

    const post = fetchSpy.mock.calls.find(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` &&
      init?.method === 'POST'
    );
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]?.body)).payload).toEqual({
      message: 'directed locally',
      visibility: 'direct',
      recipientDroneIds: [COORDINATOR_DRONE_ID],
    });
    expect(getIdToken).not.toHaveBeenCalled();
    expect(getRefreshToken).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown local recipient before log mutation', async () => {
    const remote = await import('../src/remote-client.js');

    await expect(remote.appendLog(SESSION, ORIGIN, 'must not broadcast', {
      to: ['missing-seat'],
      serverTrustIdentity: TRUST_IDENTITY,
    })).rejects.toThrow(/Unknown direct-message recipient: missing-seat/);

    expect(fetchSpy.mock.calls.some(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` &&
      init?.method === 'POST'
    )).toBe(false);
  });

  it('fails explicitly before any Cloud-only route is attempted', async () => {
    const remote = await import('../src/remote-client.js');
    const before = fetchSpy.mock.calls.length;

    await expect(remote.submitReport(SESSION, ORIGIN, { message: 'local report' }))
      .rejects.toThrow(/Local Borg server does not support/);
    await expect(remote.roleRationale(SESSION, ORIGIN, 'Builder', 'Workflow'))
      .rejects.toThrow(/Local Borg server does not support/);
    await expect(remote.fetchReports())
      .rejects.toThrow(/Local Borg server does not support/);
    expect(fetchSpy.mock.calls).toHaveLength(before);
  });

  it('rejects a declared local protocol body above the bounded log-page limit', async () => {
    const remote = await import('../src/remote-client.js');
    fetchSpy.mockImplementationOnce(async () => new Response('{}', {
      status: 200,
      headers: {
        'Content-Length': String(remote.LOCAL_SERVER_RESPONSE_LIMIT_BYTES + 1),
      },
    }));

    await expect(remote.listCubes({
      apiUrl: ORIGIN,
      authToken: 'p'.repeat(43),
      serverTrustIdentity: TRUST_IDENTITY,
    })).rejects.toThrow(/response limit/i);
  });

  it('times out a local protocol request that never resolves', async () => {
    const remote = await import('../src/remote-client.js');
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    fetchSpy.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return new Promise<Response>(() => {});
    });

    const rejected = expect(remote.listCubes({
      apiUrl: ORIGIN,
      authToken: 'p'.repeat(43),
      serverTrustIdentity: TRUST_IDENTITY,
    })).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(remote.LOCAL_SERVER_REQUEST_TIMEOUT_MS + 1);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('times out and cancels a local protocol body that never ends', async () => {
    const remote = await import('../src/remote-client.js');
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchSpy.mockImplementationOnce(async () => new Response(new ReadableStream({
      cancel,
    }), { status: 200 }));

    const rejected = expect(remote.listCubes({
      apiUrl: ORIGIN,
      authToken: 'p'.repeat(43),
      serverTrustIdentity: TRUST_IDENTITY,
    })).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(remote.LOCAL_SERVER_REQUEST_TIMEOUT_MS + 1);
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
});
