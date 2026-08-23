import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOpenCodeDroneForTests,
  __decodeOpenCodeSessionForTests,
  __getOpenCodeBindingPathForTests,
  __getOpenCodeDiagnosticLogPathForTests,
  __getOpenCodeLastObservationForTests,
  __listOpenCodeSessionsForTests,
  allocateOpenCodePort,
  configuredOpenCodePort,
  computeOpenCodePort,
  connectOpenCodeDrone,
  createOpenCodeLaunchKickoff,
  disconnectOpenCodeDrone,
  getOpenCodeConnectionState,
  injectInitialKickoff,
  injectOpenCodeEntry,
  openCodeStartupDiagnosticLogPath,
  probeOpenCodeDroneArmed,
  settleOpenCodeEntry,
  writeOpenCodeStartupDiagnostic,
  OPEN_CODE_PORT_MISSING_DIAGNOSTIC,
} from '../src/opencode-drone';
import { streamOnce } from '../src/log-stream';
import { openCodeWakePathHealthy } from '../src/wake-path-health';
import { renderStreamStatus } from '../src/stream-status';
import { OpenCodeAuthenticationError } from '../src/server-errors';
import { BORG_STATE_ROOT_ENV, borgConfigRoot } from '../src/private-root';
import {
  OPENCODE_INJECTED_ENTRY_METADATA_KEY,
  OPENCODE_WAKE_IDENTITY_METADATA_KEY,
} from '../src/opencode-plugin';

const DIRECTORY = '/repo';
const SERVER_URL = 'http://127.0.0.1:15113';
const KICKOFF = 'Call borg_regen and follow the playbook.';
const API_PASSWORD = Buffer.alloc(32, 0x41).toString('base64url');
const LAUNCH_IDENTITY = Buffer.alloc(32, 0x42).toString('base64url');
const CORRELATION_METADATA_KEY = 'borgOpenCodeLaunchCorrelation';

interface Session {
  id: string;
  directory: string;
  time: { created: number };
  parentID?: string;
}

function session(id: string, created: number, parentID?: string): Session {
  return { id, directory: DIRECTORY, time: { created }, ...(parentID ? { parentID } : {}) };
}

function launchKickoff(correlationIdentity: string) {
  return createOpenCodeLaunchKickoff(KICKOFF, {
    apiPassword: API_PASSWORD,
    correlationIdentity: createHash('sha256').update(correlationIdentity).digest('base64url'),
  });
}

function kickoffMessages(launch: ReturnType<typeof createOpenCodeLaunchKickoff>, created = Date.now()) {
  return [{
    info: { role: 'user', time: { created } },
    parts: [{
      type: 'text',
      text: launch.prompt,
      metadata: { [CORRELATION_METADATA_KEY]: launch.correlationIdentity },
    }],
  }];
}

function rawSseResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function installOpenCodeApi(options: {
  sessions: () => Session[];
  messages?: Record<string, unknown[]>;
  missing?: Set<string>;
  promptStatus?: Record<string, number>;
  promptResponse?: (input: {
    sessionId: string;
    body: Record<string, unknown>;
    attempt: number;
  }) => Response | Promise<Response>;
  messageListResponse?: (input: {
    sessionId: string;
    promptBodies: Array<Record<string, unknown>>;
    messages: unknown[];
  }) => Response | Promise<Response>;
  sessionsResponse?: () => Response | Promise<Response>;
  sessionResponse?: (sessionId: string, session: Session | undefined) => Response | Promise<Response>;
}) {
  const prompts: string[] = [];
  const promptBodies: Array<Record<string, unknown>> = [];
  const injectedMessages = new Map<string, { info: { id: string; role: string }; parts: unknown[] }>();
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const id = path.match(/^\/session\/([^/]+)(?:\/.*)?$/)?.[1];
    const suffix = path.match(/^\/session\/[^/]+\/(.+)$/)?.[1];

    if (path === '/session') {
      if (options.sessionsResponse) return options.sessionsResponse();
      return new Response(JSON.stringify(options.sessions()), { status: 200 });
    }
    if (id && suffix === 'message') {
      const messages = [
        ...(options.messages?.[id] ?? []),
        ...[...injectedMessages.entries()]
          .filter(([key]) => key.startsWith(`${id}\0`))
          .map(([, message]) => message),
      ];
      if (options.messageListResponse) {
        return options.messageListResponse({ sessionId: id, promptBodies, messages });
      }
      return new Response(JSON.stringify(messages), { status: 200 });
    }
    if (id && suffix === 'prompt_async') {
      prompts.push(id);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      promptBodies.push(body);
      if (options.promptResponse) {
        return options.promptResponse({
          sessionId: id,
          body,
          attempt: promptBodies.length,
        });
      }
      const status = options.promptStatus?.[id] ?? 204;
      if (status === 200 || status === 204) {
        const messageID = typeof body.messageID === 'string'
          ? body.messageID
          : `msg_${String(promptBodies.length).padStart(12, '0')}generated`;
        injectedMessages.set(`${id}\0${messageID}`, {
          info: { id: messageID, role: 'user' },
          parts: Array.isArray(body.parts) ? body.parts : [],
        });
      }
      return new Response(status === 204 ? null : '', { status });
    }
    if (id) {
      if (options.missing?.has(id)) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      const found = options.sessions().find((item) => item.id === id);
      if (options.sessionResponse) return options.sessionResponse(id, found);
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    throw new Error(`Unhandled OpenCode API request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { prompts, promptBodies, fetchMock };
}

async function connect(
  droneLabel = 'drone-7',
  serverUrl = SERVER_URL,
  directory = DIRECTORY,
  launchIdentity = LAUNCH_IDENTITY,
) {
  await connectOpenCodeDrone({
    serverUrl,
    apiPassword: API_PASSWORD,
    directory,
    droneLabel,
    cubeName: 'borg-mcp',
    launchIdentity,
  });
}

describe('OpenCode wake target binding', () => {
  const originalStateRoot = process.env[BORG_STATE_ROOT_ENV];
  const originalTmpDir = process.env.TMPDIR;
  let testStateRoot: string;

  beforeEach(() => {
    __resetOpenCodeDroneForTests();
    testStateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'borg-opencode-drone-state-')));
    process.env[BORG_STATE_ROOT_ENV] = testStateRoot;
    process.env.TMPDIR = testStateRoot;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetOpenCodeDroneForTests();
    if (originalStateRoot === undefined) delete process.env[BORG_STATE_ROOT_ENV];
    else process.env[BORG_STATE_ROOT_ENV] = originalStateRoot;
    if (originalTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpDir;
    rmSync(testStateRoot, { recursive: true, force: true });
  });

  it('allocates distinct OS ports for IDs that collide under the old hash', async () => {
    const firstId = '00000000-0000-4000-8000-000000000000';
    const secondId = '00000000-0000-4000-8000-000000000121';
    expect(computeOpenCodePort(firstId)).toBe(computeOpenCodePort(secondId));

    const [firstPort, secondPort] = await Promise.all([
      allocateOpenCodePort(),
      allocateOpenCodePort(),
    ]);
    expect(firstPort).toBeGreaterThan(0);
    expect(secondPort).toBeGreaterThan(0);
    expect(firstPort).not.toBe(secondPort);
  });

  it('retries a candidate reported occupied during allocation', async () => {
    const availability = vi.fn(async () => availability.mock.calls.length > 1);
    const port = await allocateOpenCodePort(availability);

    expect(availability).toHaveBeenCalledTimes(2);
    expect(port).toBeGreaterThan(0);
  });

  it('resolves the launch-scoped child port from the propagated environment', () => {
    expect(configuredOpenCodePort({ BORG_OPENCODE_PORT: '15555' })).toBe(15555);
    expect(configuredOpenCodePort({ BORG_OPENCODE_PORT: '0' })).toBeNull();
  });

  it('provides a fail-closed diagnostic when no launch port was propagated', () => {
    expect(configuredOpenCodePort({})).toBeNull();
    expect(OPEN_CODE_PORT_MISSING_DIAGNOSTIC).toContain('Relaunch through borg');
  });

  it('generates independent 256-bit launch trust without changing the shared kickoff text', () => {
    const first = createOpenCodeLaunchKickoff(KICKOFF);
    const second = createOpenCodeLaunchKickoff(KICKOFF);

    expect(first.apiPassword).not.toBe(first.correlationIdentity);
    expect(first.apiPassword).not.toBe(second.apiPassword);
    expect(first.correlationIdentity).not.toBe(second.correlationIdentity);
    expect(Buffer.from(first.apiPassword, 'base64url')).toHaveLength(32);
    expect(Buffer.from(first.correlationIdentity, 'base64url')).toHaveLength(32);
    expect(first.prompt).toBe(KICKOFF);
    expect(KICKOFF).toBe('Call borg_regen and follow the playbook.');
  });

  it('rejects malformed or reused launch trust identities', () => {
    expect(() => createOpenCodeLaunchKickoff(KICKOFF, {
      apiPassword: 'short',
      correlationIdentity: Buffer.alloc(32, 0x42).toString('base64url'),
    })).toThrow('256-bit identities');
    expect(() => createOpenCodeLaunchKickoff(KICKOFF, {
      apiPassword: API_PASSWORD,
      correlationIdentity: API_PASSWORD,
    })).toThrow('must be independent');
  });

  it('uses a typed authentication error for an unverifiable API password', async () => {
    await expect(connectOpenCodeDrone({
      serverUrl: SERVER_URL,
      apiPassword: 'short',
      directory: DIRECTORY,
      droneLabel: 'drone-7',
      cubeName: 'borg-mcp',
      launchIdentity: LAUNCH_IDENTITY,
    })).rejects.toBeInstanceOf(OpenCodeAuthenticationError);
    await expect(connectOpenCodeDrone({
      serverUrl: SERVER_URL,
      apiPassword: API_PASSWORD,
      directory: DIRECTORY,
      droneLabel: 'drone-7',
      cubeName: 'borg-mcp',
      launchIdentity: 'short',
    })).rejects.toBeInstanceOf(OpenCodeAuthenticationError);
  });

  it('authenticates every OpenCode API request with the per-launch password', async () => {
    const launch = launchKickoff('authenticated-launch');
    const root = session('authenticated-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: [{
        info: { role: 'user' },
        parts: [{
          type: 'text',
          text: KICKOFF,
          metadata: { [CORRELATION_METADATA_KEY]: launch.correlationIdentity },
        }],
      }] },
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    await expect(injectOpenCodeEntry('authenticated wake')).resolves.toBe(true);

    const expected = `Basic ${Buffer.from(`opencode:${API_PASSWORD}`).toString('base64')}`;
    expect(api.fetchMock).toHaveBeenCalled();
    for (const [, init] of api.fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe(expected);
    }
  });

  it('reports the final server-readiness failure code and attempt count', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('server-readiness-failure');
    const api = installOpenCodeApi({
      sessions: () => [],
      sessionsResponse: () => new Response('unauthorized', { status: 401 }),
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.runAllTimersAsync();

    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('unauthorized');
    expect(readFileSync(__getOpenCodeDiagnosticLogPathForTests(), 'utf8')).toContain(
      'kickoff: server unavailable code=unauthorized class=OpenCodeHttpError status=401 attempts=30',
    );
    expect(api.fetchMock).toHaveBeenCalledTimes(30);
  });

  it('does not poll for a launch session after server readiness exhausts', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('no-session-poll-after-readiness-failure');
    const api = installOpenCodeApi({
      sessions: () => [],
      sessionsResponse: () => Promise.reject(new Error('connection refused')),
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.runAllTimersAsync();

    await expect(binding).resolves.toBe(false);
    expect(api.fetchMock).toHaveBeenCalledTimes(30);
    expect(readFileSync(__getOpenCodeDiagnosticLogPathForTests(), 'utf8')).not.toContain(
      'kickoff: no session found',
    );
  });

  it.each([
    {
      name: 'session-list HTTP failure',
      sessions: [session('listed-root', 10)],
      sessionsResponse: (attempt: number) => attempt === 1
        ? new Response(JSON.stringify([session('listed-root', 10)]), { status: 200 })
        : new Response('forbidden', { status: 403 }),
      expected: 'kickoff: session search list-failed code=incompatible-api class=OpenCodeHttpError status=403 listed=unknown directory=unknown matches=unknown attempts=30',
    },
    {
      name: 'session-list decode failure',
      sessions: [session('decode-root', 10)],
      sessionsResponse: (attempt: number) => attempt === 1
        ? new Response(JSON.stringify([session('decode-root', 10)]), { status: 200 })
        : new Response('{}', { status: 200 }),
      expected: 'kickoff: session search list-failed code=incompatible-api class=OpenCodeResponseError status=none listed=unknown directory=unknown matches=unknown attempts=30',
    },
    {
      name: 'zero directory matches',
      sessions: [{ ...session('other-directory-root', 10), directory: '/other-repo' }],
      expected: 'kickoff: session search directory-miss listed=1 directory=0 matches=0 attempts=30',
    },
    {
      name: 'wrong correlation count',
      sessions: [session('uncorrelated-root', 10)],
      expected: 'kickoff: session search correlation-mismatch listed=1 directory=1 matches=0 attempts=30',
    },
  ])('distinguishes $name while finding the launch session', async ({ sessions, sessionsResponse, expected }) => {
    vi.useFakeTimers();
    const launch = launchKickoff(`launch-search-${expected}`);
    let listAttempts = 0;
    installOpenCodeApi({
      sessions: () => sessions,
      messages: Object.fromEntries(sessions.map((candidate) => [candidate.id, []])),
      ...(sessionsResponse
        ? { sessionsResponse: () => sessionsResponse(++listAttempts) }
        : {}),
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.runAllTimersAsync();

    await expect(binding).resolves.toBe(false);
    expect(readFileSync(__getOpenCodeDiagnosticLogPathForTests(), 'utf8')).toContain(expected);
  });

  it.each([
    [401, 'unauthorized'],
    [404, 'not-found'],
    [503, 'transient'],
  ])('classifies an OpenCode session probe HTTP %i failure as %s', async (status, failureCode) => {
    const launch = launchKickoff(`probe-${status}`);
    const root = session(`probe-root-${status}`, 10);
    let probeStatus = 200;
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: (_id, found) => new Response(
        probeStatus === 200 ? JSON.stringify(found) : JSON.stringify({ error: 'failed' }),
        { status: probeStatus },
      ),
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    probeStatus = status;

    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe(failureCode);
  });

  it('classifies a timed-out OpenCode session probe separately from transport failures', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('probe-timeout');
    const root = session('probe-timeout-root', 10);
    let timeout = false;
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: (_id, found) => timeout
        ? new Promise<Response>((_resolve, reject) => {
          const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
        : new Response(JSON.stringify(found), { status: 200 }),
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    timeout = true;
    const probe = probeOpenCodeDroneArmed();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(probe).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('timeout');
  });

  it('classifies an OpenCode transport failure separately from a timeout', async () => {
    const launch = launchKickoff('probe-transport');
    const root = session('probe-transport-root', 10);
    let unavailable = false;
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: (_id, found) => unavailable
        ? Promise.reject(new Error('connection reset'))
        : new Response(JSON.stringify(found), { status: 200 }),
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    unavailable = true;

    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('transient');
  });

  it('retains a newer failure while an older delivery reports its terminal result and acceptance', async () => {
    const launch = launchKickoff('independent-observation-domains');
    const root = session('independent-observation-root', 10);
    let detailCalls = 0;
    let releaseOlder!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => {
      releaseOlder = resolve;
    });
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: () => ++detailCalls === 1
        ? olderResponse
        : new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    });

    await connect();
    await injectInitialKickoff(launch);
    const olderDelivery = injectOpenCodeEntry('older accepted wake', 'older-accepted');
    await vi.waitFor(() => expect(detailCalls).toBe(1));
    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    releaseOlder(new Response(JSON.stringify(root), { status: 200 }));
    await expect(olderDelivery).resolves.toBe(true);

    const observation = __getOpenCodeLastObservationForTests();
    expect(observation.failureSequence).toBeGreaterThan(observation.injectionSequence);
    expect(observation.failureSequence).toBeGreaterThan(observation.acceptedSequence);
    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionResult: 'delivered',
      lastAcceptedEntryId: 'older-accepted',
      lastFailureCode: 'unauthorized',
    });
  });

  it('drops a superseded connection observation without freezing the replacement connection', async () => {
    const firstLaunch = launchKickoff('superseded-owner-a');
    const secondLaunch = launchKickoff('replacement-owner-b');
    const firstRoot = session('superseded-root-a', 10);
    const secondRoot = session('replacement-root-b', 20);
    let rejectFirstRequest!: (error: Error) => void;
    const firstRequest = new Promise<Response>((_resolve, reject) => {
      rejectFirstRequest = reject;
    });
    let holdFirstRequest = false;
    let firstRequestStarted = false;
    installOpenCodeApi({
      sessions: () => [firstRoot, secondRoot],
      messages: {
        [firstRoot.id]: kickoffMessages(firstLaunch),
        [secondRoot.id]: kickoffMessages(secondLaunch),
      },
      sessionsResponse: () => {
        if (holdFirstRequest) {
          firstRequestStarted = true;
          return firstRequest;
        }
        return new Response(JSON.stringify([firstRoot, secondRoot]), { status: 200 });
      },
    });

    await connect('owner-a');
    await injectInitialKickoff(firstLaunch);
    holdFirstRequest = true;
    const supersededDelivery = injectOpenCodeEntry('superseded wake', 'superseded-entry');
    await vi.waitFor(() => expect(firstRequestStarted).toBe(true));

    await connect('owner-b');
    holdFirstRequest = false;
    await injectInitialKickoff(secondLaunch);
    const replacementBeforeOldFailure = __getOpenCodeLastObservationForTests();
    rejectFirstRequest(new Error('old connection failed after replacement'));
    await expect(supersededDelivery).resolves.toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(__getOpenCodeLastObservationForTests()).toEqual(replacementBeforeOldFailure);
    await expect(injectOpenCodeEntry('replacement wake', 'replacement-entry')).resolves.toBe(true);
    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionResult: 'delivered',
      lastAcceptedEntryId: 'replacement-entry',
      lastFailureCode: null,
    });
  });

  it('rejects a syntactically valid but incompatible OpenCode session response', async () => {
    const launch = launchKickoff('incompatible-session');
    const root = session('incompatible-session-root', 10);
    let incompatible = false;
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: (_id, found) => new Response(
        JSON.stringify(incompatible ? { id: root.id } : found),
        { status: 200 },
      ),
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    incompatible = true;

    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('incompatible-api');
  });

  it('accepts the exact OpenCode v2 session shape while ignoring unread fields', () => {
    const upstreamSession = {
      ...session('observed-upstream-shape', 10),
      model: {
        id: 'claude-sonnet-4',
        providerID: 'anthropic',
        variant: 'high',
      },
      agent: 'build',
    };

    expect(__decodeOpenCodeSessionForTests(upstreamSession)).toBe(upstreamSession);
  });

  it('lists a populated collection containing the exact OpenCode v2 session shape', async () => {
    const upstreamSession = {
      ...session('populated-upstream-shape', 10),
      model: {
        id: 'claude-sonnet-4',
        providerID: 'anthropic',
        variant: 'high',
      },
      agent: 'build',
    };
    installOpenCodeApi({ sessions: () => [upstreamSession] });
    await connect();

    await expect(__listOpenCodeSessionsForTests()).resolves.toEqual([upstreamSession]);
  });

  it('classifies malformed OpenCode JSON as an incompatible API response', async () => {
    const launch = launchKickoff('malformed-json');
    const root = session('malformed-json-root', 10);
    let malformed = false;
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      sessionResponse: (_id, found) => new Response(
        malformed ? '{' : JSON.stringify(found),
        { status: 200 },
      ),
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    malformed = true;

    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('incompatible-api');
  });

  it.each([
    ['session collection', { sessionsResponse: () => new Response('{}', { status: 200 }) }],
    ['message collection', {
      messageListResponse: () => new Response(JSON.stringify({ messages: [] }), { status: 200 }),
    }],
  ])('rejects an incompatible OpenCode %s response', async (_surface, responseOverrides) => {
    vi.useFakeTimers();
    const launch = launchKickoff(`incompatible-${_surface}`);
    const root = session(`incompatible-${_surface}-root`, 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      ...responseOverrides,
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('incompatible-api');
  });

  it.each([
    ['missing info', { parts: [] }],
    ['missing parts', { info: { role: 'user' } }],
  ])('rejects an OpenCode message envelope with %s', async (_case, invalidMessage) => {
    vi.useFakeTimers();
    const launch = launchKickoff(`invalid-message-${_case}`);
    const root = session(`invalid-message-${_case}-root`, 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: () => new Response(JSON.stringify([invalidMessage]), { status: 200 }),
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().lastFailureCode).toBe('incompatible-api');
  });

  it('reports the target, last attempt, accepted entry, and cleared failure after delivery', async () => {
    const launch = launchKickoff('delivery-diagnostics');
    const root = session('delivery-diagnostics-root', 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    await expect(injectOpenCodeEntry('diagnostic wake', 'entry-diagnostic')).resolves.toBe(true);

    expect(getOpenCodeConnectionState()).toMatchObject({
      sessionId: root.id,
      lastInjectionResult: 'delivered',
      lastAcceptedEntryId: 'entry-diagnostic',
      lastFailureCode: null,
    });
    expect(getOpenCodeConnectionState().lastInjectionAt).toEqual(expect.any(Number));
  });

  it('uses separate bounded 0600 diagnostic logs for separate worktree seats', async () => {
    await connect('diagnostic-drone-a');
    const firstPath = __getOpenCodeDiagnosticLogPathForTests();
    expect(statSync(firstPath).mode & 0o777).toBe(0o600);
    for (let i = 0; i < 1_000; i++) await connect('diagnostic-drone-a');
    expect(statSync(firstPath).size).toBeLessThanOrEqual(64 * 1024);

    await connect('diagnostic-drone-b', SERVER_URL, '/repo-b');
    expect(__getOpenCodeDiagnosticLogPathForTests()).not.toBe(firstPath);
  });

  it('keeps one seat identity when a relaunch selects a different port', async () => {
    await connect('stable-seat-identity', 'http://127.0.0.1:15113');
    const firstPath = __getOpenCodeDiagnosticLogPathForTests();

    await connect('stable-seat-identity', 'http://127.0.0.1:16113');

    expect(__getOpenCodeDiagnosticLogPathForTests()).toBe(firstPath);
  });

  it('hands the placeholder launch binding to its resolved seat and rejects another seat', async () => {
    const launch = launchKickoff('placeholder-handoff');
    const root = session('placeholder-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });
    await connectOpenCodeDrone({
      serverUrl: SERVER_URL,
      apiPassword: API_PASSWORD,
      directory: DIRECTORY,
      droneLabel: 'opencode',
      cubeName: 'borg',
      launchIdentity: launch.correlationIdentity,
    });
    const launchPaths = {
      binding: __getOpenCodeBindingPathForTests(),
      diagnostic: __getOpenCodeDiagnosticLogPathForTests(),
    };
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    disconnectOpenCodeDrone();

    await connect('builder-4cf3a767', SERVER_URL, DIRECTORY, launch.correlationIdentity);

    expect({
      binding: __getOpenCodeBindingPathForTests(),
      diagnostic: __getOpenCodeDiagnosticLogPathForTests(),
    }).toEqual(launchPaths);
    await expect(probeOpenCodeDroneArmed()).resolves.toBe(true);
    await expect(injectOpenCodeEntry('resolved wake')).resolves.toBe(true);

    disconnectOpenCodeDrone();
    await connect('reviewer-other', SERVER_URL, DIRECTORY, launch.correlationIdentity);
    await expect(probeOpenCodeDroneArmed()).resolves.toBe(false);
    await expect(injectOpenCodeEntry('wrong seat wake')).resolves.toBe(false);
    expect(api.prompts).toEqual([root.id]);
  });

  it('preserves an idle active seat binding older than seven days when another seat connects', async () => {
    const launch = launchKickoff('idle-active-binding');
    const root = session('idle-active-root', 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });
    const droneLabel = 'idle-active-seat';
    const identity = createHash('sha256')
      .update(LAUNCH_IDENTITY)
      .digest('hex')
      .slice(0, 24);
    const idleBindingPath = join(testStateRoot, `borg-opencode-session-${identity}.json`);

    await connect(droneLabel);
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    expect(existsSync(idleBindingPath)).toBe(true);
    const staleTime = new Date(Date.now() - (8 * 24 * 60 * 60 * 1_000));
    utimesSync(idleBindingPath, staleTime, staleTime);

    await connect('another-seat');

    expect(existsSync(idleBindingPath)).toBe(true);
  });

  it('reports diagnostic log write failures instead of swallowing them', async () => {
    await connect('diagnostic-write-failure');
    const path = __getOpenCodeDiagnosticLogPathForTests();
    unlinkSync(path);
    mkdirSync(path);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await connect('diagnostic-write-failure');
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('OpenCode diagnostic log write failed'));
    } finally {
      stderr.mockRestore();
      rmSync(path, { recursive: true, force: true });
    }
  });

  it('keeps both diagnostic variants under the private Borg config root', async () => {
    await connect('private-diagnostic-path');
    expect(dirname(openCodeStartupDiagnosticLogPath())).toBe(borgConfigRoot());
    expect(dirname(__getOpenCodeDiagnosticLogPathForTests())).toBe(borgConfigRoot());
    expect(statSync(borgConfigRoot()).mode & 0o777).toBe(0o700);
  });

  it('corrects an existing non-writable private root mode before logging', async () => {
    mkdirSync(borgConfigRoot(), { recursive: true, mode: 0o750 });
    chmodSync(borgConfigRoot(), 0o750);
    await writeOpenCodeStartupDiagnostic('private root mode corrected');

    expect(statSync(borgConfigRoot()).mode & 0o777).toBe(0o700);
    expect(statSync(openCodeStartupDiagnosticLogPath()).mode & 0o777).toBe(0o600);
  });

  it('refuses a non-regular startup diagnostic destination', async () => {
    await writeOpenCodeStartupDiagnostic('prepare private root');
    const diagnosticPath = openCodeStartupDiagnosticLogPath();
    unlinkSync(diagnosticPath);
    mkdirSync(diagnosticPath);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() => writeOpenCodeStartupDiagnostic('must not enter directory')).toThrow();
      expect(statSync(diagnosticPath).isDirectory()).toBe(true);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('OpenCode diagnostic log write failed'));
    } finally {
      stderr.mockRestore();
      rmSync(diagnosticPath, { recursive: true, force: true });
    }
  });

  it('refuses a planted alias after the private root is replaced', () => {
    chmodSync(testStateRoot, 0o777);
    writeOpenCodeStartupDiagnostic('prepare original private root');
    const originalConfigParent = join(testStateRoot, '.config-original');
    renameSync(join(testStateRoot, '.config'), originalConfigParent);
    mkdirSync(join(testStateRoot, '.config'), { mode: 0o777 });
    mkdirSync(borgConfigRoot(), { mode: 0o700 });
    const victimPath = join(testStateRoot, 'victim.txt');
    writeFileSync(victimPath, 'unchanged\n', { mode: 0o644 });
    symlinkSync(victimPath, openCodeStartupDiagnosticLogPath());
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      let refusal: unknown;
      try {
        writeOpenCodeStartupDiagnostic('must not reach victim');
      } catch (error) {
        refusal = error;
      }
      expect(readFileSync(victimPath, 'utf8')).toBe('unchanged\n');
      expect(statSync(victimPath).mode & 0o777).toBe(0o644);
      expect(refusal).toBeInstanceOf(Error);
    } finally {
      stderr.mockRestore();
    }
  });

  it('re-verifies a prepared private root before the next write', () => {
    writeOpenCodeStartupDiagnostic('prepare private root');
    chmodSync(borgConfigRoot(), 0o777);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let refusal: unknown;

    try {
      writeOpenCodeStartupDiagnostic('must refuse changed root');
    } catch (error) {
      refusal = error;
    } finally {
      stderr.mockRestore();
    }

    expect(refusal).toBeInstanceOf(Error);
    expect(statSync(borgConfigRoot()).mode & 0o777).toBe(0o777);
  });

  it('binds only one exact hidden correlation match and rejects duplicates', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('exact-hidden-match');
    const first = session('first', 10);
    const second = session('second', 20);
    const correlated = {
      info: { role: 'user', time: { created: 999 } },
      parts: [{
        type: 'text',
        text: KICKOFF,
        metadata: { [CORRELATION_METADATA_KEY]: launch.correlationIdentity },
      }],
    };
    installOpenCodeApi({
      sessions: () => [first, second],
      messages: { [first.id]: [correlated], [second.id]: [correlated] },
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });

  it('reports a failed kickoff as an unhealthy no-target state instead of idle', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('no-target-health');
    const root = session('uncorrelated-health-root', 10);
    installOpenCodeApi({ sessions: () => [root], messages: { [root.id]: [] } });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.runAllTimersAsync();

    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState()).toMatchObject({
      sessionId: null,
      lastFailureCode: 'no-target',
    });
    expect(openCodeWakePathHealthy(getOpenCodeConnectionState())).toBe(false);
  });

  it('does not claim an exact match while another candidate is unverifiable', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('unverifiable-candidate');
    const matched = session('matched', 10);
    const unverifiable = session('unverifiable', 20);
    installOpenCodeApi({
      sessions: () => [matched, unverifiable],
      messages: { [matched.id]: kickoffMessages(launch) },
      messageListResponse: ({ sessionId, messages }) => new Response(
        sessionId === unverifiable.id ? 'unavailable' : JSON.stringify(messages),
        { status: sessionId === unverifiable.id ? 503 : 200 },
      ),
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });

  it('never binds by prompt text, timestamp, or newest-session fallback', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('metadata-only');
    const older = session('older-text-match', 10);
    const newest = session('newest-text-match', 20);
    installOpenCodeApi({
      sessions: () => [older, newest],
      messages: {
        [older.id]: [{
          info: { role: 'user', time: { created: 999 } },
          parts: [{ type: 'text', text: launch.prompt }],
        }],
        [newest.id]: [{
          info: { role: 'user', time: { created: 1_000 } },
          parts: [{ type: 'text', text: launch.prompt }],
        }],
      },
    });

    await connect();
    const binding = injectInitialKickoff(launch);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(binding).resolves.toBe(false);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });

  it('binds a fresh launch to the kickoff-owning root session, not a newer child', async () => {
    const launch = launchKickoff('fresh-launch');
    const root = session('fresh-root', 10);
    const child = session('newer-child', 20, root.id);
    const api = installOpenCodeApi({
      sessions: () => [root, child],
      messages: { [root.id]: kickoffMessages(launch), [child.id]: [] },
    });

    await connect();
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    await expect(injectOpenCodeEntry('wake')).resolves.toBe(true);

    expect(api.prompts).toEqual([root.id]);
    expect(getOpenCodeConnectionState().sessionId).toBe(root.id);
  });

  it('waits for this launch identity instead of binding a prior identical kickoff', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const previousLaunch = launchKickoff('previous-launch');
    const currentLaunch = launchKickoff('current-launch');
    const previous = session('previous-root', 1);
    const current = session('current-root', 2);
    let currentPromptVisible = false;
    const api = installOpenCodeApi({
      sessions: () => [previous, current],
      messages: {
        // This prior kickoff is only two seconds old: well inside the former
        // timestamp grace window. Its shared text is identical, but its hidden
        // metadata proves it belongs to a different OpenCode launch.
        [previous.id]: kickoffMessages(previousLaunch, now - 2_000),
        get [current.id]() {
          return currentPromptVisible ? kickoffMessages(currentLaunch, now) : [];
        },
      },
    });

    await connect();
    const binding = injectInitialKickoff(currentLaunch);
    await vi.advanceTimersByTimeAsync(1_000);
    currentPromptVisible = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(binding).resolves.toBe(true);
    await expect(injectOpenCodeEntry('wake')).resolves.toBe(true);

    expect(api.prompts).toEqual([current.id]);
  });

  it.each([
    ['resumed', 1],
    ['continued', 2],
  ])('retains the exact %s root session even when its creation time is old', async (_kind, created) => {
    const launch = launchKickoff(`existing-${created}`);
    const root = session('existing-root', created);
    const newerUnrelated = session('other-root', 99);
    const api = installOpenCodeApi({
      sessions: () => [root, newerUnrelated],
      messages: { [root.id]: kickoffMessages(launch), [newerUnrelated.id]: [] },
    });

    await connect();
    await injectInitialKickoff(launch);
    await injectOpenCodeEntry('wake');

    expect(api.prompts).toEqual([root.id]);
  });

  it('permits a fork only when the fork contains this launch kickoff', async () => {
    const launch = launchKickoff('explicit-fork-launch');
    const root = session('parent-root', 10);
    const fork = session('explicit-fork', 11, root.id);
    const api = installOpenCodeApi({
      sessions: () => [root, fork],
      messages: { [root.id]: [], [fork.id]: kickoffMessages(launch) },
    });

    await connect();
    await injectInitialKickoff(launch);
    await injectOpenCodeEntry('wake');

    expect(api.prompts).toEqual([fork.id]);
  });

  it('restores the launch binding in a separate MCP child process', async () => {
    const launch = launchKickoff('separate-mcp-child');
    const root = session('launch-root', 10);
    const child = session('completed-child', 20, root.id);
    const api = installOpenCodeApi({
      sessions: () => [root, child],
      messages: { [root.id]: kickoffMessages(launch), [child.id]: [] },
    });

    await connect();
    await injectInitialKickoff(launch);
    disconnectOpenCodeDrone();
    await connect();
    await injectOpenCodeEntry('wake from MCP child');

    expect(api.prompts).toEqual([root.id]);
  });

  it('restores a prior-launch binding after the OpenCode port changes', async () => {
    const launch = launchKickoff('port-independent-binding');
    const root = session('port-independent-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect('stable-binding-seat', 'http://127.0.0.1:15113');
    await expect(injectInitialKickoff(launch)).resolves.toBe(true);
    disconnectOpenCodeDrone();
    await connect('stable-binding-seat', 'http://127.0.0.1:16113');

    await expect(injectOpenCodeEntry('wake after port change')).resolves.toBe(true);
    expect(api.prompts).toEqual([root.id]);
  });

  it('rebinds to a newer top-level session after the user switches with /new', async () => {
    const launch = launchKickoff('switch-launch');
    const initial = session('initial-root', 10);
    const switched = session('switched-root', 20);
    let sessions = [initial];
    const api = installOpenCodeApi({
      sessions: () => sessions,
      messages: { [initial.id]: kickoffMessages(launch), [switched.id]: [] },
    });

    await connect();
    await injectInitialKickoff(launch);
    sessions = [initial, switched];
    await injectOpenCodeEntry('wake after /new');

    expect(api.prompts).toEqual([switched.id]);
    expect(getOpenCodeConnectionState().sessionId).toBe(switched.id);
  });

  it('clears a deleted target instead of falling back to a completed child', async () => {
    const launch = launchKickoff('deleted-launch');
    const root = session('deleted-root', 10);
    const child = session('completed-child', 20, root.id);
    const missing = new Set<string>();
    const api = installOpenCodeApi({
      sessions: () => [root, child],
      messages: { [root.id]: kickoffMessages(launch), [child.id]: [] },
      missing,
    });

    await connect();
    await injectInitialKickoff(launch);
    missing.add(root.id);
    await expect(injectOpenCodeEntry('wake after deletion')).resolves.toBe(false);

    expect(api.prompts).toEqual([]);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });

  it('rejects a binding owned by a different Borg drone', async () => {
    const launch = launchKickoff('other-drone-launch');
    const root = session('other-drone-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect('drone-7');
    await injectInitialKickoff(launch);
    disconnectOpenCodeDrone();
    await connect('drone-8');

    await expect(injectOpenCodeEntry('wrong drone wake')).resolves.toBe(false);
    expect(api.prompts).toEqual([]);
  });

  it('clears a session whose project directory no longer matches the binding', async () => {
    const launch = launchKickoff('moved-launch');
    const root = session('moved-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect();
    await injectInitialKickoff(launch);
    root.directory = '/other-project';

    await expect(injectOpenCodeEntry('wrong project wake')).resolves.toBe(false);
    expect(api.prompts).toEqual([]);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });

  it('recovers before submission, then lets OpenCode generate the message ID', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('injection-recovery');
    const root = session('recovery-root', 10);
    let lookupCount = 0;
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: ({ messages }) => {
        lookupCount++;
        if (lookupCount === 2) throw new Error('OpenCode process unavailable');
        return new Response(JSON.stringify(messages), { status: 200 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry('recover me', 'entry-recovery');
    await vi.advanceTimersByTimeAsync(0);
    expect(getOpenCodeConnectionState().deliveryStates.retried).toBe(1);
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(1);
    expect(api.promptBodies[0]).not.toHaveProperty('messageID');
    expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 1,
      totalEntriesRetried: 1,
      deliveryStates: {
        queued: 0,
        'delivered-unconfirmed': 0,
        retried: 0,
        failed: 0,
      },
    });
  });

  it('does not resubmit when acceptance persisted before confirmation was interrupted', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('confirmation-interrupted');
    const root = session('confirmation-root', 10);
    let lookupCount = 0;
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: ({ promptBodies, messages }) => {
        if (promptBodies.length === 0) {
          return new Response(JSON.stringify(messages), { status: 200 });
        }
        lookupCount++;
        if (lookupCount === 1) throw new Error('OpenCode process terminated');
        return new Response(JSON.stringify(messages), { status: 200 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry('wake once', 'entry-confirmation-interrupted');
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(1);
    expect(lookupCount).toBe(2);
    expect(getOpenCodeConnectionState().totalEntriesRetried).toBe(1);
  });

  it('does not resubmit a durable pending identity after the MCP child reconnects', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('pending-child-reconnect');
    const root = session('pending-child-root', 10);
    let visibleAt = Number.POSITIVE_INFINITY;
    let storedParts: unknown[] = [];
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: ({ messages }) => new Response(JSON.stringify(
        Date.now() >= visibleAt
          ? [...messages, {
            info: { id: 'msg_000000000001pending', role: 'user' },
            parts: storedParts,
          }]
          : messages,
      ), { status: 200 }),
      promptResponse: ({ body }) => {
        visibleAt = Date.now() + 6_000;
        storedParts = Array.isArray(body.parts) ? body.parts : [];
        return new Response(null, { status: 204 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const first = injectOpenCodeEntry('pending once', 'entry-pending-child');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.promptBodies).toHaveLength(1);

    disconnectOpenCodeDrone();
    await expect(first).resolves.toBe(false);
    await connect();
    const replay = injectOpenCodeEntry('pending once', 'entry-pending-child');
    await vi.advanceTimersByTimeAsync(7_250);
    await expect(replay).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(1);
    expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 1,
      deliveryStates: {
        queued: 0,
        'delivered-unconfirmed': 0,
        retried: 0,
        failed: 0,
      },
    });
  });

  it('preserves one durable submission across a session switch and MCP-child reconnect', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('pending-session-switch');
    const initial = session('pending-switch-initial', 10);
    const switched = session('pending-switch-new', 20);
    let sessions = [initial];
    const api = installOpenCodeApi({
      sessions: () => sessions,
      messages: {
        [initial.id]: kickoffMessages(launch),
        [switched.id]: [],
      },
      // Model a successful prompt_async whose generated message is not yet
      // visible in either session history.
      messageListResponse: ({ sessionId }) => new Response(JSON.stringify(
        sessionId === initial.id ? kickoffMessages(launch) : [],
      ), { status: 200 }),
    });

    await connect();
    await injectInitialKickoff(launch);
    const first = injectOpenCodeEntry(
      'one durable wake',
      'wake-before-switch',
      true,
      'source-session-switch',
    );
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(first).resolves.toBe(true);
    expect(api.promptBodies).toHaveLength(1);

    sessions = [initial, switched];
    const afterSwitch = injectOpenCodeEntry(
      'one durable wake',
      'wake-after-switch',
      true,
      'source-session-switch',
    );
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(afterSwitch).resolves.toBe(true);

    disconnectOpenCodeDrone();
    await connect();
    const afterReconnect = injectOpenCodeEntry(
      'one durable wake',
      'wake-after-reconnect',
      true,
      'source-session-switch',
    );
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(afterReconnect).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(1);
  });

  it('confirms a delayed prior-process submission on replay without posting again', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('prior-process-replay');
    const root = session('prior-process-root', 10);
    const visibleAt = Date.now() + 500;
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: {
        [root.id]: [
          ...kickoffMessages(launch),
          {
            info: { id: 'msg_000000000001prior', role: 'user' },
            parts: [{
              type: 'text',
              text: 'persisted by prior process',
              metadata: {
                [OPENCODE_INJECTED_ENTRY_METADATA_KEY]: true,
                [OPENCODE_WAKE_IDENTITY_METADATA_KEY]: 'entry-prior-process',
              },
            }],
          },
        ],
      },
      messageListResponse: ({ messages }) => new Response(JSON.stringify(
        Date.now() < visibleAt ? messages.slice(0, -1) : messages,
      ), { status: 200 }),
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry(
      'persisted by prior process',
      'entry-prior-process',
      false,
    );
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(0);
    expect(getOpenCodeConnectionState().totalEntriesRetried).toBe(2);
  });

  it('leaves an unverifiable prior-process submission unconfirmed without posting', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('unverifiable-prior-process-replay');
    const root = session('unverifiable-prior-process-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry(
      'possibly submitted by prior process',
      'entry-unverifiable-prior-process',
      false,
    );
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(false);

    expect(api.promptBodies).toHaveLength(0);
    expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 0,
      totalEntriesRetried: 3,
      deliveryStates: {
        'delivered-unconfirmed': 1,
        failed: 0,
      },
    });
  });

  it('serializes burst delivery and deduplicates active and completed replay by entry ID', async () => {
    const launch = launchKickoff('burst-order');
    const root = session('burst-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });

    await connect();
    await injectInitialKickoff(launch);
    const first = injectOpenCodeEntry('first', 'entry-first');
    const duplicate = injectOpenCodeEntry('first', 'entry-first');
    const second = injectOpenCodeEntry('second', 'entry-second');
    const third = injectOpenCodeEntry('third', 'entry-third');
    await expect(Promise.all([first, duplicate, second, third])).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);
    await expect(injectOpenCodeEntry('first', 'entry-first')).resolves.toBe(true);

    expect(api.promptBodies.map((body) =>
      ((body.parts as Array<{ text: string }>)[0]?.text)
    )).toEqual(['first', 'second', 'third']);
    expect(api.promptBodies.every((body, index) => {
      const parts = body.parts as Array<{ text: string; metadata?: Record<string, unknown> }>;
      return parts.length === 1
        && parts[0]?.metadata?.[OPENCODE_INJECTED_ENTRY_METADATA_KEY] === true
        && parts[0]?.metadata?.[OPENCODE_WAKE_IDENTITY_METADATA_KEY] === [
          'entry-first',
          'entry-second',
          'entry-third',
        ][index];
    })).toBe(true);
    expect(api.promptBodies.every((body) => !Object.hasOwn(body, 'messageID'))).toBe(true);
  });

  it('drops a queued wake consumed before prompt submission', async () => {
    const launch = launchKickoff('consumed-queue');
    const root = session('consumed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });
    await connect();
    await injectInitialKickoff(launch);

    await expect(injectOpenCodeEntry(
      'stale', 'entry-stale', true, 'source-stale', async () => false,
    )).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(0);
    expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 0,
      deliveryStates: { 'delivered-unconfirmed': 0, failed: 0 },
    });
  });

  it('submits once for one durable source across distinct wake nonces and reconnect', async () => {
    const launch = launchKickoff('raw-sse-wake-nonce');
    const root = session('raw-sse-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
    });
    const active = {
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: '22222222-2222-4222-8222-222222222222',
      sessionToken: 'token-1',
      apiUrl: 'https://127.0.0.1:8443',
      serverTrustIdentity: 'trust-1',
    };
    const entry = {
      id: 'entry-raw-sse',
      drone_id: '33333333-3333-4333-8333-333333333333',
      drone_label: 'builder-33333333',
      role_name: 'Builder',
      message: 'same durable activity text',
      visibility: 'direct',
      recipient_drone_ids: [active.droneId],
      created_at: '2026-08-04T12:00:00.000Z',
    };
    const frame = (wakeNonce?: string) =>
      `event: log\nid: ${entry.id}\ndata: ${JSON.stringify({ entry: {
        ...entry,
        ...(wakeNonce === undefined ? {} : { wake_nonce: wakeNonce }),
      } })}\n\n`;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(rawSseResponse([
        frame(),
        frame('wake-nonce-1'),
        frame('wake-nonce-2'),
      ]))
      .mockResolvedValueOnce(rawSseResponse([frame('wake-nonce-1')]));
    const appendLine = vi.fn(async () => {});
    const injectDeps = {
      fetchImpl: fetchImpl as typeof fetch,
      getCursor: vi.fn(async () => null),
      appendLine,
      hasInboxEntryId: vi.fn(async () => true),
      hasPendingWakeEntry: vi.fn(async () => true),
      settleOpenCodeEntry: vi.fn(),
      injectOpenCode: injectOpenCodeEntry,
      wakeCodex: vi.fn(),
      heartbeatTimeoutMs: 500,
      hwmDivergenceGraceMs: 10,
    };

    await connect();
    await injectInitialKickoff(launch);
    await streamOnce(active, null, vi.fn(), injectDeps);

    // Model an MCP-child restart: in-memory delivery history is gone, while the
    // launch binding and OpenCode session messages remain durable.
    disconnectOpenCodeDrone();
    await connect();
    await streamOnce(active, entry.id, vi.fn(), injectDeps);

    const submittedTexts = api.promptBodies.map((body) =>
      ((body.parts as Array<{ text: string }>)[0]?.text)
    );
    expect(submittedTexts).toHaveLength(1);
    expect(new Set(submittedTexts).size).toBe(1);
    expect(submittedTexts.every((text) => !text.includes('borg-wake-nonce'))).toBe(true);
    expect(api.promptBodies.map((body) => {
      const parts = body.parts as Array<{ metadata?: Record<string, unknown> }>;
      return parts[0]?.metadata?.[OPENCODE_WAKE_IDENTITY_METADATA_KEY];
    })).toEqual(['entry-raw-sse']);
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine.mock.calls[0]?.[2]).not.toContain('borg-wake-nonce');
  });

  it('exposes delivered-unconfirmed while generated-message confirmation is pending', async () => {
    const launch = launchKickoff('unconfirmed-state');
    const root = session('unconfirmed-root', 10);
    let lookupCount = 0;
    let releaseConfirmation!: (response: Response) => void;
    const confirmation = new Promise<Response>((resolve) => {
      releaseConfirmation = resolve;
    });
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: ({ promptBodies, messages }) => {
        if (promptBodies.length === 0) {
          return new Response(JSON.stringify(messages), { status: 200 });
        }
        lookupCount++;
        return lookupCount === 1
          ? confirmation
          : new Response(JSON.stringify(messages), { status: 200 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry('pending confirmation', 'entry-unconfirmed');
    expect(getOpenCodeConnectionState().deliveryStates.queued).toBe(1);
    await vi.waitFor(() => expect(api.promptBodies).toHaveLength(1));
    expect(getOpenCodeConnectionState().deliveryStates).toEqual({
      queued: 0,
      'delivered-unconfirmed': 1,
      retried: 0,
      failed: 0,
    });

    releaseConfirmation(new Response(JSON.stringify([{
      info: { id: 'msg_000000000001generated', role: 'user' },
      parts: [{
        type: 'text',
        text: 'pending confirmation',
        metadata: {
          [OPENCODE_INJECTED_ENTRY_METADATA_KEY]: true,
          [OPENCODE_WAKE_IDENTITY_METADATA_KEY]: 'entry-unconfirmed',
        },
      }],
    }]), { status: 200 }));
    await expect(delivery).resolves.toBe(true);
  });

  it('reports stripped delivery metadata as delivered-unconfirmed', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('stripped-delivery-metadata');
    const root = session('stripped-metadata-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      messageListResponse: ({ promptBodies, messages }) => {
        if (promptBodies.length === 0) {
          return new Response(JSON.stringify(messages), { status: 200 });
        }
        return new Response(JSON.stringify([
          ...kickoffMessages(launch),
          {
            info: { id: 'msg_000000000001stripped', role: 'user' },
            parts: [{ type: 'text', text: 'metadata stripped after delivery' }],
          },
        ]), { status: 200 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry(
      'metadata stripped after delivery',
      'entry-stripped-metadata',
    );
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(api.promptBodies).toHaveLength(1);
    expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 0,
      deliveryStates: {
        'delivered-unconfirmed': 1,
        failed: 0,
      },
    });
  });

  it('retains an ambiguous submission as pending delivered-unconfirmed', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('failed-launch');
    const root = session('failed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      promptResponse: () => {
        throw new Error('connection closed after submission');
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry('wake that fails', 'entry-that-fails');
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(api.prompts).toEqual([root.id]);
    expect(getOpenCodeConnectionState()).toMatchObject({
      sessionId: root.id,
      deliveryStates: {
        'delivered-unconfirmed': 1,
        failed: 0,
      },
    });
    expect(getOpenCodeConnectionState().totalEntriesRetried).toBeGreaterThanOrEqual(3);
    await expect(
      injectOpenCodeEntry('wake that fails', 'entry-that-fails'),
    ).resolves.toBe(true);
    expect(api.prompts).toEqual([root.id]);
  });

  it('exposes a definite prompt rejection as failed without retrying submission', async () => {
    const launch = launchKickoff('failed-launch');
    const root = session('failed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      promptStatus: { [root.id]: 500 },
    });

    await connect();
    await injectInitialKickoff(launch);
    await expect(
      injectOpenCodeEntry('wake that is rejected', 'entry-that-is-rejected'),
    ).resolves.toBe(false);

    expect(api.prompts).toEqual([root.id]);
    const failedState = getOpenCodeConnectionState();
    expect(failedState).toMatchObject({
      sessionId: root.id,
      totalEntriesRetried: 0,
      lastInjectionResult: 'failed',
      lastAcceptedEntryId: null,
      lastFailureCode: 'transient',
      deliveryStates: {
        'delivered-unconfirmed': 0,
        failed: 1,
      },
    });
    const status = renderStreamStatus({
      status: {
        connected: true,
        lastWireActivityAt: '2026-08-23T12:00:00.000Z',
        lastContentEventAt: '2026-08-23T12:00:00.000Z',
        lastHeartbeatAt: '2026-08-23T12:00:00.000Z',
        lastPersistedEventId: 'entry-that-is-rejected',
        reconnectAttempts: 0,
        runLoopRestartCount: 0,
        ownership: { state: 'owner' },
      },
      inboxMonitorHealthy: false,
      wakePath: {
        agentKind: 'opencode',
        healthy: openCodeWakePathHealthy(failedState),
        openCode: failedState,
      },
      inboxPath: '/tmp/inbox.log',
      droneLabel: 'builder-1',
      cubeName: 'cube-1',
      humanAgo: () => '1s ago',
    });
    expect(status.split('\n')[0]).toBe('**Stream connected (OpenCode delivery degraded).**');
    expect(status).toContain('- **OpenCode failed**: 1');
    expect(status).toContain('`borg_read-log unread_only=true`');
  });

  it('reports an unauthorized prompt rejection with no accepted entry', async () => {
    const launch = launchKickoff('unauthorized-prompt');
    const root = session('unauthorized-prompt-root', 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      promptStatus: { [root.id]: 401 },
    });

    await connect();
    await injectInitialKickoff(launch);
    await expect(injectOpenCodeEntry('unauthorized wake', 'unauthorized-entry')).resolves.toBe(false);

    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionResult: 'failed',
      lastAcceptedEntryId: null,
      lastFailureCode: 'unauthorized',
    });
  });

  it('clears failed retry identities when their durable source entry is consumed', async () => {
    const launch = launchKickoff('settled-failure-launch');
    const root = session('settled-failure-root', 10);
    installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      promptStatus: { [root.id]: 500 },
    });

    await connect();
    await injectInitialKickoff(launch);
    await expect(injectOpenCodeEntry(
      'wake retry',
      'wake-nonce-failed',
      true,
      'entry-consumed',
    )).resolves.toBe(false);
    expect(getOpenCodeConnectionState().deliveryStates.failed).toBe(1);

    settleOpenCodeEntry('entry-consumed');

    expect(getOpenCodeConnectionState().deliveryStates.failed).toBe(0);
  });

  it('reconciles visibility after the initial confirmation budget without resubmitting', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('post-acceptance-loss');
    const root = session('loss-root', 10);
    const promptBodies: Array<Record<string, unknown>> = [];
    const storedParts: unknown[] = [];
    let visibleAt = Number.POSITIVE_INFINITY;
    let messageListCount = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;

      if (path === '/session') {
        return new Response(JSON.stringify([root]), { status: 200 });
      }
      if (path === `/session/${root.id}/message`) {
        messageListCount++;
        const messages = kickoffMessages(launch);
        if (promptBodies.length > 0 && Date.now() >= visibleAt) {
          messages.push({
            info: { id: 'msg_000000000001generated', role: 'user', time: { created: Date.now() } },
            parts: storedParts,
          });
        }
        return new Response(JSON.stringify(messages), { status: 200 });
      }
      if (path === `/session/${root.id}`) {
        return new Response(JSON.stringify(root), { status: 200 });
      }
      if (path === `/session/${root.id}/prompt_async`) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        promptBodies.push(body);
        storedParts.push(...(Array.isArray(body.parts) ? body.parts : []));
        if (!Number.isFinite(visibleAt)) visibleAt = Date.now() + 6_000;
        throw new Error('connection reset after OpenCode accepted the prompt');
      }
      throw new Error(`Unhandled OpenCode API request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry(
      'wake after acceptance',
      'entry-post-acceptance-loss',
    );
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(delivery).resolves.toBe(true);

    expect(promptBodies).toHaveLength(1);
    expect(getOpenCodeConnectionState().deliveryStates).toMatchObject({
      'delivered-unconfirmed': 1,
      failed: 0,
    });
    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionResult: 'delivered-unconfirmed',
      lastAcceptedEntryId: null,
      lastFailureCode: 'transient',
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(getOpenCodeConnectionState()).toMatchObject({
      totalEntriesInjected: 1,
      lastInjectionResult: 'delivered',
      lastAcceptedEntryId: 'entry-post-acceptance-loss',
      lastFailureCode: null,
      deliveryStates: {
        queued: 0,
        'delivered-unconfirmed': 0,
        retried: 0,
        failed: 0,
      },
    }));

    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0]).not.toHaveProperty('messageID');
    expect(storedParts).toHaveLength(1);
    expect((storedParts[0] as { metadata?: Record<string, unknown> }).metadata?.[
      OPENCODE_INJECTED_ENTRY_METADATA_KEY
    ]).toBe(true);
    expect((storedParts[0] as { metadata?: Record<string, unknown> }).metadata?.[
      OPENCODE_WAKE_IDENTITY_METADATA_KEY
    ]).toBe('entry-post-acceptance-loss');
    expect(messageListCount).toBeGreaterThanOrEqual(4);
  });

  it('keeps every last-delivery field on the newer observation when an older reconciliation finishes late', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('out-of-order-reconciliation');
    const root = session('out-of-order-root', 10);
    let olderReconciliationFailed = false;
    const injectedMessage = (body: Record<string, unknown>, id: string) => ({
      info: { id: `message-${id}`, role: 'user' },
      parts: body.parts,
    });
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch) },
      promptResponse: ({ attempt }) => {
        if (attempt === 1) return Promise.reject(new Error('connection reset after acceptance'));
        return new Response(attempt === 3 ? '' : null, { status: attempt === 3 ? 401 : 204 });
      },
      messageListResponse: ({ promptBodies, messages }) => {
        if (promptBodies.length < 2) {
          return new Response(JSON.stringify(messages), { status: 200 });
        }
        const newer = injectedMessage(promptBodies[1], 'newer');
        if (promptBodies.length === 2) {
          return new Response(JSON.stringify([...messages, newer]), { status: 200 });
        }
        if (!olderReconciliationFailed) {
          olderReconciliationFailed = true;
          return new Response('temporarily unavailable', { status: 503 });
        }
        return new Response(JSON.stringify([
          ...messages,
          newer,
          injectedMessage(promptBodies[0], 'older'),
        ]), { status: 200 });
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const older = injectOpenCodeEntry('older wake', 'older-entry');
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(older).resolves.toBe(true);
    await expect(injectOpenCodeEntry('newer wake', 'newer-entry')).resolves.toBe(true);
    await expect(injectOpenCodeEntry('newest rejected wake', 'newest-entry')).resolves.toBe(false);

    const newerState = getOpenCodeConnectionState();
    expect(newerState).toMatchObject({
      lastInjectionResult: 'failed',
      lastAcceptedEntryId: 'newer-entry',
      lastFailureCode: 'unauthorized',
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionAt: newerState.lastInjectionAt,
      lastInjectionResult: 'failed',
      lastAcceptedEntryId: 'newer-entry',
      lastFailureCode: 'unauthorized',
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(getOpenCodeConnectionState()).toMatchObject({
      lastInjectionAt: newerState.lastInjectionAt,
      lastInjectionResult: 'failed',
      lastAcceptedEntryId: 'newer-entry',
      lastFailureCode: 'unauthorized',
      deliveryStates: { 'delivered-unconfirmed': 0 },
    });
    expect(api.promptBodies).toHaveLength(3);
  });
});
