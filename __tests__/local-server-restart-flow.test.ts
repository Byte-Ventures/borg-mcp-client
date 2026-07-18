import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.resetModules();
});

describe('local owner enrollment to restart flow', () => {
  it('enrolls, creates, attaches, restarts, then uses local log and SSE without Cloud', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'borg-local-restart-'));
    const project = join(fixture, 'project');
    mkdirSync(join(project, '.git'), { recursive: true });
    process.env.HOME = fixture;
    process.chdir(project);

    const origin = 'https://localhost:8787';
    const trustIdentity = 'spki-sha256:test-server';
    const cubeId = '11111111-1111-4111-8111-111111111111';
    const roleId = '22222222-2222-4222-8222-222222222222';
    const droneId = '33333333-3333-4333-8333-333333333333';
    const retryKey = '44444444-4444-4444-8444-444444444444';
    const clientId = '55555555-5555-4555-8555-555555555555';
    const humanRoleId = '66666666-6666-4666-8666-666666666666';
    const logId = '77777777-7777-4777-8777-777777777777';
    const invitation = 'i'.repeat(43);
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const operation = { projectRoot: project, kind: 'seat' as const, operationKey: 'current-worktree' };
    const keychain = new Map<string, string>();
    const backend = {
      name: 'keychain' as const,
      get: async (account: string) => keychain.get(account) ?? null,
      set: async (account: string, value: string) => { keychain.set(account, value); },
      delete: async (account: string) => { keychain.delete(account); },
    };
    const response = (payload: unknown, status = 200) => new Response(JSON.stringify({
      protocol_version: '2',
      request_id: 'restart-response-1',
      payload,
    }), { status });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(input.toString()).pathname;
      const method = init?.method ?? 'GET';
      if (path === '/api/enrollment/exchange') {
        return response({
          purpose: 'owner',
          client_id: clientId,
          server_capabilities: ['create_cube'],
        }, 201);
      }
      if (path === '/api/protocol') {
        // Credential-free tag-only preflight: bare exact tag, not enveloped.
        return new Response(JSON.stringify({ protocol_version: '2' }), { status: 200 });
      }
      if (path === '/api/cubes' && method === 'POST') {
        return response({
          cube_id: cubeId,
          human_seat_role_id: humanRoleId,
          default_worker_role_id: roleId,
          access: 'manage',
        }, 201);
      }
      if (path === '/api/client/attach') {
        return response({
          result: 'created',
          cube: { id: cubeId, name: 'local-cube' },
          role: { id: roleId, name: 'Builder', role_class: 'worker', is_human_seat: false },
          drone: { id: droneId, label: 'builder-1' },
          session: { id: sessionId, expires_at: '2026-07-14T16:00:00.000Z' },
        }, 201);
      }
      if (path === `/api/cubes/${cubeId}` && method === 'GET') {
        return response({ cube: { id: cubeId, name: 'local-cube', cube_directive: 'Local directive' } });
      }
      if (path === `/api/cubes/${cubeId}/roles`) {
        return response({ roles: [{ id: roleId, name: 'Builder', detailed_description: 'Build.' }] });
      }
      if (path === `/api/cubes/${cubeId}/drones`) {
        return response({ drones: [{ id: droneId, label: 'builder-1', role_id: roleId }] });
      }
      if (path === `/api/cubes/${cubeId}/logs` && method === 'PUT') {
        return response({ entries: [], cursor: null, behind_by: 0, has_more: false, claims: [] });
      }
      if (path === `/api/cubes/${cubeId}/logs` && method === 'POST') {
        return response({ entry: {
          id: logId,
          cube_id: cubeId,
          drone_id: droneId,
          message: 'post-restart log',
          visibility: 'broadcast',
          created_at: '2026-07-14T15:00:00.000Z',
        } });
      }
      if (path === `/api/cubes/${cubeId}/stream`) {
        return new Response([
          'event: log',
          `id: ${logId}`,
          `data: ${JSON.stringify({
            cursor: { id: logId, created_at: '2026-07-14T15:00:00.000Z' },
            entry: {
              id: logId,
              cube_id: cubeId,
              drone_id: '88888888-8888-4888-8888-888888888888',
              message: 'post-restart stream',
              visibility: 'broadcast',
              created_at: '2026-07-14T15:00:00.000Z',
              drone_label: 'builder-1',
              role_name: 'Builder',
              recipient_drone_ids: [],
            },
          })}`,
          '',
          'event: bookmark',
          `data: ${JSON.stringify({ as_of: '2026-07-14T15:00:01.000Z', replay_complete: true })}`,
          '',
        ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      throw new Error(`unexpected request ${method} ${path}`);
    });
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: trustIdentity, fetchImpl })),
    }));

    try {
      vi.resetModules();
      const config = await import('../src/config.js');
      config.__setServerCredentialBackendForTest(backend);
      const { sendBorgServerAttach, createBorgServerCube, enrollBorgServer } =
        await import('../src/server-handshake.js');
      const enrolled = await enrollBorgServer(origin, trustIdentity, invitation, {
        fetchImpl: fetchImpl as typeof fetch,
        clientName: 'operator-laptop',
      });
      expect(enrolled).toMatchObject({ clientId, serverCapabilities: ['create_cube'] });
      const created = await createBorgServerCube(
        origin,
        trustIdentity,
        enrolled.token,
        { projectRoot: project, name: 'local-cube' },
        { fetchImpl: fetchImpl as typeof fetch },
      );
      expect(created).toMatchObject({ cube_id: cubeId, default_worker_role_id: roleId });
      // The composite path: mint the pending bearer under the keychain lock (as
      // cubes.prepareServerSeatAttachment does), send it, then activate it.
      const pending = await config.getOrCreatePendingServerSession({
        origin, trustIdentity, cubeId, roleId, operation,
      });
      const prepared = await sendBorgServerAttach(
        origin,
        trustIdentity,
        enrolled.token,
        { cubeId, roleId, operation },
        pending.credential,
        { fetchImpl: fetchImpl as typeof fetch },
      );
      const credentialRef = await prepared.activate();
      const attached = {
        cube: prepared.cube,
        role: prepared.role,
        drone: prepared.drone,
        session: { credentialRef, expiresAt: prepared.session.expiresAt },
      };
      // The bearer is client-generated and persisted in the keychain; the client
      // never learns it from the server. Read it back for the post-restart checks.
      const bearer = await config.getActiveServerSessionCredential(
        attached.session.credentialRef,
        { origin, trustIdentity, cubeId },
      );
      expect(bearer).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      const cubes = await import('../src/cubes.js');
      await cubes.setActiveCube({
        cubeId,
        droneId,
        name: attached.cube.name,
        droneLabel: attached.drone.label,
        apiUrl: origin,
        serverTrustIdentity: trustIdentity,
        localSessionCredentialRef: attached.session.credentialRef,
        localSessionExpiresAt: attached.session.expiresAt,
        roleName: attached.role.name,
      });

      const persisted = readFileSync(join(fixture, '.config', 'borgmcp', 'cubes.json'), 'utf8');
      expect(persisted).not.toContain(bearer);
      expect(persisted).toContain(attached.session.credentialRef);

      vi.resetModules();
      const restartedConfig = await import('../src/config.js');
      restartedConfig.__setServerCredentialBackendForTest(backend);
      const restartedCubes = await import('../src/cubes.js');
      const active = await restartedCubes.getActiveCube();
      expect(active?.sessionToken).toBe(bearer);

      const remote = await import('../src/remote-client.js');
      await expect(remote.regen(bearer!, origin)).resolves.toMatchObject({
        cube: { id: cubeId },
        role: { id: roleId },
        drone: { id: droneId },
        behind_by: 0,
      });
      await expect(remote.appendLog(bearer!, origin, 'post-restart log')).resolves
        .toMatchObject({ entry: { id: logId, message: 'post-restart log' } });

      vi.doMock('../src/local-server-cursor.js', () => ({
        getLocalServerCursor: vi.fn(async () => null),
        encodeLocalServerCursor: vi.fn(),
        advanceLocalServerCursor: vi.fn(async () => {}),
      }));
      const appendLine = vi.fn(async () => {});
      const { streamOnce } = await import('../src/log-stream.js');
      await streamOnce(active!, null, vi.fn(), {
        fetchImpl: fetchImpl as typeof fetch,
        appendLine,
        hasInboxEntryId: vi.fn(async () => false),
        getToken: vi.fn(async () => {
          throw new Error('Cloud token must not be read');
        }),
        onInboxReceipt: vi.fn(),
        abortSignal: new AbortController().signal,
      });
      expect(appendLine).toHaveBeenCalledWith(
        cubeId,
        droneId,
        expect.stringContaining('post-restart stream'),
      );

      const localCalls = fetchImpl.mock.calls.filter(([input]) =>
        String(input).startsWith(`${origin}/api/cubes/`)
      );
      expect(localCalls.length).toBeGreaterThan(0);
      expect(localCalls.every(([, init]) =>
        new Headers(init?.headers).get('Authorization') === `Bearer ${bearer}`
      )).toBe(true);
      expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('borgmcp.ai'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
