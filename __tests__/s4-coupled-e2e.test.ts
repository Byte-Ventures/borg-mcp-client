import crypto, { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net, { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// RQ invocation contract: before enabling this test, verify the clean client
// worktree externally with:
//   test "$(git rev-parse HEAD)" = "$BORG_E2E_CLIENT_SHA" && git diff --quiet
// RQ owns the isolated server, CA, cube, reader seat, and two writer credentials.
// Ordinary `npm test` runs only the input-validation cases and skips the E2E.
const EXPECTED_CLIENT_SHA = '710e9a90446de07a819291307f6d75f9a21784aa';
const enabled = process.env.BORG_S4_COUPLED_E2E === '1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Cursor {
  id: string;
  created_at: string;
}

interface ActiveCube {
  cubeId: string;
  droneId: string;
  name: string;
  droneLabel: string;
  sessionToken: string;
  apiUrl: string;
  serverTrustIdentity: string;
}

interface WriterRef {
  endpoint: string;
  trust_identity: string;
  cube_id: string;
  drone_id: string;
  session_credential: string;
  role_id?: string;
  session_id?: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackOrigin(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(hostname);
  const loopback = family === 4 ? hostname.startsWith('127.') : family === 6 && hostname === '::1';
  if (parsed.protocol !== 'https:' || parsed.origin !== value || !loopback) {
    throw new Error('BORG_API_URL must be a canonical numeric loopback HTTPS origin');
  }
  return parsed.origin;
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${field} must be a canonical UUID`);
  }
  return value;
}

function decodeWriterRefs(value: unknown, active: ActiveCube): WriterRef[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('BORG_E2E_WRITER_REFS must contain at least two writer refs');
  }
  const refs = value.map((candidate, index): WriterRef => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`writer ref ${index} must be an object`);
    }
    const ref = candidate as Record<string, unknown>;
    const endpoint = loopbackOrigin(String(ref.endpoint ?? ''));
    if (endpoint !== active.apiUrl || ref.trust_identity !== active.serverTrustIdentity) {
      throw new Error(`writer ref ${index} endpoint/trust does not match the reader active seat`);
    }
    const cubeId = canonicalUuid(ref.cube_id, `writer ref ${index}.cube_id`);
    if (cubeId !== active.cubeId) {
      throw new Error(`writer ref ${index} cube_id does not match BORG_E2E_CUBE_ID`);
    }
    const droneId = canonicalUuid(ref.drone_id, `writer ref ${index}.drone_id`);
    if (droneId === active.droneId) {
      throw new Error(`writer ref ${index} is cross-wired to the reader drone_id`);
    }
    if (typeof ref.session_credential !== 'string' || ref.session_credential.length < 43) {
      throw new Error(`writer ref ${index}.session_credential is missing or invalid`);
    }
    if (ref.session_credential === active.sessionToken) {
      throw new Error(`writer ref ${index} is cross-wired to the reader session credential`);
    }
    if (ref.role_id !== undefined) canonicalUuid(ref.role_id, `writer ref ${index}.role_id`);
    if (ref.session_id !== undefined) canonicalUuid(ref.session_id, `writer ref ${index}.session_id`);
    return {
      endpoint,
      trust_identity: active.serverTrustIdentity,
      cube_id: cubeId,
      drone_id: droneId,
      session_credential: ref.session_credential,
      ...(typeof ref.role_id === 'string' ? { role_id: ref.role_id } : {}),
      ...(typeof ref.session_id === 'string' ? { session_id: ref.session_id } : {}),
    };
  });
  if (new Set(refs.map((ref) => ref.drone_id)).size !== refs.length ||
    new Set(refs.map((ref) => ref.session_credential)).size !== refs.length) {
    throw new Error('writer refs must have distinct server-attributed drone_id and session_credential values');
  }
  return refs;
}

function trackInnerReaderRelease(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('instrumented app-server response exceeded 65535 bytes');
}

async function fetchWithBodyLifetime(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  let settled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort(init.signal?.reason);
  const finalize = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
    reader?.releaseLock();
  };
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (!response.body) {
      finalize();
      return response;
    }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finalize();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (error) {
          finalize();
          streamController.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finalize();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finalize();
    throw error;
  }
}

function decodeFrame(buffer: Buffer): { value: any; consumed: number } | null {
  if (buffer.length < 6) return null;
  const lengthCode = buffer[1] & 0x7f;
  let offset = 2;
  let length = lengthCode;
  if (lengthCode === 126) {
    if (buffer.length < 8) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (lengthCode === 127) {
    if (buffer.length < 14) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if ((buffer[1] & 0x80) === 0) throw new Error('expected masked app-server client frame');
  const consumed = offset + 4 + length;
  if (buffer.length < consumed) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[offset + 4 + index] ^ mask[index % 4];
  }
  return { value: JSON.parse(payload.toString('utf8')), consumed };
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/cubes.js');
  vi.doUnmock('../src/server-trust.js');
  vi.doUnmock('../src/local-server-cursor.js');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Sprint 4 E2E harness validation', () => {
  it('accepts canonical numeric IPv4 and IPv6 loopback origins', () => {
    expect(loopbackOrigin('https://127.0.0.1:7443')).toBe('https://127.0.0.1:7443');
    expect(loopbackOrigin('https://[::1]:7443')).toBe('https://[::1]:7443');
  });

  it.each([
    'https://localhost:7443',
    'https://192.0.2.1:7443',
    'http://127.0.0.1:7443',
    'https://127.0.0.1:7443/path',
  ])('rejects non-numeric, non-loopback, non-TLS, or non-origin input %s', (value) => {
    expect(() => loopbackOrigin(value)).toThrow(/numeric loopback HTTPS origin/);
  });

  it('accepts only canonical authenticated writer UUIDs', () => {
    expect(UUID_RE.test('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('writer-1')).toBe(false);
    expect(UUID_RE.test('11111111-1111-4111-7111-111111111111')).toBe(false);
  });

  it.each([
    ['cube mismatch', { cube_id: '22222222-2222-4222-8222-222222222222' }, /cube_id/],
    ['malformed UUID', { drone_id: 'writer-1' }, /drone_id/],
    ['missing session', { session_credential: undefined }, /session_credential/],
    ['reader cross-wire', { drone_id: '11111111-1111-4111-8111-111111111111' }, /cross-wired/],
    ['endpoint mismatch', { endpoint: 'https://127.0.0.1:7444' }, /endpoint\/trust/],
  ])('rejects writer ref %s before any append', (_case, patch, message) => {
    const active: ActiveCube = {
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: '11111111-1111-4111-8111-111111111111',
      name: 'cube',
      droneLabel: 'reader',
      sessionToken: 'r'.repeat(43),
      apiUrl: 'https://127.0.0.1:7443',
      serverTrustIdentity: 'spki-sha256:test',
    };
    const writer = (drone: string, credential: string) => ({
      endpoint: active.apiUrl,
      trust_identity: active.serverTrustIdentity,
      cube_id: active.cubeId,
      drone_id: drone,
      session_credential: credential,
    });
    expect(() => decodeWriterRefs([
      { ...writer('22222222-2222-4222-8222-222222222222', 'a'.repeat(43)), ...patch },
      writer('33333333-3333-4333-8333-333333333333', 'b'.repeat(43)),
    ], active)).toThrow(message);
  });

  it('rejects duplicate writer identity and credential before any append', () => {
    const active: ActiveCube = {
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: '11111111-1111-4111-8111-111111111111',
      name: 'cube',
      droneLabel: 'reader',
      sessionToken: 'r'.repeat(43),
      apiUrl: 'https://127.0.0.1:7443',
      serverTrustIdentity: 'spki-sha256:test',
    };
    const writer = {
      endpoint: active.apiUrl,
      trust_identity: active.serverTrustIdentity,
      cube_id: active.cubeId,
      drone_id: '22222222-2222-4222-8222-222222222222',
      session_credential: 'a'.repeat(43),
    };
    expect(() => decodeWriterRefs([writer, writer], active)).toThrow(/distinct/);
  });

  it.each(['eof', 'error'] as const)('releases the upstream abort bridge when the response body reaches %s', async (outcome) => {
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        if (outcome === 'eof') controller.close();
        else controller.error(new Error('stalled transport failed'));
      },
    });
    const sourceResponse = new Response(source);
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async () => sourceResponse),
      'https://127.0.0.1:7443/stream',
      { signal },
    );
    const reader = response.body!.getReader();
    if (outcome === 'eof') await expect(reader.read()).resolves.toMatchObject({ done: true });
    else await expect(reader.read()).rejects.toThrow('stalled transport failed');
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await reader.cancel().catch(() => {});
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('releases the upstream abort bridge when the response body is cancelled', async () => {
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal;
    let sourceCancelled = 0;
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      cancel() { sourceCancelled += 1; },
    }));
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async () => sourceResponse),
      'https://127.0.0.1:7443/stream',
      { signal },
    );
    await response.body!.cancel(new Error('consumer stopped'));
    expect(sourceCancelled).toBe(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('keeps the upstream abort bridge until a stalled response body is cancelled', async () => {
    const upstream = new AbortController();
    const removeEventListener = vi.spyOn(upstream.signal, 'removeEventListener');
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let transportAborted = false;
    let sourceResponse!: Response;
    let releaseLock!: ReturnType<typeof vi.spyOn>;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      init!.signal!.addEventListener('abort', () => {
        transportAborted = true;
        sourceController.error(init!.signal!.reason);
      }, { once: true });
      sourceResponse = new Response(new ReadableStream<Uint8Array>({
        start(controller) { sourceController = controller; },
      }));
      releaseLock = trackInnerReaderRelease();
      return sourceResponse;
    });
    const response = await fetchWithBodyLifetime(fetchImpl, 'https://127.0.0.1:7443/stream', {
      signal: upstream.signal,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    upstream.abort(new Error('external stream shutdown'));
    await expect(pending).rejects.toThrow('external stream shutdown');
    expect(transportAborted).toBe(true);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(enabled)('Sprint 4 joined client/server E2E', () => {
  it('proves idle=0, directed=1, exact 150 drain, transport health, and zero egress', async () => {
    expect(required('BORG_E2E_CLIENT_SHA')).toBe(EXPECTED_CLIENT_SHA);
    const origin = loopbackOrigin(required('BORG_API_URL'));
    const caPath = path.resolve(required('BORG_E2E_CA_PATH'));
    const trustIdentity = required('BORG_E2E_TRUST_IDENTITY');

    const active: ActiveCube = {
      cubeId: canonicalUuid(required('BORG_E2E_CUBE_ID'), 'BORG_E2E_CUBE_ID'),
      droneId: canonicalUuid(required('BORG_E2E_READER_DRONE_ID'), 'BORG_E2E_READER_DRONE_ID'),
      name: 's4-coupled-e2e',
      droneLabel: 's4-reader',
      sessionToken: required('BORG_E2E_READER_TOKEN'),
      apiUrl: origin,
      serverTrustIdentity: trustIdentity,
    };
    const writerRefs = decodeWriterRefs(
      JSON.parse(required('BORG_E2E_WRITER_REFS')) as unknown,
      active,
    );
    const runtimeDir = await mkdtemp(path.join(tmpdir(), 'borg-client-s4-coupled-'));
    const socketPath = path.join(runtimeDir, 'instrumented-app-server.sock');
    const sockets = new Set<net.Socket>();
    const cursorState = new Map<string, Cursor>();
    const statuses = new Map<number, number>();
    const requestUrls: string[] = [];
    const transportErrors: Array<{ code: string | null; message: string }> = [];
    const turnErrors: string[] = [];
    const methods: string[] = [];
    let forbiddenFetchAttempts = 0;
    let acceptedTurns = 0;
    let streamAbort: AbortController | undefined;
    let streamPromise: Promise<void> | undefined;

    const cursorKey = (binding: { purpose?: string }) => binding.purpose ?? 'unread';
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async (binding: { purpose?: string }) => cursorState.get(cursorKey(binding)) ?? null),
      advanceLocalServerCursor: vi.fn(async (binding: { purpose?: string }, cursor: Cursor) => {
        const key = cursorKey(binding);
        const prior = cursorState.get(key);
        if (!prior || prior.created_at < cursor.created_at ||
          (prior.created_at === cursor.created_at && prior.id < cursor.id)) {
          cursorState.set(key, cursor);
        }
      }),
      clearLocalServerCursor: vi.fn(async (binding: { purpose?: string }) => {
        cursorState.delete(cursorKey(binding));
      }),
      encodeLocalServerCursor: (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    }));
    vi.doMock('../src/cubes.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/cubes.js')>(),
      getActiveCube: vi.fn(async () => active),
    }));

    const actualTrust = await vi.importActual<typeof import('../src/server-trust.js')>('../src/server-trust.js');
    const pinnedFetch = actualTrust.createPinnedServerFetch(origin, readFileSync(caPath, 'utf8'));
    const recordingFetch: typeof fetch = async (input, init = {}) => {
      const url = new URL(input.toString());
      if (url.origin !== origin || loopbackOrigin(url.origin) !== origin) {
        throw new Error(`cross-authority request refused: ${url.href}`);
      }
      requestUrls.push(url.href);
      try {
        const response = await fetchWithBodyLifetime(pinnedFetch, input, init);
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        return response;
      } catch (error: any) {
        transportErrors.push({
          code: error?.code ?? error?.cause?.code ?? null,
          message: error?.message ?? String(error),
        });
        throw error;
      }
    };
    vi.doMock('../src/server-trust.js', () => ({
      ...actualTrust,
      loadBorgServerTrust: vi.fn(async () => ({ identity: trustIdentity, fetchImpl: recordingFetch })),
    }));
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      forbiddenFetchAttempts += 1;
      throw new Error(`untrusted fetch forbidden: ${String(input)}`);
    }));

    const appServer = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', (error) => turnErrors.push(`app-server socket: ${error.message}`));
      let buffer = Buffer.alloc(0);
      let handshaken = false;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshaken) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const headers = buffer.subarray(0, end).toString('utf8');
          const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/mi)?.[1]?.trim();
          if (!key) return socket.destroy(new Error('missing websocket key'));
          const accept = crypto.createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
          socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'));
          buffer = buffer.subarray(end + 4);
          handshaken = true;
        }
        for (;;) {
          const decoded = decodeFrame(buffer);
          if (!decoded) return;
          buffer = buffer.subarray(decoded.consumed);
          const request = decoded.value;
          if (typeof request.method === 'string') methods.push(request.method);
          if (typeof request.id !== 'number') continue;
          let result: any = {};
          if (request.method === 'thread/read') {
            result = { thread: {
              id: 's4-thread',
              cwd: process.cwd(),
              preview: 's4 coupled fixture',
              status: { type: 'idle' },
              updatedAt: Date.now(),
            } };
          } else if (request.method === 'turn/start') {
            const input = request.params?.input;
            const text = Array.isArray(input) ? input[0]?.text : null;
            if (
              request.params?.threadId !== 's4-thread' ||
              input?.length !== 1 ||
              input[0]?.type !== 'text' ||
              typeof text !== 'string' ||
              !text.startsWith('New Borg cube-log activity arrived:') ||
              !text.includes('s4-directed-')
            ) {
              turnErrors.push('invalid turn/start thread or prompt');
              socket.write(frame({ id: request.id, error: { message: 'invalid instrumented turn' } }));
              continue;
            }
            acceptedTurns += 1;
          }
          socket.write(frame({ id: request.id, result }));
        }
      });
    });

    let result: Record<string, unknown> | undefined;
    let operationError: unknown;
    try {
      await bounded(new Promise<void>((resolve, reject) => {
        appServer.once('error', reject);
        appServer.listen(socketPath, resolve);
      }), 'app-server listen');

      const remote = await import('../src/remote-client.js');
      const stream = await import('../src/log-stream.js');
      const wake = await import('../src/codex-app-wake.js');
      const wakeDeps = {
        getActiveCube: async () => active,
        getCodexWakeTarget: async () => ({ socketPath, threadId: 's4-thread' }),
        isStreamOwner: () => true,
      };

      const drainUnread = async (limit: number) => {
        const entries: any[] = [];
        let pages = 0;
        for (;;) {
          const page = await remote.readLog(active.sessionToken, origin, {
            unreadOnly: true,
            limit,
            serverTrustIdentity: trustIdentity,
          });
          pages += 1;
          entries.push(...page.entries);
          if (!page.has_more) return { entries, pages };
        }
      };
      await drainUnread(500);
      const unreadBaseline = cursorState.get('unread');
      if (unreadBaseline) cursorState.set('stream', unreadBaseline);

      wake.resetCodexWakeForTests();
      await wake.fireCodexHeartbeatTick({
        ...wakeDeps,
        hasPendingWork: async () => remote.hasPendingWakeActivity(active),
        now: () => wake.CODEX_HEARTBEAT_CADENCE_MS,
      });
      await wake.fireCodexHeartbeatTick({
        ...wakeDeps,
        hasPendingWork: async () => remote.hasPendingWakeActivity(active),
        now: () => 2 * wake.CODEX_HEARTBEAT_CADENCE_MS,
      });
      const idleTurns = acceptedTurns;

      let streamReadyResolve!: () => void;
      const streamReady = new Promise<void>((resolve) => { streamReadyResolve = resolve; });
      const streamFetch: typeof fetch = async (input, init) => {
        const response = await recordingFetch(input, init);
        streamReadyResolve();
        return response;
      };
      streamAbort = new AbortController();
      streamPromise = stream.streamOnce(active, null, () => {}, {
        fetchImpl: streamFetch,
        appendLine: async () => {},
        hasInboxEntryId: async () => false,
        injectOpenCode: async () => false,
        wakeCodex: (reason) => wake.wakeCodexViaAppServer(
          reason,
          { BORG_CODEX_REMOTE_WAKE: '1' },
          wakeDeps,
        ),
        abortSignal: streamAbort.signal,
      });
      await bounded(Promise.race([
        streamReady,
        streamPromise.then(() => { throw new Error('stream ended before ready'); }),
      ]), 'stream readiness');

      const append = async (token: string, message: string, direct = false) => {
        const response = await recordingFetch(`${origin}/api/cubes/${active.cubeId}/logs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            protocol_version: '2',
            request_id: randomUUID(),
            payload: {
              message,
              visibility: direct ? 'direct' : 'broadcast',
              recipientDroneIds: direct ? [active.droneId] : [],
            },
          }),
          redirect: 'error',
        });
        const body = await response.json() as any;
        if (!response.ok) throw new Error(`append HTTP ${response.status}: ${body?.error?.code ?? 'unknown'}`);
        return body.payload.entry;
      };

      const directed = await append(writerRefs[0].session_credential, `s4-directed-${randomUUID()}`, true);
      await bounded((async () => {
        while (acceptedTurns < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      })(), 'directed turn');
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const directedTurns = acceptedTurns - idleTurns;
      streamAbort.abort(new Error('directed observation complete'));
      await bounded(streamPromise.catch((error) => {
        if (!/abort|directed observation complete/i.test(error?.message ?? '')) throw error;
      }), 'stream shutdown');
      streamPromise = undefined;

      const directedDrain = await drainUnread(20);
      const directedOccurrences = directedDrain.entries.filter((entry) => entry.id === directed.id).length;
      const expectedIds: string[] = [];
      const authenticatedWriterIds = new Set<string>();
      for (let offset = 0; offset < 150; offset += 30) {
        const batch = Array.from({ length: Math.min(30, 150 - offset) }, (_, index) => {
          const sequence = offset + index;
          return append(
            writerRefs[sequence % writerRefs.length].session_credential,
            `s4-burst-${String(sequence).padStart(3, '0')}-${randomUUID()}`,
          );
        });
        for (const entry of await bounded(Promise.all(batch), `burst batch ${offset / 30 + 1}`)) {
          if (typeof entry.drone_id !== 'string' || !UUID_RE.test(entry.drone_id)) {
            throw new Error('burst append response omitted a valid authenticated writer drone_id');
          }
          expectedIds.push(entry.id);
          authenticatedWriterIds.add(entry.drone_id);
        }
      }

      const burstDrain = await drainUnread(17);
      const expected = new Set(expectedIds);
      const drainedIds = burstDrain.entries.map((entry) => entry.id);
      const drainedExpected = drainedIds.filter((id) => expected.has(id));
      const unique = new Set(drainedExpected);
      const missing = expectedIds.filter((id) => !unique.has(id));
      const duplicates = drainedExpected.length - unique.size;
      const unexpected = drainedIds.filter((id) => !expected.has(id));
      const resets = transportErrors.filter((error) => error.code === 'ECONNRESET');
      const allRequestsSameOrigin = requestUrls.every((value) => new URL(value).origin === origin);
      const pass =
        idleTurns === 0 &&
        directedTurns === 1 &&
        directedOccurrences === 1 &&
        expectedIds.length === 150 &&
        authenticatedWriterIds.size >= 2 &&
        drainedExpected.length === 150 &&
        unique.size === 150 &&
        missing.length === 0 &&
        duplicates === 0 &&
        unexpected.length === 0 &&
        !statuses.has(429) &&
        resets.length === 0 &&
        forbiddenFetchAttempts === 0 &&
        allRequestsSameOrigin &&
        turnErrors.length === 0;
      result = {
        pass,
        client_sha: EXPECTED_CLIENT_SHA,
        origin,
        simulated_idle_ms: 2 * wake.CODEX_HEARTBEAT_CADENCE_MS,
        idle_accepted_model_turns: idleTurns,
        directed_items: 1,
        directed_accepted_model_turns: directedTurns,
        directed_unread_occurrences: directedOccurrences,
        authenticated_writer_ids: [...authenticatedWriterIds].sort(),
        validated_writer_refs: writerRefs.map(({ cube_id, drone_id, role_id, session_id }) => ({
          cube_id,
          drone_id,
          ...(role_id ? { role_id } : {}),
          ...(session_id ? { session_id } : {}),
        })),
        authenticated_writer_count: authenticatedWriterIds.size,
        burst_expected: expectedIds.length,
        burst_drained: drainedExpected.length,
        burst_unique: unique.size,
        drain_pages: burstDrain.pages,
        missing_ids: missing,
        duplicate_count: duplicates,
        unexpected_ids: unexpected,
        status_counts: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)),
        http_429_count: statuses.get(429) ?? 0,
        econnreset_count: resets.length,
        transport_errors: transportErrors,
        forbidden_fetch_attempts: forbiddenFetchAttempts,
        all_requests_same_origin: allRequestsSameOrigin,
        turn_validation_errors: turnErrors,
        app_server_methods: methods,
      };
    } catch (error) {
      operationError = error;
    } finally {
      streamAbort?.abort();
      await bounded(streamPromise?.catch(() => {}) ?? Promise.resolve(), 'final stream cleanup').catch(() => {});
      for (const socket of sockets) socket.destroy();
      await bounded(new Promise<void>((resolve) => appServer.close(() => resolve())), 'app-server close').catch(() => {});
      rmSync(runtimeDir, { recursive: true, force: true });
    }

    const cleanupVerified = !existsSync(runtimeDir) && sockets.size === 0;
    if (operationError) {
      console.log(`S4_COUPLED_E2E ${JSON.stringify({
        pass: false,
        client_sha: EXPECTED_CLIENT_SHA,
        origin,
        error: operationError instanceof Error ? operationError.message : String(operationError),
        cleanup_verified: cleanupVerified,
      })}`);
      throw operationError;
    }
    const output = {
      ...result,
      pass: result?.pass === true && cleanupVerified,
      cleanup_verified: cleanupVerified,
    };
    console.log(`S4_COUPLED_E2E ${JSON.stringify(output)}`);

    expect(output).toMatchObject({
      pass: true,
      idle_accepted_model_turns: 0,
      directed_accepted_model_turns: 1,
      directed_unread_occurrences: 1,
      burst_expected: 150,
      burst_drained: 150,
      burst_unique: 150,
      missing_ids: [],
      duplicate_count: 0,
      unexpected_ids: [],
      http_429_count: 0,
      econnreset_count: 0,
      forbidden_fetch_attempts: 0,
      all_requests_same_origin: true,
      turn_validation_errors: [],
      cleanup_verified: true,
    });
    expect(output.authenticated_writer_count).toEqual(expect.any(Number));
    expect(output.authenticated_writer_count as number).toBeGreaterThanOrEqual(2);
  }, 45_000);
});
