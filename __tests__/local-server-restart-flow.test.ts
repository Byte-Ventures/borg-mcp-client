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

describe('local attach to restart flow', () => {
  it('keychains attach output, persists only its reference, then runs regen after restart', async () => {
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
      throw new Error(`unexpected request ${method} ${path}`);
    });
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: trustIdentity, fetchImpl })),
    }));

    try {
      vi.resetModules();
      const config = await import('../src/config.js');
      config.__setServerCredentialBackendForTest(backend);
      const { attachBorgServer } = await import('../src/server-handshake.js');
      const attached = await attachBorgServer(
        origin,
        trustIdentity,
        'p'.repeat(43),
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
      const postRestartCalls = fetchImpl.mock.calls.slice(1);
      expect(postRestartCalls.every(([input]) =>
        String(input).startsWith(`${origin}/api/cubes/`)
      )).toBe(true);
      expect(postRestartCalls.every(([, init]) =>
        new Headers(init?.headers).get('Authorization') === `Bearer ${sessionToken}`
      )).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
