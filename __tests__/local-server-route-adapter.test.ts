import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNREPORTED_DRONE_RUNTIME_METADATA } from './fixtures/runtime-metadata.js';
import { TOOL_MANIFEST } from '../src/tool-manifest.js';
import type { Decision } from 'borgmcp-shared/protocol';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const COORDINATOR_ROLE_ID = '55555555-5555-4555-8555-555555555555';
const COORDINATOR_DRONE_ID = '66666666-6666-4666-8666-666666666666';
const LOG_ID = '44444444-4444-4444-8444-444444444444';
const ORIGIN = 'https://localhost:8787';
const TRUST_IDENTITY = 'spki-sha256:test-server';
const SESSION = 's'.repeat(43);
const ACTIVE_CUBE = {
  cubeId: CUBE_ID,
  droneId: DRONE_ID,
  name: 'local-cube',
  droneLabel: 'builder-1',
  roleName: 'Builder',
  sessionToken: SESSION,
  apiUrl: ORIGIN,
  serverTrustIdentity: TRUST_IDENTITY,
  localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
};
const INITIAL_CURSOR = {
  id: '77777777-7777-4777-8777-777777777777',
  created_at: '2026-07-14T13:00:00.000Z',
};
const ACTIVE_DECISION: Decision = {
  id: '99999999-9999-4999-8999-999999999999',
  cube_id: CUBE_ID,
  topic: 'local',
  decision: 'stay local',
  rationale: null,
  ratified_by: null,
  status: 'active',
  supersedes: null,
  created_at: '2026-09-04T00:00:00.000Z',
};

function envelope(payload: unknown, requestId = 'local-response-1') {
  return { protocol_version: '14', request_id: requestId, payload };
}

