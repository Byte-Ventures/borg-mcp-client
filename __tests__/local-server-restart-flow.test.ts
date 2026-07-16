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
    const sessionToken = 's'.repeat(43);
    const keychain = new Map<string, string>();
    const backend = {
      name: 'keychain' as const,
      get: async (account: string) => keychain.get(account) ?? null,
      set: async (account: string, value: string) => { keychain.set(account, value); },
      delete: async (account: string) => { keychain.delete(account); },
    };
    const response = (payload: unknown, status = 200) => new Response(JSON.stringify({
      protocol_version: '1',
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
        return response({
          protocol_version: '1',
          package: { name: 'borgmcp-shared', version: '0.3.0' },
          capabilities: [
            'coordination.core',
            'auth.bearer',
            'auth.revocation',
            'auth.retry-safe-enrollment',
            'scope.cube-isolation',
            'transport.tls',
            'authority.no-cloud-fallback',
          ],
          limits: {
            max_request_bytes: 65_536,
            max_log_message_bytes: 10_240,
            max_read_page_size: 500,
            max_replay_page_size: 200,
          },
        });
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
          cube: { id: cubeId, name: 'local-cube' },
          role: { id: roleId, name: 'Builder', role_class: 'worker', is_human_seat: false },
          drone: { id: droneId, label: 'builder-1' },
          session: { token: sessionToken, expires_at: '2026-07-14T16:00:00.000Z', generation: 1 },
          reattached: false,
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
      const { attachBorgServer, createBorgServerCube, enrollBorgServer } =
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
      const attached = await attachBorgServer(
        origin,
        trustIdentity,
        enrolled.token,
        { cubeId, roleId, retryKey },
        { fetchImpl: fetchImpl as typeof fetch },
      );
      const cubes = await import('../src/cubes.js');
      await cubes.setActiveCube({
        cubeId,
        droneId,
        name: attached.cube.name,
        droneLabel: attached.drone.label,
        apiUrl: origin,
        serverTrustIdentity: trustIdentity,
        localSessionCredentialRef: attached.session.credentialRef,
        localSessionGeneration: attached.session.generation,
        localSessionExpiresAt: attached.session.expiresAt,
        roleName: attached.role.name,
      });

      const persisted = readFileSync(join(fixture, '.config', 'borgmcp', 'cubes.json'), 'utf8');
      expect(persisted).not.toContain(sessionToken);
      expect(persisted).toContain(attached.session.credentialRef);

      vi.resetModules();
      const restartedConfig = await import('../src/config.js');
      restartedConfig.__setServerCredentialBackendForTest(backend);
      const restartedCubes = await import('../src/cubes.js');
      const active = await restartedCubes.getActiveCube();
      expect(active?.sessionToken).toBe(sessionToken);

      const remote = await import('../src/remote-client.js');
      await expect(remote.regen(sessionToken, origin)).resolves.toMatchObject({
        cube: { id: cubeId },
        role: { id: roleId },
        drone: { id: droneId },
        behind_by: 0,
      });
      await expect(remote.appendLog(sessionToken, origin, 'post-restart log')).resolves
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
        new Headers(init?.headers).get('Authorization') === `Bearer ${sessionToken}`
      )).toBe(true);
      expect(fetchImpl.mock.calls.some(([input]) => String(input).includes('borgmcp.ai'))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
