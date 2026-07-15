import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetOpenCodeDroneForTests,
  connectOpenCodeDrone,
  createOpenCodeLaunchKickoff,
  disconnectOpenCodeDrone,
  getOpenCodeConnectionState,
  injectInitialKickoff,
  injectOpenCodeEntry,
} from '../src/opencode-drone';

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

function installOpenCodeApi(options: {
  sessions: () => Session[];
  messages?: Record<string, unknown[]>;
  missing?: Set<string>;
  promptStatus?: Record<string, number>;
}) {
  const prompts: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const id = path.match(/^\/session\/([^/]+)(?:\/([^/]+))?$/)?.[1];
    const suffix = path.match(/^\/session\/[^/]+\/(.+)$/)?.[1];

    if (path === '/session') {
      return new Response(JSON.stringify(options.sessions()), { status: 200 });
    }
    if (id && suffix === 'message') {
      return new Response(JSON.stringify(options.messages?.[id] ?? []), { status: 200 });
    }
    if (id && suffix === 'prompt_async') {
      prompts.push(id);
      const status = options.promptStatus?.[id] ?? 204;
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
  return { prompts, fetchMock };
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

  it('clears a stale cached ID after an injection failure', async () => {
    const launch = launchKickoff('failed-launch');
    const root = session('failed-root', 10);
    const api = installOpenCodeApi({
      sessions: () => [root],
      messages: { [root.id]: kickoffMessages(launch.prompt) },
      promptStatus: { [root.id]: 500 },
    });

    await connect();
    await injectInitialKickoff(launch);
    await expect(injectOpenCodeEntry('wake that fails')).resolves.toBe(false);

    expect(api.prompts).toEqual([root.id]);
    expect(getOpenCodeConnectionState().sessionId).toBeNull();
  });
});
