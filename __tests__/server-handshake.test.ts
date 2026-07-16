import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_SERVER_ORIGIN,
  attachBorgServer,
  connectEnrolledBorgServer,
  createBorgServerCube,
  enrollBorgServer,
  probeBorgServer,
  negotiateBorgServer,
  resumeBorgServerEnrollment,
} from '../src/server-handshake.js';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const RETRY_KEY = '44444444-4444-4444-8444-444444444444';

const protocolInfo = {
  protocol_version: '1',
  package: { name: 'borgmcp-shared', version: '0.2.0' },
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
};

describe('self-hosted server handshake', () => {
  it('tracks the server-owned loopback default from the Part 2 service contract', () => {
    expect(DEFAULT_LOCAL_SERVER_ORIGIN).toBe('https://127.0.0.1:7091');
  });

  it('detects only the shared bodyless health response', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(probeBorgServer('https://localhost:8787', fetchImpl as typeof fetch)).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('https://localhost:8787/healthz', expect.objectContaining({
      method: 'GET',
      redirect: 'error',
    }));

    fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(probeBorgServer('https://localhost:8787', fetchImpl as typeof fetch)).resolves.toBe(false);
  });

  it('authenticates, decodes the envelope, and enforces mandatory capabilities', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '1',
      request_id: 'request-12345678',
      payload: protocolInfo,
    }), { status: 200 }));

    await expect(negotiateBorgServer(
      'https://server.example.com',
      'c'.repeat(43),
      fetchImpl as typeof fetch,
    )).resolves.toMatchObject({ package: { name: 'borgmcp-shared' } });
    expect(fetchImpl).toHaveBeenCalledWith('https://server.example.com/api/protocol', expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: `Bearer ${'c'.repeat(43)}` }),
    }));
  });

  it('fails closed for missing security capabilities and malformed envelopes', async () => {
    const withoutRevocation = {
      ...protocolInfo,
      capabilities: protocolInfo.capabilities.filter((capability) => capability !== 'auth.revocation'),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '1',
      request_id: 'request-12345678',
      payload: withoutRevocation,
    }), { status: 200 }));

    await expect(negotiateBorgServer('https://server.example.com', 'c'.repeat(43), fetchImpl as typeof fetch))
      .rejects.toThrow(/auth\.revocation/);

    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ ...protocolInfo }), { status: 200 }));
    await expect(negotiateBorgServer('https://server.example.com', 'c'.repeat(43), fetchImpl as typeof fetch))
      .rejects.toThrow(/Unknown field "package"/);
  });

  it('does not follow redirects or expose response bodies in auth errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('credential leaked in diagnostic', { status: 401 }));

    await expect(negotiateBorgServer('https://server.example.com', 'c'.repeat(43), fetchImpl as typeof fetch))
      .rejects.toThrow('stored Borg server credential was rejected');
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects header-unsafe credentials and oversized protocol bodies before decoding', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(65_537), { status: 200 }));

    await expect(negotiateBorgServer('https://server.example.com', `${'c'.repeat(43)}\n`, fetchImpl as typeof fetch))
      .rejects.toThrow(/credential is invalid/i);
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(negotiateBorgServer('https://server.example.com', 'c'.repeat(43), fetchImpl as typeof fetch))
      .rejects.toThrow(/response limit/i);
  });

  it('loads only the credential bound to the verified server identity', async () => {
    const loadCredential = vi.fn(async () => 'c'.repeat(43));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '1',
      request_id: 'request-12345678',
      payload: protocolInfo,
    }), { status: 200 }));

    await expect(connectEnrolledBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      { loadCredential, fetchImpl: fetchImpl as typeof fetch },
    )).resolves.toMatchObject({ token: 'c'.repeat(43) });
    expect(loadCredential).toHaveBeenCalledWith('https://server.example.com', 'sha256:server-a');
  });

  it('stops before network access when the verified identity has no credential', async () => {
    const fetchImpl = vi.fn();
    await expect(connectEnrolledBorgServer(
      'https://server.example.com',
      'sha256:server-b',
      { loadCredential: async () => null, fetchImpl: fetchImpl as typeof fetch },
    )).rejects.toThrow(/no enrolled credential/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enrolls through a versioned body, negotiates, then stores the bound credential', async () => {
    const invitation = 'i'.repeat(43);
    const credential = 'c'.repeat(43);
    const retryKey = '55555555-5555-4555-8555-555555555555';
    const clientId = '66666666-6666-4666-8666-666666666666';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'enroll-request-1',
        payload: {
          purpose: 'owner',
          client_id: clientId,
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'protocol-request-1',
        payload: protocolInfo,
      }), { status: 200 }));
    const prepareEnrollment = vi.fn(async () => ({
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      invitation,
      retryKey,
      credential,
      clientName: 'operator-laptop',
    }));
    const activateEnrollment = vi.fn(async () => {});

    await expect(enrollBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      invitation,
      {
        fetchImpl: fetchImpl as typeof fetch,
        prepareEnrollment,
        activateEnrollment,
        clientName: 'operator-laptop',
      },
    )).resolves.toMatchObject({
      token: credential,
      clientId,
      serverCapabilities: ['create_cube'],
    });

    const [enrollmentUrl, enrollmentInit] = fetchImpl.mock.calls[0];
    expect(enrollmentUrl).toBe('https://server.example.com/api/enrollment/exchange');
    expect(enrollmentInit).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = JSON.parse(String(enrollmentInit?.body));
    expect(body).toMatchObject({
      protocol_version: '1',
      payload: {
        invitation,
        retry_key: retryKey,
        client_credential: credential,
        client_name: 'operator-laptop',
      },
    });
    expect(String(enrollmentUrl)).not.toContain(invitation);
    expect(activateEnrollment).toHaveBeenCalledWith({
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      retryKey,
      credential,
      clientId,
      serverCapabilities: ['create_cube'],
    });
    expect(prepareEnrollment.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0],
    );
    expect(activateEnrollment.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchImpl.mock.invocationCallOrder[1],
    );
  });

  it('does not send an invitation when the pending keychain write fails', async () => {
    const fetchImpl = vi.fn();
    await expect(enrollBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      'i'.repeat(43),
      {
        fetchImpl: fetchImpl as typeof fetch,
        prepareEnrollment: vi.fn(async () => {
          throw new Error('keychain locked');
        }),
      },
    )).rejects.toThrow('keychain locked');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a rejected invitation without reading or storing the response body', async () => {
    const reflectedInvitation = 'i'.repeat(43);
    const fetchImpl = vi.fn(async () => new Response(
      `reflected ${reflectedInvitation}`,
      { status: 401 },
    ));
    const pending = {
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      invitation: reflectedInvitation,
      retryKey: '55555555-5555-4555-8555-555555555555',
      credential: 'c'.repeat(43),
    };
    const clearPendingEnrollment = vi.fn(async () => {});
    const activateEnrollment = vi.fn(async () => {});

    let error: unknown;
    try {
      await enrollBorgServer(
        'https://server.example.com',
        'sha256:server-a',
        reflectedInvitation,
        {
          fetchImpl: fetchImpl as typeof fetch,
          prepareEnrollment: vi.fn(async () => pending),
          activateEnrollment,
          clearPendingEnrollment,
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVITATION_REJECTED' });
    expect((error as Error).message).not.toContain(reflectedInvitation);
    expect(activateEnrollment).not.toHaveBeenCalled();
    expect(clearPendingEnrollment).toHaveBeenCalledWith(
      pending.origin,
      pending.trustIdentity,
      pending.retryKey,
    );
  });

  it('retries an ambiguous enrollment with the exact persisted tuple', async () => {
    const pending = {
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      invitation: 'i'.repeat(43),
      retryKey: '55555555-5555-4555-8555-555555555555',
      credential: 'c'.repeat(43),
      clientName: 'operator-laptop',
    };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'enroll-retry-1',
        payload: {
          purpose: 'owner',
          client_id: '66666666-6666-4666-8666-666666666666',
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'protocol-retry-1',
        payload: protocolInfo,
      }), { status: 200 }));
    const activateEnrollment = vi.fn(async () => {});

    await enrollBorgServer(
      pending.origin,
      pending.trustIdentity,
      pending.invitation,
      {
        fetchImpl: fetchImpl as typeof fetch,
        prepareEnrollment: vi.fn(async () => pending),
        activateEnrollment,
        clientName: pending.clientName,
      },
    );

    const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    const retry = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload).toEqual({
      invitation: pending.invitation,
      retry_key: pending.retryKey,
      client_credential: pending.credential,
      client_name: pending.clientName,
    });
    expect(activateEnrollment).toHaveBeenCalledTimes(1);
  });

  it('resumes a persisted enrollment after restart with its exact stored tuple', async () => {
    const pending = {
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      invitation: 'i'.repeat(43),
      retryKey: '55555555-5555-4555-8555-555555555555',
      credential: 'c'.repeat(43),
      clientName: 'operator-laptop',
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'enroll-resume-1',
        payload: {
          purpose: 'owner',
          client_id: '66666666-6666-4666-8666-666666666666',
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'protocol-resume-1',
        payload: protocolInfo,
      }), { status: 200 }));
    const activateEnrollment = vi.fn(async () => {});
    const onPending = vi.fn();

    await expect(resumeBorgServerEnrollment(
      pending.origin,
      pending.trustIdentity,
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPendingEnrollment: vi.fn(async () => pending),
        activateEnrollment,
        onPending,
      },
    )).resolves.toMatchObject({ token: pending.credential });

    expect(onPending).toHaveBeenCalledOnce();
    expect(onPending.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[0],
    );
    const request = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(request.payload).toEqual({
      invitation: pending.invitation,
      retry_key: pending.retryKey,
      client_credential: pending.credential,
      client_name: pending.clientName,
    });
    expect(activateEnrollment).toHaveBeenCalledWith(expect.objectContaining({
      retryKey: pending.retryKey,
      credential: pending.credential,
    }));
  });

  it('creates a cube idempotently for an owner and rejects ordinary clients before network', async () => {
    const cubeRetry = {
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      clientId: '66666666-6666-4666-8666-666666666666',
      repositoryBinding: 'a'.repeat(64),
      retryKey: '77777777-7777-4777-8777-777777777777',
      name: 'project-one',
      template: 'default' as const,
    };
    const active = {
      origin: cubeRetry.origin,
      trustIdentity: cubeRetry.trustIdentity,
      credential: 'c'.repeat(43),
      clientId: cubeRetry.clientId,
      serverCapabilities: ['create_cube'] as const,
    };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'cube-retry-1',
        payload: {
          cube_id: CUBE_ID,
          human_seat_role_id: '88888888-8888-4888-8888-888888888888',
          default_worker_role_id: ROLE_ID,
          access: 'manage',
        },
      }), { status: 201 }));
    const clearCubeCreation = vi.fn(async () => {});

    await expect(createBorgServerCube(
      cubeRetry.origin,
      cubeRetry.trustIdentity,
      active.credential,
      { projectRoot: '/work/project-one', name: cubeRetry.name },
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadCredentialRecord: vi.fn(async () => ({
          ...active,
          serverCapabilities: [...active.serverCapabilities],
        })),
        prepareCubeCreation: vi.fn(async () => cubeRetry),
        clearCubeCreation,
      },
    )).resolves.toMatchObject({ cube_id: CUBE_ID, access: 'manage' });
    const first = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    const retry = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    expect(retry.payload).toEqual(first.payload);
    expect(retry.payload).toEqual({
      retry_key: cubeRetry.retryKey,
      name: cubeRetry.name,
      template: 'default',
    });
    expect(clearCubeCreation).toHaveBeenCalledWith(cubeRetry);

    const deniedFetch = vi.fn();
    await expect(createBorgServerCube(
      cubeRetry.origin,
      cubeRetry.trustIdentity,
      active.credential,
      { projectRoot: '/work/ordinary', name: 'ordinary' },
      {
        fetchImpl: deniedFetch as typeof fetch,
        loadCredentialRecord: vi.fn(async () => ({
          ...active,
          serverCapabilities: [],
        })),
      },
    )).rejects.toMatchObject({
      code: 'CREATE_CUBE_DENIED',
      message: expect.stringMatching(/not authorized to create cubes/i),
    });
    expect(deniedFetch).not.toHaveBeenCalled();
  });

  it('attaches with a persisted retry key and keychains the returned generation', async () => {
    const sessionToken = 's'.repeat(43);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '1',
      request_id: 'attach-response-1',
      payload: {
        cube: { id: CUBE_ID, name: 'local-cube' },
        role: { id: ROLE_ID, name: 'Builder', role_class: 'worker' },
        drone: { id: DRONE_ID, label: 'builder-1' },
        session: {
          token: sessionToken,
          expires_at: '2026-07-14T16:00:00.000Z',
          generation: 3,
        },
        reattached: false,
      },
    }), { status: 201 }));
    const storeSessionCredential = vi.fn(async () =>
      `borg-server-session:${'a'.repeat(64)}`
    );

    await expect(attachBorgServer(
      'https://server.example.com',
      'spki-sha256:server-a',
      'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, retryKey: RETRY_KEY },
      { fetchImpl: fetchImpl as typeof fetch, storeSessionCredential },
    )).resolves.toMatchObject({
      drone: { id: DRONE_ID },
      session: { generation: 3, credentialRef: expect.stringMatching(/^borg-server-session:/) },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://server.example.com/api/client/attach');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: `Bearer ${'p'.repeat(43)}` }),
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      protocol_version: '1',
      payload: {
        cube_id: CUBE_ID,
        role_id: ROLE_ID,
        retry_key: RETRY_KEY,
      },
    });
    expect(storeSessionCredential).toHaveBeenCalledWith({
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      generation: 3,
      credential: sessionToken,
      expiresAt: '2026-07-14T16:00:00.000Z',
    });
  });

  it('does not return attach metadata when the keychain write fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '1',
      request_id: 'attach-response-2',
      payload: {
        cube: { id: CUBE_ID, name: 'local-cube' },
        role: { id: ROLE_ID, name: 'Builder' },
        drone: { id: DRONE_ID, label: 'builder-1' },
        session: { token: 's'.repeat(43), expires_at: null, generation: 4 },
        reattached: true,
      },
    }), { status: 200 }));

    await expect(attachBorgServer(
      'https://server.example.com',
      'spki-sha256:server-a',
      'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, retryKey: RETRY_KEY },
      {
        fetchImpl: fetchImpl as typeof fetch,
        storeSessionCredential: vi.fn(async () => {
          throw new Error('keychain locked');
        }),
      },
    )).rejects.toThrow('keychain locked');
  });

  it('redacts retry keys and response bodies from attach failures', async () => {
    const reflected = `${RETRY_KEY} ${'s'.repeat(43)}`;
    const fetchImpl = vi.fn(async () => new Response(reflected, { status: 500 }));

    let error: unknown;
    try {
      await attachBorgServer(
        'https://server.example.com',
        'spki-sha256:server-a',
        'p'.repeat(43),
        { cubeId: CUBE_ID, roleId: ROLE_ID, retryKey: RETRY_KEY },
        { fetchImpl: fetchImpl as typeof fetch },
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe('Borg server attach failed (HTTP 500)');
    expect((error as Error).message).not.toContain(RETRY_KEY);
    expect((error as Error).message).not.toContain(reflected);
  });
});
