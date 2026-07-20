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
});

describe.runIf(enabled)('Sprint 4 joined client/server E2E', () => {
  it('proves idle=0, directed=1, exact 150 drain, transport health, and zero egress', async () => {
    expect(required('BORG_E2E_CLIENT_SHA')).toBe(EXPECTED_CLIENT_SHA);
    const origin = loopbackOrigin(required('BORG_API_URL'));
    const caPath = path.resolve(required('BORG_E2E_CA_PATH'));
    const trustIdentity = required('BORG_E2E_TRUST_IDENTITY');
    const writerTokens = JSON.parse(required('BORG_E2E_WRITER_TOKENS')) as unknown;
    if (
      !Array.isArray(writerTokens) ||
      writerTokens.length < 2 ||
      writerTokens.some((token) => typeof token !== 'string' || token.length < 43) ||
      new Set(writerTokens).size !== writerTokens.length
    ) {
      throw new Error('BORG_E2E_WRITER_TOKENS must contain at least two distinct writer credentials');
    }

    const active: ActiveCube = {
      cubeId: required('BORG_E2E_CUBE_ID'),
      droneId: required('BORG_E2E_READER_DRONE_ID'),
      name: 's4-coupled-e2e',
      droneLabel: 's4-reader',
      sessionToken: required('BORG_E2E_READER_TOKEN'),
      apiUrl: origin,
      serverTrustIdentity: trustIdentity,
    };
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('request timeout')), 10_000);
      const abort = () => controller.abort(init.signal?.reason);
      init.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await pinnedFetch(input, { ...init, signal: controller.signal });
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
        return response;
      } catch (error: any) {
        transportErrors.push({
          code: error?.code ?? error?.cause?.code ?? null,
          message: error?.message ?? String(error),
        });
        throw error;
      } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
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

      const directed = await append(writerTokens[0], `s4-directed-${randomUUID()}`, true);
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
      for (let offset = 0; offset < 150; offset += 30) {
        const batch = Array.from({ length: Math.min(30, 150 - offset) }, (_, index) => {
          const sequence = offset + index;
          return append(
            writerTokens[sequence % writerTokens.length],
            `s4-burst-${String(sequence).padStart(3, '0')}-${randomUUID()}`,
          );
        });
        for (const entry of await bounded(Promise.all(batch), `burst batch ${offset / 30 + 1}`)) {
          expectedIds.push(entry.id);
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
  }, 45_000);
});
