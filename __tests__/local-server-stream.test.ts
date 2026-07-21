import { afterEach, describe, expect, it, vi } from 'vitest';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RECIPIENT_ID = '55555555-5555-4555-8555-555555555555';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/session-continuity.js');
  vi.doUnmock('../src/stream-owner.js');
  vi.resetModules();
});

describe('local server SSE adapter', () => {
  it.each([
    ['missing active state', async () => null, false],
    ['keychain hydration failure', async () => { throw new Error('keychain locked'); }, true],
  ] as const)('does not reach OAuth or network after %s', async (_case, getActiveCube, rejects) => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const acquireStreamLease = vi.fn();
    const sleep = vi.fn(async () => {});
    const { __runLoopForTest } = await import('../src/log-stream.js');
    const run = __runLoopForTest({
      getActiveCube,
      acquireStreamLease,
      sleep,
      maxIterations: 1,
    });
    if (rejects) await expect(run).rejects.toThrow('keychain locked');
    else await expect(run).resolves.toBeUndefined();
    expect(acquireStreamLease).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('advances the local stream cursor without waking for a direct entry addressed elsewhere', async () => {
    const cursor = { id: LOG_ID, created_at: '2026-07-14T14:00:00.000Z' };
    const advanceCursor = vi.fn(async () => {});
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => cursor),
      encodeLocalServerCursor: vi.fn(() => 'encoded-cursor'),
      advanceLocalServerCursor: advanceCursor,
    }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => {
        throw new Error('injected stream transport should avoid trust-file IO');
      }),
    }));

    const wire = [
      'event: log',
      `id: ${LOG_ID}`,
      `data: ${JSON.stringify({
        cursor,
        entry: {
          id: LOG_ID,
          cube_id: CUBE_ID,
          drone_id: '44444444-4444-4444-8444-444444444444',
          message: 'local stream entry',
          visibility: 'direct',
          created_at: cursor.created_at,
          drone_label: 'peer-1',
          role_name: 'Builder',
          recipient_drone_ids: [OTHER_RECIPIENT_ID],
        },
      })}`,
      '',
      'event: bookmark',
      `data: ${JSON.stringify({ as_of: '2026-07-14T14:00:01.000Z', replay_complete: true })}`,
      '',
    ].join('\n');
    const fetchImpl = vi.fn(async () => new Response(wire, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const appendLine = vi.fn(async () => {});

    const { streamOnce } = await import('../src/log-stream.js');
    await streamOnce({
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      sessionToken: 's'.repeat(43),
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
    }, null, vi.fn(), {
      fetchImpl: fetchImpl as typeof fetch,
      appendLine,
      hasInboxEntryId: vi.fn(async () => false),
      abortSignal: new AbortController().signal,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://localhost:8787/api/cubes/${CUBE_ID}/stream?cursor=encoded-cursor`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${'s'.repeat(43)}` }),
      }),
    );
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.has('X-Drone-Session')).toBe(false);
    expect(appendLine).not.toHaveBeenCalled();
    expect(advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ cubeId: CUBE_ID, droneId: DRONE_ID }),
      cursor,
    );
  });

  it.each([
    ['direct entry addressed to the active drone', 'direct', [DRONE_ID]],
    ['broadcast entry', 'broadcast', []],
  ] as const)('writes and wakes for a local %s', async (_case, visibility, recipients) => {
    const cursor = { id: LOG_ID, created_at: '2026-07-14T14:00:00.000Z' };
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => null),
      encodeLocalServerCursor: vi.fn(),
      advanceLocalServerCursor: vi.fn(async () => {}),
    }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => {
        throw new Error('injected stream transport should avoid trust-file IO');
      }),
    }));
    const wire = [
      'event: log',
      `id: ${LOG_ID}`,
      `data: ${JSON.stringify({
        cursor,
        entry: {
          id: LOG_ID,
          cube_id: CUBE_ID,
          drone_id: OTHER_RECIPIENT_ID,
          message: 'wake intended recipient',
          visibility,
          created_at: cursor.created_at,
          recipient_drone_ids: recipients,
        },
      })}`,
      '',
    ].join('\n');
    const appendLine = vi.fn(async () => {});
    const { streamOnce } = await import('../src/log-stream.js');

    await streamOnce({
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      sessionToken: 's'.repeat(43),
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
    }, null, vi.fn(), {
      fetchImpl: vi.fn(async () => new Response(wire, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })) as typeof fetch,
      appendLine,
      hasInboxEntryId: vi.fn(async () => false),
      abortSignal: new AbortController().signal,
    });

    expect(appendLine).toHaveBeenCalledWith(
      CUBE_ID,
      DRONE_ID,
      expect.stringContaining('wake intended recipient'),
    );
  });

  it.each([
    ['complete frame', `event: bookmark\ndata: ${JSON.stringify({
      as_of: '2026-07-14T14:00:01.000Z',
      padding: 'x'.repeat(128),
    })}\n\n`],
    ['partial frame', `event: log\ndata: ${'x'.repeat(128)}`],
  ])('cancels an oversized %s', async (_case, wire) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
      },
      cancel,
    });
    const { parseSSE } = await import('../src/log-stream.js');
    const consume = async () => {
      for await (const _event of parseSSE(body, 64)) {
        // Consume until the parser rejects the oversized frame.
      }
    };

    await expect(consume()).rejects.toThrow(/SSE frame exceeded the response limit/i);
    expect(cancel).toHaveBeenCalled();
  });

  it('applies the frame cap to the local stream without changing Cloud defaults', async () => {
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async () => null),
      encodeLocalServerCursor: vi.fn(),
      advanceLocalServerCursor: vi.fn(async () => {}),
    }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => {
        throw new Error('injected stream transport should avoid trust-file IO');
      }),
    }));

    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `event: log\ndata: ${'x'.repeat(70 * 1024)}`,
        ));
      },
      cancel,
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const { streamOnce } = await import('../src/log-stream.js');

    await expect(streamOnce({
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      sessionToken: 's'.repeat(43),
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
    }, null, vi.fn(), {
      fetchImpl: fetchImpl as typeof fetch,
      appendLine: vi.fn(async () => {}),
      hasInboxEntryId: vi.fn(async () => false),
      abortSignal: new AbortController().signal,
    })).rejects.toThrow(/SSE frame exceeded the response limit/i);
    expect(cancel).toHaveBeenCalled();

    const cloudBody = new Response(
      `event: bookmark\ndata: ${JSON.stringify({
        as_of: '2026-07-14T14:00:01.000Z',
        padding: 'x'.repeat(70 * 1024),
      })}\n\n`,
    ).body!;
    const { parseSSE } = await import('../src/log-stream.js');
    const cloudEvents = [];
    for await (const event of parseSSE(cloudBody)) cloudEvents.push(event);
    expect(cloudEvents).toEqual([{
      type: 'bookmark',
      as_of: '2026-07-14T14:00:01.000Z',
    }]);
  });

  it('restores once on AUTH_EXPIRED and reconnects with the fresh same-seat bearer', async () => {
    const old = {
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      name: 'cube',
      droneLabel: 'builder-1',
      sessionToken: 'old-session',
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
      localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
      localSessionExpiresAt: '2026-07-21T00:00:00.000Z',
    };
    const fresh = { ...old, sessionToken: 'fresh-session', localSessionExpiresAt: '2026-07-22T00:00:00.000Z' };
    let current = old;
    const recoverExpiredSession = vi.fn(async () => {
      current = fresh;
      return fresh;
    });
    vi.doMock('../src/stream-owner.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/stream-owner.js')>(),
      readOwnershipSnapshot: vi.fn(async () => ({ state: 'owned', ownerPid: 1 })),
    }));
    const { BorgServerError } = await import('../src/server-errors.js');
    const streamOnce = vi.fn()
      .mockRejectedValueOnce(new BorgServerError('AUTH_EXPIRED', 'expired'))
      .mockResolvedValueOnce(undefined);
    const lease = { refresh: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const { __runLoopForTest } = await import('../src/log-stream.js');

    await __runLoopForTest({
      getActiveCube: vi.fn(async () => current),
      acquireStreamLease: vi.fn(async () => lease as any),
      streamOnce,
      recoverExpiredSession,
      sleep: vi.fn(async () => {}),
      maxIterations: 2,
    });

    expect(recoverExpiredSession).toHaveBeenCalledTimes(1);
    expect(streamOnce.mock.calls.map(([value]) => value.sessionToken))
      .toEqual(['old-session', 'fresh-session']);
  });

  it('keeps stale SESSION_REJECTED terminal and never starts a second restore cycle', async () => {
    const active = {
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      name: 'cube',
      droneLabel: 'builder-1',
      sessionToken: 'stale-session',
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: 'spki-sha256:test-server',
      localSessionCredentialRef: `borg-server-session:${'a'.repeat(64)}`,
      localSessionExpiresAt: '2026-07-21T00:00:00.000Z',
    };
    const recoverExpiredSession = vi.fn();
    vi.doMock('../src/stream-owner.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/stream-owner.js')>(),
      readOwnershipSnapshot: vi.fn(async () => ({ state: 'owned', ownerPid: 1 })),
    }));
    const { BorgServerError } = await import('../src/server-errors.js');
    const streamOnce = vi.fn(async () => { throw new BorgServerError('SESSION_REJECTED', 'stale'); });
    const lease = { refresh: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const { __runLoopForTest } = await import('../src/log-stream.js');

    await expect(__runLoopForTest({
      getActiveCube: vi.fn(async () => active),
      acquireStreamLease: vi.fn(async () => lease as any),
      streamOnce,
      recoverExpiredSession,
      sleep: vi.fn(async () => {}),
      maxIterations: 2,
    })).rejects.toMatchObject({ name: 'TerminalStreamError' });
    expect(recoverExpiredSession).not.toHaveBeenCalled();
    expect(streamOnce).toHaveBeenCalledTimes(1);
  });
});
