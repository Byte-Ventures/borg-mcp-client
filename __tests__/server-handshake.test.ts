import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LOCAL_SERVER_ORIGIN,
  attachBorgServer,
  connectEnrolledBorgServer,
  createBorgServerCube,
  enrollBorgServer,
  probeBorgServer,
  preflightBorgServerTag,
  resumeBorgServerEnrollment,
} from '../src/server-handshake.js';
import { serverSessionCredentialRef } from '../src/config.js';
import type { PendingServerSessionRecord, ServerSessionOperation } from '../src/config.js';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '99999999-9999-4999-8999-999999999999';

const OPERATION: ServerSessionOperation = {
  projectRoot: '/work/project-one',
  kind: 'seat',
  operationKey: 'current-worktree',
};

const SEAT_INPUT = {
  origin: 'https://server.example.com',
  trustIdentity: 'spki-sha256:server-a',
  cubeId: CUBE_ID,
  roleId: ROLE_ID,
  operation: OPERATION,
};
const digestOf = (bearer: string) => createHash('sha256').update(bearer).digest('hex');

// The credential-free protocol preflight returns ONLY the exact tag.
const tagPreflightBody = () =>
  new Response(JSON.stringify({ protocol_version: '2' }), { status: 200 });

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

  it('preflights the protocol tag credential-free (no Authorization) and decodes only the tag', async () => {
    const fetchImpl = vi.fn(async () => tagPreflightBody());

    await expect(preflightBorgServerTag(
      'https://server.example.com',
      fetchImpl as typeof fetch,
    )).resolves.toEqual({ protocol_version: '2' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://server.example.com/api/protocol');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    // Credential-free: no bearer/cookie/authorization leaves the client.
    expect(init?.headers).not.toHaveProperty('Authorization');
  });

  it('fails closed on a mismatched tag or any extra field before attach', async () => {
    const wrongTag = vi.fn(async () => new Response(JSON.stringify({ protocol_version: '1' }), { status: 200 }));
    await expect(preflightBorgServerTag('https://server.example.com', wrongTag as typeof fetch))
      .rejects.toThrow(/Unsupported protocol version\.?/);

    const extraField = vi.fn(async () => new Response(
      JSON.stringify({ protocol_version: '2', package: { name: 'borgmcp-shared' } }),
      { status: 200 },
    ));
    await expect(preflightBorgServerTag('https://server.example.com', extraField as typeof fetch))
      .rejects.toThrow(/Unknown field "package"/);
  });

  it('does not follow redirects or expose the response body on a preflight failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('server fingerprint leaked in diagnostic', { status: 401 }));

    await expect(preflightBorgServerTag('https://server.example.com', fetchImpl as typeof fetch))
      .rejects.toThrow('Borg server protocol preflight failed (HTTP 401)');
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'error' }));
  });

  it('rejects an oversized protocol preflight body before decoding', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(65_537), { status: 200 }));

    await expect(preflightBorgServerTag('https://server.example.com', fetchImpl as typeof fetch))
      .rejects.toThrow(/response limit/i);
  });

  it('loads only the credential bound to the verified server identity', async () => {
    const loadCredential = vi.fn(async () => 'c'.repeat(43));
    const fetchImpl = vi.fn(async () => tagPreflightBody());

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

  it('preflights the tag FIRST, then enrolls through a versioned body and stores the bound credential', async () => {
    const invitation = 'i'.repeat(43);
    const credential = 'c'.repeat(43);
    const retryKey = '55555555-5555-4555-8555-555555555555';
    const clientId = '66666666-6666-4666-8666-666666666666';
    // CR fb4d6eba: the credential-free preflight is the FIRST call; the
    // enrollment POST is the second, only after the exact-tag preflight passes.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tagPreflightBody())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '2',
        request_id: 'enroll-request-1',
        payload: {
          purpose: 'owner',
          client_id: clientId,
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }));
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

    // Call 0 is the credential-free preflight.
    const [protocolUrl, protocolInit] = fetchImpl.mock.calls[0];
    expect(protocolUrl).toBe('https://server.example.com/api/protocol');
    expect(protocolInit).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(protocolInit?.headers).not.toHaveProperty('Authorization');
    // Call 1 is the enrollment POST.
    const [enrollmentUrl, enrollmentInit] = fetchImpl.mock.calls[1];
    expect(enrollmentUrl).toBe('https://server.example.com/api/enrollment/exchange');
    expect(enrollmentInit).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = JSON.parse(String(enrollmentInit?.body));
    expect(body).toMatchObject({
      protocol_version: '2',
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
    // The preflight runs before the pending credential is prepared/persisted,
    // which in turn runs before the enrollment POST; activation is last.
    expect(fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(
      prepareEnrollment.mock.invocationCallOrder[0],
    );
    expect(prepareEnrollment.mock.invocationCallOrder[0]).toBeLessThan(
      fetchImpl.mock.invocationCallOrder[1],
    );
    expect(activateEnrollment.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchImpl.mock.invocationCallOrder[1],
    );
  });

  it('rejects an incompatible server at the preflight before any credential prepare, POST, or activation (first enrollment)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ protocol_version: '1' }), { status: 200 }));
    const prepareEnrollment = vi.fn();
    const activateEnrollment = vi.fn();
    const clearPendingEnrollment = vi.fn();

    await expect(enrollBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      'i'.repeat(43),
      {
        fetchImpl: fetchImpl as typeof fetch,
        prepareEnrollment: prepareEnrollment as never,
        activateEnrollment,
        clearPendingEnrollment,
      },
    )).rejects.toThrow();

    // Exactly one request — the preflight — and no credential/secret work.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://server.example.com/api/protocol');
    expect(prepareEnrollment).not.toHaveBeenCalled();
    expect(activateEnrollment).not.toHaveBeenCalled();
    expect(clearPendingEnrollment).not.toHaveBeenCalled();
  });

  it('rejects an incompatible server at the preflight on resume, with zero POST/activation', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ protocol_version: '1' }), { status: 200 }));
    const loadPendingEnrollment = vi.fn(async () => ({
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      invitation: 'i'.repeat(43),
      retryKey: '55555555-5555-4555-8555-555555555555',
      credential: 'c'.repeat(43),
      clientName: 'operator-laptop',
    }));
    const activateEnrollment = vi.fn();

    await expect(resumeBorgServerEnrollment(
      'https://server.example.com',
      'sha256:server-a',
      {
        fetchImpl: fetchImpl as typeof fetch,
        loadPendingEnrollment,
        activateEnrollment,
      },
    )).rejects.toThrow();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://server.example.com/api/protocol');
    expect(activateEnrollment).not.toHaveBeenCalled();
  });

  it('does not send an invitation when the pending keychain write fails', async () => {
    // The credential-free preflight is the only permitted request; when the
    // pending keychain write then fails, no invitation-bearing POST is sent.
    const invitation = 'i'.repeat(43);
    const fetchImpl = vi.fn(async () => tagPreflightBody());
    await expect(enrollBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      invitation,
      {
        fetchImpl: fetchImpl as typeof fetch,
        prepareEnrollment: vi.fn(async () => {
          throw new Error('keychain locked');
        }),
      },
    )).rejects.toThrow('keychain locked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://server.example.com/api/protocol');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(String((init as RequestInit | undefined)?.body ?? '')).not.toContain(invitation);
    }
  });

  it('classifies a rejected invitation without reading or storing the response body', async () => {
    const reflectedInvitation = 'i'.repeat(43);
    // Preflight succeeds first; the enrollment POST is then rejected 401.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tagPreflightBody())
      .mockResolvedValueOnce(new Response(
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
    // Preflight is call 0; the ambiguous enrollment POST is retried at calls 1-2.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tagPreflightBody())
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '2',
        request_id: 'enroll-retry-1',
        payload: {
          purpose: 'owner',
          client_id: '66666666-6666-4666-8666-666666666666',
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }));
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

    expect(fetchImpl.mock.calls[0][0]).toBe('https://server.example.com/api/protocol');
    const first = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
    const retry = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body));
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
    // Preflight is call 0 (credential-free GET); the enrollment POST is call 1.
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(tagPreflightBody())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '2',
        request_id: 'enroll-resume-1',
        payload: {
          purpose: 'owner',
          client_id: '66666666-6666-4666-8666-666666666666',
          server_capabilities: ['create_cube'],
        },
      }), { status: 201 }));
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
    expect(fetchImpl.mock.calls[0][0]).toBe('https://server.example.com/api/protocol');
    const request = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body));
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
        protocol_version: '2',
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

  it('attaches with the client-generated pending bearer and activates it in place', async () => {
    const bearer = 's'.repeat(43);
    const expiresAt = '2026-07-14T16:00:00.000Z';
    const credentialRef = `borg-server-session:${'a'.repeat(64)}`;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '2',
      request_id: 'attach-response-1',
      payload: {
        result: 'created',
        cube: { id: CUBE_ID, name: 'local-cube' },
        role: { id: ROLE_ID, name: 'Builder', role_class: 'worker' },
        drone: { id: DRONE_ID, label: 'builder-1' },
        session: { id: SESSION_ID, expires_at: expiresAt },
      },
    }), { status: 201 }));
    const pendingRecord: PendingServerSessionRecord = {
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
      credential: bearer,
      state: 'pending',
    };
    const getPendingSession = vi.fn(async () => pendingRecord);
    // CR #2: the composite activate is an atomic compare-and-activate returning a
    // typed outcome, not a bare ref. The deterministic ref comes from the seat.
    const activateSession = vi.fn(async () => 'activated' as const);
    const expectedRef = serverSessionCredentialRef(SEAT_INPUT);

    await expect(attachBorgServer(
      'https://server.example.com',
      'spki-sha256:server-a',
      'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: OPERATION },
      { fetchImpl: fetchImpl as typeof fetch, getPendingSession, activateSession },
    )).resolves.toMatchObject({
      result: 'created',
      drone: { id: DRONE_ID },
      session: { credentialRef: expectedRef, sessionId: SESSION_ID, expiresAt },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://server.example.com/api/client/attach');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: expect.objectContaining({ Authorization: `Bearer ${'p'.repeat(43)}` }),
    });
    // The client's own pending bearer is the session credential; the parent
    // enrollment credential is only the Authorization bearer.
    expect(JSON.parse(String(init?.body))).toMatchObject({
      protocol_version: '2',
      payload: {
        cube_id: CUBE_ID,
        role_id: ROLE_ID,
        session_credential: bearer,
      },
    });
    expect(getPendingSession).toHaveBeenCalledWith({
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
    });
    expect(activateSession).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
      droneId: DRONE_ID,
      sessionId: SESSION_ID,
      expiresAt,
      // CR #2: the EXACT bearer we sent is pinned by digest so a same-ref
      // replacement cannot be activated with this response's server metadata.
      expectedPendingDigest: digestOf(bearer),
    }));
  });

  it('CR #2: never binds server metadata onto a same-ref replacement — a `replaced`/`missing` activate aborts the attach', async () => {
    const fetchImpl = (result: 'created' | 'reused' = 'created') => vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '2',
      request_id: 'attach-r',
      payload: {
        result,
        cube: { id: CUBE_ID, name: 'local-cube' },
        role: { id: ROLE_ID, name: 'Builder' },
        drone: { id: DRONE_ID, label: 'builder-1' },
        session: { id: SESSION_ID, expires_at: '2026-07-20T00:00:00.000Z' },
      },
    }), { status: 201 }));
    const pendingRecord: PendingServerSessionRecord = {
      ...SEAT_INPUT, credential: 's'.repeat(43), state: 'pending',
    };
    const attachWith = (outcome: 'replaced' | 'missing') => attachBorgServer(
      'https://server.example.com', 'spki-sha256:server-a', 'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: OPERATION },
      {
        fetchImpl: fetchImpl() as typeof fetch,
        getPendingSession: vi.fn(async () => pendingRecord),
        activateSession: vi.fn(async () => outcome),
      },
    );
    await expect(attachWith('replaced')).rejects.toThrow(/replaced.*no server metadata was bound/i);
    await expect(attachWith('missing')).rejects.toThrow(/missing.*no server metadata was bound/i);
  });

  it('does not return attach metadata when the keychain activation fails', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '2',
      request_id: 'attach-response-2',
      payload: {
        result: 'reused',
        cube: { id: CUBE_ID, name: 'local-cube' },
        role: { id: ROLE_ID, name: 'Builder' },
        drone: { id: DRONE_ID, label: 'builder-1' },
        session: { id: SESSION_ID, expires_at: '2026-07-14T16:00:00.000Z' },
      },
    }), { status: 200 }));
    const pendingRecord: PendingServerSessionRecord = {
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
      credential: 's'.repeat(43),
      state: 'pending',
    };

    await expect(attachBorgServer(
      'https://server.example.com',
      'spki-sha256:server-a',
      'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: OPERATION },
      {
        fetchImpl: fetchImpl as typeof fetch,
        getPendingSession: vi.fn(async () => pendingRecord),
        activateSession: vi.fn(async () => {
          throw new Error('keychain locked');
        }),
      },
    )).rejects.toThrow('keychain locked');
  });

  it('redacts the session bearer and response body from attach failures', async () => {
    const bearer = 's'.repeat(43);
    const reflected = `${bearer} leaked`;
    const fetchImpl = vi.fn(async () => new Response(reflected, { status: 500 }));
    const pendingRecord: PendingServerSessionRecord = {
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
      credential: bearer,
      state: 'pending',
    };

    let error: unknown;
    try {
      await attachBorgServer(
        'https://server.example.com',
        'spki-sha256:server-a',
        'p'.repeat(43),
        { cubeId: CUBE_ID, roleId: ROLE_ID, operation: OPERATION },
        {
          fetchImpl: fetchImpl as typeof fetch,
          getPendingSession: vi.fn(async () => pendingRecord),
        },
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toBe('Borg server attach failed (HTTP 500)');
    expect((error as Error).message).not.toContain(bearer);
    expect((error as Error).message).not.toContain(reflected);
  });

  it('classifies a typed SESSION_REJECTED takeover distinctly from a credential rejection', async () => {
    const pendingRecord: PendingServerSessionRecord = {
      origin: 'https://server.example.com',
      trustIdentity: 'spki-sha256:server-a',
      cubeId: CUBE_ID,
      roleId: ROLE_ID,
      operation: OPERATION,
      credential: 's'.repeat(43),
      state: 'pending',
    };
    const rejectedWith = (code: string) => vi.fn(async () => new Response(JSON.stringify({
      protocol_version: '2',
      error: { code, message: 'rejected' },
    }), { status: 401 }));
    const attach = (fetchImpl: typeof fetch) => attachBorgServer(
      'https://server.example.com',
      'spki-sha256:server-a',
      'p'.repeat(43),
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: OPERATION },
      { fetchImpl, getPendingSession: vi.fn(async () => pendingRecord) },
    );

    // A typed takeover rejection surfaces its own code...
    await expect(attach(rejectedWith('SESSION_REJECTED') as typeof fetch))
      .rejects.toMatchObject({ code: 'SESSION_REJECTED' });
    // ...while any other 401 falls back to the generic credential rejection.
    await expect(attach(rejectedWith('AUTH_INVALID') as typeof fetch))
      .rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });
});