function connectionReset(): Error & { code: string } {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

function logEntry(index: number) {
  return {
    id: `88888888-8888-4888-8888-${String(index).padStart(12, '0')}`,
    cube_id: CUBE_ID,
    drone_id: COORDINATOR_DRONE_ID,
    drone_label: 'coordinator-1',
    role_name: 'Release Coordinator',
    message: `DISPATCH item ${index}`,
    visibility: 'direct',
    recipient_drone_ids: [DRONE_ID],
    created_at: new Date(Date.UTC(2026, 7, 27, 0, 0, index)).toISOString(),
  };
}

function logPage(entries: ReturnType<typeof logEntry>[], behindBy: number) {
  const last = entries.at(-1)!;
  return {
    entries,
    cursor: { id: last.id, created_at: last.created_at },
    behind_by: behindBy,
    has_more: behindBy > 0,
  };
}

describe('local server route adapter', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  const getServerCredential = vi.fn(async () => 'parent-enrollment-token');
  const getCursor = vi.fn(async (): Promise<typeof INITIAL_CURSOR | null> => null);
  const advanceCursor = vi.fn(async () => {});

  beforeEach(() => {
    vi.resetModules();
    getServerCredential.mockClear();
    getCursor.mockClear();
    getCursor.mockResolvedValue(null);
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
            ...UNREPORTED_DRONE_RUNTIME_METADATA,
          },
          {
            id: COORDINATOR_DRONE_ID,
            label: 'coordinator-1',
             role_id: COORDINATOR_ROLE_ID,
            ...UNREPORTED_DRONE_RUNTIME_METADATA,
          },
        ] })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'PUT') {
        return new Response(JSON.stringify(envelope({
          entries: [{
            id: LOG_ID,
            cube_id: CUBE_ID,
            drone_id: DRONE_ID,
            drone_label: 'builder-1',
            role_name: 'Builder',
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
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/logs` && method === 'POST') {
        const request = JSON.parse(String(init?.body)).payload;
        const direct = Array.isArray(request.to);
        return new Response(JSON.stringify(envelope({
          entry: {
            id: LOG_ID, cube_id: CUBE_ID, drone_id: DRONE_ID,
            drone_label: 'builder-1', role_name: 'Builder',
            message: request.message,
            visibility: direct ? 'direct' : 'broadcast',
            recipient_drone_ids: direct ? [COORDINATOR_DRONE_ID] : [],
            created_at: '2026-07-14T14:00:00.000Z',
          },
          deduplicated: false,
        })), { status: 201 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/acks` && method === 'POST') {
        return new Response(null, { status: 204 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/role-rationale` && method === 'POST') {
        return new Response(JSON.stringify(envelope({
          role_id: ROLE_ID,
          role_name: 'Builder',
          section: { heading: 'Workflow', body: 'Workflow:\nBuild carefully.' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/roles/${ROLE_ID}` && method === 'DELETE') {
        return new Response(JSON.stringify(envelope({ role_id: ROLE_ID, deleted: true })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones/${DRONE_ID}` && method === 'PATCH') {
        return new Response(JSON.stringify(envelope({
          drone: { id: DRONE_ID, cube_id: CUBE_ID, role_id: ROLE_ID, label: 'builder-1' },
        })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/drones/${DRONE_ID}` && method === 'DELETE') {
        return new Response(JSON.stringify(envelope({ drone_id: DRONE_ID, evicted: true })), { status: 200 });
      }
      if (url.pathname === `/api/cubes/${CUBE_ID}/decisions` && method === 'PUT') {
        return new Response(JSON.stringify(envelope({ decisions: [ACTIVE_DECISION] })), { status: 200 });
      }
      throw new Error(`unexpected local request ${method} ${url.pathname}`);
    });

    vi.doMock('../src/config.js', () => ({
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
      getActiveCube: vi.fn(async () => ACTIVE_CUBE),
    }));
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: getCursor,
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
    await expect(remote.whoami(ACTIVE_CUBE)).resolves.toEqual({
      cube_id: CUBE_ID,
      cube_name: 'local-cube',
      drone_id: DRONE_ID,
      drone_label: 'builder-1',
      role_id: ROLE_ID,
      role_name: 'Builder',
      runtime_metadata: {
        agent_kind: null,
        reported_model: null,
        working_repo_name: null,
        working_repo_origin: null,
      },
      runtime_metadata_reported: false,
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
    await expect(remote.appendLog(SESSION, ORIGIN, 'posted locally', { to: 'broadcast' }))
      .resolves.toMatchObject({ entry: { id: LOG_ID } });
    await remote.ackLogEntry(SESSION, ORIGIN, LOG_ID);
    await expect(remote.listDecisions(SESSION, ORIGIN, 'local'))
      .resolves.toEqual({ decisions: [ACTIVE_DECISION] });

    const calls = fetchSpy.mock.calls.map(([input, init]) => ({
      url: String(input),
      headers: new Headers(init?.headers),
    }));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(({ url }) => url.startsWith(`${ORIGIN}/api/cubes`))).toBe(true);
    expect(calls.every(({ headers }) => headers.get('Authorization') === `Bearer ${SESSION}`)).toBe(true);
    expect(calls.every(({ headers }) => !headers.has('X-Drone-Session'))).toBe(true);
  });

  it.each([
    ['before server processing', false],
    ['after server processing', true],
  ])('retries an unread-cursor read after a connection reset %s without re-reading the cursor', async (_timing, processedBeforeFailure) => {
    const remote = await import('../src/remote-client.js');
    let serverProcessedCursor: typeof INITIAL_CURSOR | null = null;
    getCursor
      .mockResolvedValueOnce(INITIAL_CURSOR)
      .mockResolvedValue({
        id: '88888888-8888-4888-8888-888888888888',
        created_at: '2026-07-14T13:30:00.000Z',
      });
    fetchSpy.mockImplementationOnce(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/logs`);
      expect(init?.method).toBe('PUT');
      // The after-processing case records the cursor before dropping the
      // response, modeling a server that completed the read but lost delivery.
      if (processedBeforeFailure) serverProcessedCursor = INITIAL_CURSOR;
      throw connectionReset();
    });

    await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
      .resolves.toMatchObject({ entries: [{ id: LOG_ID }] });

    const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
    );
    expect(serverProcessedCursor).toEqual(processedBeforeFailure ? INITIAL_CURSOR : null);
    expect(logCalls).toHaveLength(2);
    expect(getCursor).toHaveBeenCalledOnce();
    const firstPayload = JSON.parse(String(logCalls[0][1]?.body)).payload;
    const retryPayload = JSON.parse(String(logCalls[1][1]?.body)).payload;
    expect(firstPayload.cursor).toEqual(INITIAL_CURSOR);
    expect(retryPayload.cursor).toEqual(INITIAL_CURSOR);
    expect(advanceCursor).toHaveBeenCalledOnce();
  });

  it('drains every page when the initial unread backlog exceeds the digest threshold', async () => {
    const remote = await import('../src/remote-client.js');
    const fallbackFetch = fetchSpy.getMockImplementation()!;
    let offset = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== `/api/cubes/${CUBE_ID}/logs` || init?.method !== 'PUT') {
        return fallbackFetch(input, init);
      }
      const limit = JSON.parse(String(init.body)).payload.limit as number;
      const count = Math.min(limit, 51 - offset);
      const entries = Array.from({ length: count }, (_, index) => logEntry(offset + index));
      offset += count;
      return new Response(JSON.stringify(envelope(logPage(entries, 51 - offset))), { status: 200 });
    });

    const result = await remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 });

    expect(result).toMatchObject({ digest: true, capped: 0, behind_by: 0, has_more: false });
    expect(result.entries).toHaveLength(51);
    const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
    );
    expect(logCalls).toHaveLength(2);
    expect(JSON.parse(String(logCalls[1][1]?.body)).payload).toEqual({
      cursor: { id: logEntry(19).id, created_at: logEntry(19).created_at },
      limit: 500,
    });
    expect(advanceCursor).toHaveBeenCalledTimes(2);
    expect(advanceCursor).toHaveBeenLastCalledWith(
      expect.any(Object),
      { id: logEntry(50).id, created_at: logEntry(50).created_at },
    );
  });

  it('stops at the digest fetch cap and reports the unread count not covered', async () => {
    const remote = await import('../src/remote-client.js');
    const fallbackFetch = fetchSpy.getMockImplementation()!;
    let offset = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== `/api/cubes/${CUBE_ID}/logs` || init?.method !== 'PUT') {
        return fallbackFetch(input, init);
      }
      const limit = JSON.parse(String(init.body)).payload.limit as number;
      const count = Math.min(limit, 2010 - offset);
      const entries = Array.from({ length: count }, (_, index) => logEntry(offset + index));
      offset += count;
      return new Response(JSON.stringify(envelope(logPage(entries, 2010 - offset))), { status: 200 });
    });

    const result = await remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 500 });

    expect(result).toMatchObject({ digest: true, capped: 10, behind_by: 10, has_more: true });
    expect(result.entries).toHaveLength(2000);
    const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
    );
    expect(logCalls).toHaveLength(4);
    expect(advanceCursor).toHaveBeenCalledTimes(4);
  });

  it('does not advance the unread watermark past a page that fails decoding', async () => {
    const remote = await import('../src/remote-client.js');
    const fallbackFetch = fetchSpy.getMockImplementation()!;
    let pageNumber = 0;
    fetchSpy.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== `/api/cubes/${CUBE_ID}/logs` || init?.method !== 'PUT') {
        return fallbackFetch(input, init);
      }
      pageNumber += 1;
      if (pageNumber === 1) {
        return new Response(JSON.stringify(envelope(logPage(
          Array.from({ length: 20 }, (_, index) => logEntry(index)),
          31,
        ))), { status: 200 });
      }
      return new Response(JSON.stringify(envelope({
        entries: 'not-an-array',
        cursor: { id: logEntry(50).id, created_at: logEntry(50).created_at },
        behind_by: 0,
        has_more: false,
      })), { status: 200 });
    });

    await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
      .rejects.toThrow();
    expect(advanceCursor).toHaveBeenCalledOnce();
    expect(advanceCursor).toHaveBeenCalledWith(
      expect.any(Object),
      { id: logEntry(19).id, created_at: logEntry(19).created_at },
    );
  });

  it('surfaces unread-log recovery guidance after the bounded reset retry is exhausted', async () => {
    const remote = await import('../src/remote-client.js');
    fetchSpy.mockImplementation(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/logs`);
      expect(init?.method).toBe('PUT');
      throw connectionReset();
    });

    await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
      .rejects.toMatchObject({
        name: 'BorgServerUnreachableError',
        message: expect.stringMatching(/unread log read|borg_read-log unread_only=true|may have reached/i),
      });

    const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
    );
    expect(logCalls).toHaveLength(2);
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('routes unread-cursor 429 responses through the Retry-After retry helper', async () => {
    const remote = await import('../src/remote-client.js');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      fetchSpy.mockImplementationOnce(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/logs`);
        expect(init?.method).toBe('PUT');
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      });

      await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
        .resolves.toMatchObject({ entries: [{ id: LOG_ID }] });

      const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
        new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
      );
      expect(logCalls).toHaveLength(2);
      expect(JSON.parse(String(logCalls[0][1]?.body)).payload)
        .toEqual(JSON.parse(String(logCalls[1][1]?.body)).payload);
    } finally {
      random.mockRestore();
    }
  });

  it('surfaces unread-log recovery guidance after bounded 429 retries are exhausted', async () => {
    const remote = await import('../src/remote-client.js');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      fetchSpy.mockImplementation(async (input, init) => {
        expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/logs`);
        expect(init?.method).toBe('PUT');
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        });
      });

      await expect(remote.readLog(SESSION, ORIGIN, { unreadOnly: true, limit: 20 }))
        .rejects.toMatchObject({
          name: 'BorgServerHttpError',
          status: 429,
          message: expect.stringContaining('borg_read-log unread_only=true'),
        });

      const logCalls = fetchSpy.mock.calls.filter(([input, init]) =>
        new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'PUT'
      );
      expect(logCalls).toHaveLength(4);
    } finally {
      random.mockRestore();
    }
  });

  it('retries a logical log append with one stable post_id after a connection reset', async () => {
    const remote = await import('../src/remote-client.js');
    let firstBody = '';
    fetchSpy.mockImplementationOnce(async (input, init) => {
      expect(new URL(String(input)).pathname).toBe(`/api/cubes/${CUBE_ID}/logs`);
      expect(init?.method).toBe('POST');
      firstBody = String(init?.body);
      throw connectionReset();
    }).mockImplementationOnce(async (_input, init) => {
      expect(String(init?.body)).toBe(firstBody);
      const request = JSON.parse(firstBody).payload;
      return new Response(JSON.stringify(envelope({
        entry: {
          id: LOG_ID, cube_id: CUBE_ID, drone_id: DRONE_ID,
          drone_label: 'builder-1', role_name: 'Builder',
          message: request.message, visibility: 'broadcast', recipient_drone_ids: [],
          created_at: '2026-08-13T21:00:00.000Z',
        },
        deduplicated: true,
      })), { status: 200 });
    });

    await expect(remote.appendLog(SESSION, ORIGIN, 'must append once', { to: 'broadcast' }))
      .resolves.toMatchObject({ entry: { id: LOG_ID }, deduplicated: true });

    const postCalls = fetchSpy.mock.calls.filter(([input, init]) =>
      new URL(String(input)).pathname === `/api/cubes/${CUBE_ID}/logs` && init?.method === 'POST'
    );
    expect(postCalls).toHaveLength(2);
    expect(JSON.parse(firstBody).payload.post_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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
  ])('passes local to selectors by %s to the authoritative server', async (_case, to) => {
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
    expect(JSON.parse(String(post![1]?.body)).payload).toMatchObject({
      message: 'directed locally',
      to,
    });
  });

  it("keeps role-management operations and deletion's advertised remedies reachable (#376)", async () => {
    const remote = await import('../src/remote-client.js');
    const deletion = TOOL_MANIFEST.find((tool) => tool.name === 'borg_delete-role');
    const rationale = TOOL_MANIFEST.find((tool) => tool.name === 'borg_role-rationale');

    expect(deletion?.description).toContain('borg_reassign-drone');
    expect(deletion?.description).toContain('borg_evict-drone');
    expect(rationale?.description).toContain('named section');

    await remote.reassignDrone(DRONE_ID, ROLE_ID);
    await remote.evictDrone(DRONE_ID);
    await remote.deleteRole(ROLE_ID);
    await expect(remote.roleRationale(SESSION, ORIGIN, 'Builder', 'Workflow', TRUST_IDENTITY))
      .resolves.toEqual({
        role: 'Builder',
        section: 'Workflow',
        body: 'Workflow:\nBuild carefully.',
      });

    const roleRequests = fetchSpy.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.includes('/role'),
    );
    expect(roleRequests.map(([input, init]) => [
      new URL(String(input)).pathname,
      init?.method,
      new Headers(init?.headers).get('Authorization'),
      JSON.parse(String(init?.body)).payload,
    ])).toEqual([
      [`/api/cubes/${CUBE_ID}/roles/${ROLE_ID}`, 'DELETE', 'Bearer parent-enrollment-token', {}],
      [`/api/cubes/${CUBE_ID}/role-rationale`, 'POST', `Bearer ${SESSION}`, { role: 'Builder', section: 'Workflow' }],
    ]);
  });

  it('applies the published role-management request and result decoders', async () => {
    const remote = await import('../src/remote-client.js');
    const before = fetchSpy.mock.calls.length;

    await expect(remote.roleRationale(SESSION, ORIGIN, '', 'Workflow', TRUST_IDENTITY))
      .rejects.toMatchObject({ name: 'ProtocolContractError' });
    expect(fetchSpy).toHaveBeenCalledTimes(before);

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope({
      role_id: ROLE_ID,
      role_name: 'Builder',
      section: {
        heading: 'Workflow',
        body: 'Workflow:\nBuild carefully.\n\nBoundaries:\nDo not broaden scope.',
      },
    })), { status: 200 }));
    await expect(remote.roleRationale(SESSION, ORIGIN, 'Builder', 'Workflow', TRUST_IDENTITY))
      .rejects.toMatchObject({ name: 'ProtocolContractError' });

    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(envelope({
      role_id: ROLE_ID,
      deleted: false,
    })), { status: 200 }));
    await expect(remote.deleteRole(ROLE_ID))
      .rejects.toMatchObject({ name: 'ProtocolContractError' });
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
