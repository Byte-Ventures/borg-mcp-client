import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';

describe('remote-client explicit authority connection', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function mockCloudAuth() {
    const getIdToken = vi.fn(async () => 'cloud-token-must-not-be-read');
    const getRefreshToken = vi.fn(async () => 'cloud-refresh-must-not-be-read');
    const getServerCredential = vi.fn(async () => 'persisted-local-token');
    vi.doMock('../src/config.js', () => ({
      getIdToken,
      getRefreshToken,
      clearTokens: vi.fn(async () => {}),
      getServerCredential,
      storeServerCredential: vi.fn(async () => {}),
    }));
    vi.doMock('../src/auth.js', () => ({
      refreshIdToken: vi.fn(async () => {}),
      RefreshTokenInvalidError: class extends Error {},
      RefreshTransientError: class extends Error {},
    }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({
        identity: 'spki-sha256:test-server',
        fetchImpl: (input: string | URL | Request, init?: RequestInit) =>
          globalThis.fetch(input, init),
      })),
    }));
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({
        cubeId: CUBE_ID,
        droneId: DRONE_ID,
        sessionToken: 'drone-session',
        apiUrl: 'https://localhost:8787',
        serverTrustIdentity: 'spki-sha256:test-server',
      })),
    }));
    return { getIdToken, getRefreshToken, getServerCredential };
  }

  it('uses the selected endpoint and token without reading cloud credentials', async () => {
    const auth = mockCloudAuth();
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'cubes-response-1',
        payload: { cubes: [] },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { listCubes } = await import('../src/remote-client.js');
    await listCubes({
      apiUrl: 'https://localhost:8787',
      authToken: 'local-enrollment-token',
      serverTrustIdentity: 'spki-sha256:test-server',
    });

    expect(auth.getIdToken).not.toHaveBeenCalled();
    expect(auth.getRefreshToken).not.toHaveBeenCalled();
    expect(auth.getServerCredential).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://localhost:8787/api/cubes',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer local-enrollment-token' }),
      }),
    );
  });

  it('does not invoke Google refresh when the selected server rejects its credential', async () => {
    const auth = mockCloudAuth();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    const { listCubes } = await import('../src/remote-client.js');
    await expect(listCubes({
      apiUrl: 'https://localhost:8787',
      authToken: 'rejected-local-token',
      serverTrustIdentity: 'spki-sha256:test-server',
    })).rejects.toThrow('selected Borg server');

    expect(auth.getIdToken).not.toHaveBeenCalled();
    expect(auth.getRefreshToken).not.toHaveBeenCalled();
  });

  it('uses the hydrated local drone credential as the sole Bearer after relaunch', async () => {
    const auth = mockCloudAuth();
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      const payload = path.endsWith('/roles')
        ? { roles: [{ id: ROLE_ID, name: 'Builder' }] }
        : path.endsWith('/drones')
          ? { drones: [{ id: DRONE_ID, label: 'builder-1', role_id: ROLE_ID }] }
          : { cube: { id: CUBE_ID, name: 'local-cube' } };
      return new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'cube-response-1',
        payload,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { getCubeInfo } = await import('../src/remote-client.js');
    await getCubeInfo('drone-session', 'https://localhost:8787');

    expect(auth.getIdToken).not.toHaveBeenCalled();
    expect(auth.getRefreshToken).not.toHaveBeenCalled();
    expect(auth.getServerCredential).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://localhost:8787/api/cubes/${CUBE_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer drone-session',
        }),
      }),
    );
    for (const [, init] of fetchSpy.mock.calls) {
      const requestHeaders = new Headers(init?.headers);
      expect(requestHeaders.has('X-Drone-Session')).toBe(false);
    }
  });

  it('does not surface an untrusted server response body in errors', async () => {
    mockCloudAuth();
    const reflectedSecret = 's'.repeat(43);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `reflected ${reflectedSecret}\u001b[2J`,
      { status: 500 },
    )));

    const { listCubes } = await import('../src/remote-client.js');
    let error: unknown;
    try {
      await listCubes({
        apiUrl: 'https://localhost:8787',
        authToken: 'local-enrollment-token',
        serverTrustIdentity: 'spki-sha256:test-server',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Borg server request failed (HTTP 500)');
    expect((error as Error).message).not.toContain(reflectedSecret);
    expect((error as Error).message).not.toContain('\u001b');
  });
});
