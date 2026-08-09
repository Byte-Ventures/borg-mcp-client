import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOpenCodeDroneForTests,
  allocateOpenCodePort,
  configuredOpenCodePort,
  computeOpenCodePort,
  connectOpenCodeDrone,
  createOpenCodeLaunchKickoff,
  disconnectOpenCodeDrone,
  getOpenCodeConnectionState,
  injectInitialKickoff,
  injectOpenCodeEntry,
  OPEN_CODE_PORT_MISSING_DIAGNOSTIC,
} from '../src/opencode-drone';
import { streamOnce } from '../src/log-stream';
import { OPENCODE_INJECTED_ENTRY_METADATA_KEY } from '../src/opencode-plugin';

const DIRECTORY = '/repo';
const SERVER_URL = 'http://127.0.0.1:15113';
const KICKOFF = 'Call borg_regen and follow the playbook.';

interface Session {
  id: string;
  directory: string;
  time: { created: number };
  parentID?: string;
}

function session(id: string, created: number, parentID?: string): Session {
  return { id, directory: DIRECTORY, time: { created }, ...(parentID ? { parentID } : {}) };
}

function launchKickoff(nonce: string) {
  return createOpenCodeLaunchKickoff(KICKOFF, nonce);
}

function kickoffMessages(kickoff: string, created = Date.now()) {
  return [{
    info: { role: 'user', time: { created } },
    parts: [{ type: 'text', text: kickoff }],
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
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }
    throw new Error(`Unhandled OpenCode API request: ${init?.method ?? 'GET'} ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { prompts, promptBodies, fetchMock };
}

async function connect(droneLabel = 'drone-7') {
  await connectOpenCodeDrone({
    serverUrl: SERVER_URL,
    directory: DIRECTORY,
    droneLabel,
    cubeName: 'borg-mcp',
  });
}

describe('OpenCode wake target binding', () => {
  beforeEach(() => {
    __resetOpenCodeDroneForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetOpenCodeDroneForTests();
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

  it('adds a unique launch nonce without changing the shared kickoff text', () => {
    const first = createOpenCodeLaunchKickoff(KICKOFF);
    const second = createOpenCodeLaunchKickoff(KICKOFF);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.prompt).toContain(KICKOFF);
    expect(first.prompt).toContain(`<!-- borg-opencode-correlation:${first.nonce} -->`);
    expect(KICKOFF).toBe('Call borg_regen and follow the playbook.');
  });

  it('binds a fresh launch to the kickoff-owning root session, not a newer child', async () => {
    const launch = launchKickoff('fresh-launch');
    const root = session('fresh-root', 10);
    const child = session('newer-child', 20, root.id);
    const api = installOpenCodeApi({
      sessions: () => [root, child],
      messages: { [root.id]: kickoffMessages(launch.prompt), [child.id]: [] },
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
        // timestamp grace window. Its shared text is identical, but its nonce
        // proves it belongs to a different OpenCode launch.
        [previous.id]: kickoffMessages(previousLaunch.prompt, now - 2_000),
        get [current.id]() {
          return currentPromptVisible ? kickoffMessages(currentLaunch.prompt, now) : [];
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
      messages: { [root.id]: kickoffMessages(launch.prompt), [newerUnrelated.id]: [] },
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
      messages: { [root.id]: [], [fork.id]: kickoffMessages(launch.prompt) },
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
      messages: { [root.id]: kickoffMessages(launch.prompt), [child.id]: [] },
    });

    await connect();
    await injectInitialKickoff(launch);
    disconnectOpenCodeDrone();
    await connect();
    await injectOpenCodeEntry('wake from MCP child');

    expect(api.prompts).toEqual([root.id]);
  });

  it('rebinds to a newer top-level session after the user switches with /new', async () => {
    const launch = launchKickoff('switch-launch');
    const initial = session('initial-root', 10);
    const switched = session('switched-root', 20);
    let sessions = [initial];
    const api = installOpenCodeApi({
      sessions: () => sessions,
      messages: { [initial.id]: kickoffMessages(launch.prompt), [switched.id]: [] },
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
      messages: { [root.id]: kickoffMessages(launch.prompt), [child.id]: [] },
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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

  it('confirms a delayed prior-process submission on replay without posting again', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('prior-process-replay');
    const root = session('prior-process-root', 10);
    const visibleAt = Date.now() + 500;
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: {
        [root.id]: [
          ...kickoffMessages(launch.prompt),
          {
            info: { id: 'msg_000000000001prior', role: 'user' },
            parts: [{ type: 'text', text: 'persisted by prior process' }],
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
    expect(api.promptBodies.every((body) => {
      const parts = body.parts as Array<{ text: string; metadata?: Record<string, unknown> }>;
      return parts.length === 1
        && parts[0]?.metadata?.[OPENCODE_INJECTED_ENTRY_METADATA_KEY] === true;
    })).toBe(true);
    expect(api.promptBodies.every((body) => !Object.hasOwn(body, 'messageID'))).toBe(true);
  });

  it('submits once per distinct wake nonce from raw SSE and deduplicates the nonce after reconnect', async () => {
    const launch = launchKickoff('raw-sse-wake-nonce');
    const root = session('raw-sse-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
    expect(submittedTexts).toHaveLength(3);
    expect(submittedTexts[0]).not.toContain('borg-wake-nonce');
    expect(submittedTexts[1]).toContain('<!-- borg-wake-nonce:wake-nonce-1 -->');
    expect(submittedTexts[2]).toContain('<!-- borg-wake-nonce:wake-nonce-2 -->');
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
      messages: { [root.id]: kickoffMessages(launch.prompt) },
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
      parts: [{ type: 'text', text: 'pending confirmation' }],
    }]), { status: 200 }));
    await expect(delivery).resolves.toBe(true);
  });

  it('retains an ambiguous submission as terminal delivered-unconfirmed', async () => {
    vi.useFakeTimers();
    const launch = launchKickoff('failed-launch');
    const root = session('failed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch.prompt) },
      promptResponse: () => {
        throw new Error('connection closed after submission');
      },
    });

    await connect();
    await injectInitialKickoff(launch);
    const delivery = injectOpenCodeEntry('wake that fails', 'entry-that-fails');
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(false);

    expect(api.prompts).toEqual([root.id]);
    expect(getOpenCodeConnectionState()).toMatchObject({
      sessionId: root.id,
      totalEntriesRetried: 3,
      deliveryStates: {
        'delivered-unconfirmed': 1,
        failed: 0,
      },
    });
    await expect(
      injectOpenCodeEntry('wake that fails', 'entry-that-fails'),
    ).resolves.toBe(false);
    expect(api.prompts).toEqual([root.id]);
  });

  it('exposes a definite prompt rejection as failed without retrying submission', async () => {
    const launch = launchKickoff('failed-launch');
    const root = session('failed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch.prompt) },
      promptStatus: { [root.id]: 500 },
    });

    await connect();
    await injectInitialKickoff(launch);
    await expect(
      injectOpenCodeEntry('wake that is rejected', 'entry-that-is-rejected'),
    ).resolves.toBe(false);

    expect(api.prompts).toEqual([root.id]);
    expect(getOpenCodeConnectionState()).toMatchObject({
      sessionId: root.id,
      totalEntriesRetried: 0,
      deliveryStates: {
        'delivered-unconfirmed': 0,
        failed: 1,
      },
    });
  });

  it('waits for delayed post-acceptance visibility without resubmitting', async () => {
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
        const messages = kickoffMessages(launch.prompt);
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
        if (!Number.isFinite(visibleAt)) visibleAt = Date.now() + 500;
        return new Response(null, { status: 204 });
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
    await vi.runAllTimersAsync();
    await expect(delivery).resolves.toBe(true);

    expect(promptBodies).toHaveLength(1);
    expect(promptBodies[0]).not.toHaveProperty('messageID');
    expect(storedParts).toHaveLength(1);
    expect((storedParts[0] as { metadata?: Record<string, unknown> }).metadata?.[
      OPENCODE_INJECTED_ENTRY_METADATA_KEY
    ]).toBe(true);
    expect(messageListCount).toBeGreaterThanOrEqual(4);
  });
});
