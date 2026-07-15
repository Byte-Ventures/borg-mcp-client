import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LOCAL_SERVER_ORIGIN,
  attachBorgServer,
  connectEnrolledBorgServer,
  enrollBorgServer,
  probeBorgServer,
  negotiateBorgServer,
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
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'enroll-request-1',
        payload: {
          client_id: 'client-12345678',
          credential,
          credential_expires_at: null,
        },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocol_version: '1',
        request_id: 'protocol-request-1',
        payload: protocolInfo,
      }), { status: 200 }));
    const storeCredential = vi.fn(async () => {});

    await expect(enrollBorgServer(
      'https://server.example.com',
      'sha256:server-a',
      invitation,
      { fetchImpl: fetchImpl as typeof fetch, storeCredential, clientName: 'operator-laptop' },
    )).resolves.toMatchObject({
      token: credential,
      clientId: 'client-12345678',
      credentialExpiresAt: null,
    });

    const [enrollmentUrl, enrollmentInit] = fetchImpl.mock.calls[0];
    expect(enrollmentUrl).toBe('https://server.example.com/api/enrollment/exchange');
    expect(enrollmentInit).toMatchObject({ method: 'POST', redirect: 'error' });
    const body = JSON.parse(String(enrollmentInit?.body));
    expect(body).toMatchObject({
      protocol_version: '1',
      payload: { invitation, client_name: 'operator-laptop' },
    });
    expect(String(enrollmentUrl)).not.toContain(invitation);
    expect(storeCredential).toHaveBeenCalledWith({
      origin: 'https://server.example.com',
      trustIdentity: 'sha256:server-a',
      credential,
    });
    expect(storeCredential.mock.invocationCallOrder[0]).toBeGreaterThan(
      fetchImpl.mock.invocationCallOrder[1],
    );
  });

  it('classifies a rejected invitation without reading or storing the response body', async () => {
    const reflectedInvitation = 'i'.repeat(43);
    const fetchImpl = vi.fn(async () => new Response(
      `reflected ${reflectedInvitation}`,
      { status: 401 },
    ));
    const storeCredential = vi.fn(async () => {});

    let error: unknown;
    try {
      await enrollBorgServer(
        'https://server.example.com',
        'sha256:server-a',
        reflectedInvitation,
        { fetchImpl: fetchImpl as typeof fetch, storeCredential },
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVITATION_REJECTED' });
    expect((error as Error).message).not.toContain(reflectedInvitation);
    expect(storeCredential).not.toHaveBeenCalled();
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
