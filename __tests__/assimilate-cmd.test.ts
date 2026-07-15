import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAssimilate, safeStderr, type AssimilateDeps } from '../src/assimilate-cmd';
import { BorgServerError } from '../src/server-errors';
import { DroneEvictedError } from '../src/drone-lifecycle';

const openCodeDroneMocks = vi.hoisted(() => ({
  computeOpenCodePort: vi.fn(() => 15555),
  connectOpenCodeDrone: vi.fn(async () => {}),
  createOpenCodeLaunchKickoff: vi.fn((kickoff: string) => ({
    prompt: `${kickoff}\n\n<!-- borg-opencode-correlation:nonce-for-test -->`,
    nonce: 'nonce-for-test',
  })),
  injectInitialKickoff: vi.fn(async () => true),
}));
const mcpConfigMocks = vi.hoisted(() => ({
  ensureCliMcpConfigured: vi.fn(),
}));
const SERVER_TRUST_IDENTITY = 'spki-sha256:test-server';

vi.mock('../src/opencode-drone.js', () => openCodeDroneMocks);
vi.mock('../src/opencode-plugin.js', () => ({ installBorgPlugin: vi.fn() }));
vi.mock('../src/ensure-mcp-config.js', () => mcpConfigMocks);

beforeEach(() => {
  mcpConfigMocks.ensureCliMcpConfigured.mockReset();
});

function makeStubDeps(overrides: Partial<AssimilateDeps> = {}): AssimilateDeps {
  return {
    runSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
    pathExists: vi.fn(() => false),
    cwd: vi.fn(() => '/work/myrepo'),
    stderr: vi.fn(),
    stdout: vi.fn(),
    prompt: vi.fn(async () => '1'),
    promptSecret: vi.fn(async () => 'i'.repeat(43)),
    isTTY: () => true,
    chdir: vi.fn(),
    homedir: vi.fn(() => '/home/test'),
    mkdirp: vi.fn(),
    exec: vi.fn(async () => 0),
    getHostname: vi.fn(() => 'test-host.local'),
    setTerminalTitle: vi.fn(),
    getActiveCube: vi.fn(async () => null),
    setActiveCube: vi.fn(async () => {}),
    findProjectRoot: vi.fn(() => '/work/myrepo'),
    installProjectSessionHook: vi.fn(),
    getCachedAuth: vi.fn(async () => ({ token: 'test-token', apiUrl: 'http://api.test' })),
    runSetup: vi.fn(async () => ({ token: 'fresh-token', apiUrl: 'http://api.test' })),
    cloudApiUrl: 'http://api.test',
    detectLocalServer: vi.fn(async () => null),
    connectServer: vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    })),
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(async () => { throw new Error('not called in this scenario'); }),
    createCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
      { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
    ]})),
    assimilate: vi.fn(async (_apiUrl, _token, _params, serverTrustIdentity) => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      role_id: 'role-default',
      ...(serverTrustIdentity === undefined
        ? { session_token: 'sess' }
        : {
          local_session: {
            credential_ref: 'borg-server-session:' + 'a'.repeat(64),
            generation: 1,
            expires_at: '2026-07-14T16:00:00.000Z',
          },
        }),
    })),
    listTemplates: vi.fn(async () => [
      { name: 'software-dev', description: 'Coordinator, Builder, Code Reviewer, QA, UX, Security' },
    ]),
    getInboxPath: vi.fn((c: string, d: string) => `/tmp/test-inbox/${c}/${d}.log`),
    probeMcpReady: vi.fn(async () => true),
    resolveCli: vi.fn(async (explicit) => explicit ?? 'claude'),
    prepareCodexRemoteLaunch: vi.fn(async () => ({ args: ['--remote', 'unix:///tmp/codex.sock'], env: { BORG_CODEX_REMOTE_WAKE: '1' } })),
    setCodexWakeTarget: vi.fn(async () => {}),
    findLoadedCodexThread: vi.fn(async () => 'thread-123'),
    ...overrides,
  };
}

// Sprint 4 / gh#147 — defense-in-depth control-char strip from subprocess stderr.
describe('safeStderr (Sprint 4 / gh#147)', () => {
  it('strips embedded ANSI escape sequences', () => {
    // Cursor-move + clear-screen escape — would corrupt the operator's terminal.
    const malicious = 'fatal: \x1b[2Joops';
    expect(safeStderr(malicious)).toBe('fatal: [2Joops');
  });

  it('strips NUL byte', () => {
    expect(safeStderr('a\x00b')).toBe('ab');
  });

  it('strips DEL (0x7F)', () => {
    expect(safeStderr('a\x7Fb')).toBe('ab');
  });

  it('strips all C0 control chars (\\x00 through \\x1F)', () => {
    // Build a string containing every C0 control char + visible chars.
    let s = 'a';
    for (let i = 0; i < 0x20; i++) s += String.fromCharCode(i);
    s += 'b';
    expect(safeStderr(s)).toBe('ab');
  });

  it('passes printable ASCII through unchanged', () => {
    // No over-strip on the common case — git stderr is mostly punctuation+letters.
    const benign = 'fatal: not a valid object name: HEAD (no commits yet)';
    expect(safeStderr(benign)).toBe(benign);
  });
});

describe('runAssimilate: scaffolding', () => {
  it('returns exit code 0 on a stubbed happy path', async () => {
    const deps = makeStubDeps();
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
  });
});

// gh#653 B4: the listCubes/createCube/assimilate round-trips take 2–5s and
// were silent, so a user read the wait as a hang and Ctrl-C'd mid-run. Each
// step now announces itself. (The dup-creation guard B4 originally proposed
// was redundant — cubes have UNIQUE(owner_id,name) + a client pre-create
// existence check — so B4 is progress-output only.)
describe('runAssimilate: progress output (gh#653 B4)', () => {
  it('first-drone path announces checking + creating + joining', async () => {
    const stderr = vi.fn();
    // default stub: listCubes [] → createCube path; cubeName derives to 'myrepo'
    const deps = makeStubDeps({ stderr });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('Checking your cubes');
    // create message has two forms: named ("Creating cube '<n>'…") when the
    // cube name is derivable, else the bare fallback ("Creating your cube…")
    expect(text).toMatch(/Creating (cube '|your cube)/);
    expect(text).toContain('Joining cube');
  });

  it('existing-cube path announces checking + joining but NOT creating', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      // git remote → cube name derives to 'myrepo' so it matches the existing
      // cube below (cube-name derivation reads the remote, like the other tests)
      runSync: vi.fn((cmd: string, args: string[]) =>
        args[0] === 'remote'
          ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
          : { status: 0, stdout: '', stderr: '' }
      ),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'c', name: 'myrepo',
        roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }],
      })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    const text = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('Checking your cubes');
    expect(text).toContain('Joining cube');
    expect(text).not.toContain('Creating'); // existing cube → no create round-trip
  });
});

describe('runAssimilate: step 8 (launch Claude Code)', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('ensures borg MCP registration for the selected %s CLI before launch', async (cli) => {
    const exec = vi.fn(async () => 0);
    const probeMcpReady = vi.fn(async () => true);
    const deps = makeStubDeps({ exec, probeMcpReady });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, cli } }, deps)).resolves.toBe(0);

    expect(mcpConfigMocks.ensureCliMcpConfigured).toHaveBeenCalledWith(cli);
    expect(mcpConfigMocks.ensureCliMcpConfigured).toHaveBeenCalledBefore(probeMcpReady);
    expect(exec).toHaveBeenCalledWith(cli, expect.any(Array), '/work/myrepo', expect.any(Object));
  });

  it('fails before minting a seat when selected-CLI MCP configuration cannot be ensured', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-x', drone_label: 'drone-1', session_token: 'sess', role_id: 'role-default',
    }));
    const exec = vi.fn(async () => 0);
    const probeMcpReady = vi.fn(async () => true);
    mcpConfigMocks.ensureCliMcpConfigured.mockImplementationOnce(() => {
      throw new Error('opencode CLI not found');
    });
    const deps = makeStubDeps({ assimilate, exec, probeMcpReady });

    await expect(runAssimilate({ role: undefined, flags: { yes: true, cli: 'opencode' } }, deps)).resolves.toBe(1);

    expect(deps.stderr).toHaveBeenCalledWith('opencode MCP configuration failed: opencode CLI not found\n');
    expect(assimilate).not.toHaveBeenCalled();
    expect(probeMcpReady).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('execs Claude Code at the (post-chdir) project root and sets terminal title', async () => {
    const exec = vi.fn(async () => 0);
    const setTerminalTitle = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, setTerminalTitle, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    expect(setTerminalTitle).toHaveBeenCalledWith('drone-1', 'myrepo');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), '/work/myrepo', expect.objectContaining({ BORG_SESSION: '1' }));
  });

  // CR-PE-F1 regression (drone-2 Phase E review 2026-05-18T04:59Z):
  // kickoff prompt must include the borg-inbox-monitor clause so the
  // new drone wakes on peer log entries during bootstrap. Without
  // this, freshly-assimilated drones miss real-time wake events and
  // self-heal only at the /loop heartbeat.
  it('Claude kickoff passes an explicit worktree-local monitor root with the new drone inbox path', async () => {
    const exec = vi.fn(async () => 0);
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1', drone_id: 'drone-uuid-1', drone_label: 'drone-2', session_token: 's', role_id: 'r',
    }));
    const getInboxPath = vi.fn((c: string, d: string) => `/test-inboxes/${c}/${d}.log`);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, assimilate, getInboxPath, runSync,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(getInboxPath).toHaveBeenCalledWith('cube-1', 'drone-uuid-1');
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[])[0];
    expect(kickoff).toContain('borg-inbox-monitor --state-root');
    expect(kickoff).toContain('/work/myrepo/.borgmcp/inbox-monitor');
    expect(kickoff).toContain('/test-inboxes/cube-1/drone-uuid-1.log');
    expect(kickoff).not.toContain('borg-opencode-correlation:');
  });

  it('adds the nonce only to the OpenCode launch prompt', async () => {
    openCodeDroneMocks.createOpenCodeLaunchKickoff.mockClear();
    openCodeDroneMocks.injectInitialKickoff.mockClear();
    const exec = vi.fn(async () => 0);
    const deps = makeStubDeps({ exec });

    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'opencode' } }, deps);
    await Promise.resolve();

    expect(exec).toHaveBeenCalledWith('opencode', expect.any(Array), '/work/myrepo', expect.any(Object));
    const launchArgs = exec.mock.calls[0][1] as string[];
    const promptIndex = launchArgs.indexOf('--prompt');
    const openCodePrompt = launchArgs[promptIndex + 1];
    expect(openCodePrompt).toContain('Call borg_regen and follow the playbook');
    expect(openCodePrompt).toContain('<!-- borg-opencode-correlation:nonce-for-test -->');
    expect(openCodeDroneMocks.createOpenCodeLaunchKickoff).toHaveBeenCalledWith(
      expect.not.stringContaining('borg-opencode-correlation:'),
    );
    expect(openCodeDroneMocks.injectInitialKickoff).toHaveBeenCalledWith({
      prompt: openCodePrompt,
      nonce: 'nonce-for-test',
    });
  });

  // BUG-5 / v0.9.3 regression (drone-1 DISPATCH-FIX 2026-05-18T11:43Z):
  // kickoff prompt must telegraph the exact ToolSearch syntax + the three
  // bootstrap tool names so the launched session can recover from the
  // MCP-startup race deterministically (per drone-7 UX-FEEDBACK 11:42:38Z).
  it('kickoff prompt contains exact ToolSearch query + 3 bootstrap tool names (BUG-5 fix)', async () => {
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[])[0];
    expect(kickoff).toContain('ToolSearch({query: "select:');
    expect(kickoff).toContain('mcp__borg__borg_regen');
    expect(kickoff).toContain('mcp__borg__borg_log');
    expect(kickoff).toContain('Monitor');
    expect(kickoff).toContain('max_results: 3');
  });

  // Pedagogical welcome block emitted to stdout before
  // `claude` exec so it lands in the user's terminal scrollback above
  // Claude Code's interactive UI (Ink does not enter alt-screen-buffer per
  // 2026-05-19 PTY probe). Cube-agnostic shape — same render path for all
  // role/cube names per drone-9 UX-LENS refinement.
  it('emits cube-agnostic welcome block to stdout before claude launch', async () => {
    const exec = vi.fn(async () => 0);
    const stdout = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stdout, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'coordinator', is_default: true, is_human_seat: true }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stdoutPayload = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutPayload).toContain('Joined as');
    expect(stdoutPayload).toContain('coordinator');
    expect(stdoutPayload).toContain('myrepo');
    expect(stdoutPayload).toContain('borg_regen');
    expect(stdoutPayload).toContain('borg_regen');
    expect(stdoutPayload).toContain('You\'re set up');
    // Welcome must be emitted before claude exec so it lands above the TUI.
    const stdoutCallOrder = stdout.mock.invocationCallOrder[0];
    const execCallOrder = exec.mock.invocationCallOrder[0];
    expect(stdoutCallOrder).toBeLessThan(execCallOrder);
  });

  it('welcome block renders for any role.name (cube-agnostic; no mapping table)', async () => {
    // Confirms the cube-portability invariant: a custom-template role
    // (e.g. "fact-checker" in a writers-room cube) renders the same shape
    // as software-dev roles. Closes Sprint 14 cube-template-portability
    // contract at the welcome-render layer.
    const exec = vi.fn(async () => 0);
    const stdout = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/writers-room.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stdout, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'writers-room' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'writers-room', roles: [{ id: 'r', name: 'fact-checker', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: 'fact-checker', flags: { yes: true } }, deps);
    const stdoutPayload = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutPayload).toContain('fact-checker');
    expect(stdoutPayload).toContain('writers-room');
    expect(stdoutPayload).toContain('borg_regen');
  });

  // BUG-5 / v0.9.3 regression: orchestrator probes MCP readiness before
  // launching claude. Probe success → silent fast-path; probe failure
  // → stderr warning + still-exec (never blocks).
  it('probeMcpReady success → silent fast-path (no warning)', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const probeMcpReady = vi.fn(async () => true);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stderr, probeMcpReady, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(probeMcpReady).toHaveBeenCalled();
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain('readiness probe');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(String), expect.objectContaining({ BORG_SESSION: '1' }));
  });

  it('probeMcpReady failure → stderr warning + still-exec (never blocks)', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const probeMcpReady = vi.fn(async () => false);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, stderr, probeMcpReady, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('readiness probe');
    expect(stderrCalls).toContain('launching claude anyway');
    expect(exec).toHaveBeenCalledWith('claude', expect.any(Array), expect.any(String), expect.objectContaining({ BORG_SESSION: '1' }));
  });

  it('installs the project-local SessionStart hook at the launch root (gh#673 P2)', async () => {
    const installProjectSessionHook = vi.fn();
    const deps = makeStubDeps({
      installProjectSessionHook,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(0);
    // agentCwd = deps.cwd() at launch time — the spawned worktree
    // (post-chdir) or the in-place root; either way the hook lands in
    // the directory the agent will run from.
    expect(installProjectSessionHook).toHaveBeenCalledWith('/work/myrepo');
  });

  it('a hook-install failure never blocks the assimilate (best-effort + launcher re-ensure)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      installProjectSessionHook: vi.fn(() => {
        throw new Error('EACCES');
      }),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(0);
    const text = (stderr.mock.calls as unknown as string[][]).map((c) => c[0]).join('');
    expect(text).toContain('project-local SessionStart hook');
  });

  it('supports launching Codex through remote-control wake mode', async () => {
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'codex' } }, deps);
    // The launched session carries activation, a durable CLI identity, and
    // the remote-wake transport flag as distinct markers.
    // Note: env now includes full process.env (for gotcha#1 ANTHROPIC_API_KEY removal);
    // use objectContaining to assert the required keys without requiring an exact match.
    expect(exec).toHaveBeenCalledWith('codex', expect.any(Array), expect.any(String), expect.objectContaining({
      BORG_AGENT_KIND: 'codex',
      BORG_CODEX_REMOTE_WAKE: '1',
      BORG_SESSION: '1',
    }));
    const [, kickoffArgs] = exec.mock.calls[0];
    // Codex MCP children only receive pinned `-c` env. Verify session,
    // identity, and transport are all independently present before the TUI
    // remote arguments and kickoff positional.
    expect(kickoffArgs).toEqual(expect.arrayContaining([
      '-c', 'mcp_servers.borg.env.BORG_SESSION="1"',
      '-c', 'mcp_servers.borg.env.BORG_AGENT_KIND="codex"',
      '-c', 'mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"',
      '--remote', 'unix:///tmp/codex.sock',
      '--cd', '/work/myrepo',
    ]));
    const kickoff = (kickoffArgs as string[]).at(-1) as string;
    expect(kickoff.startsWith('/loop')).toBe(false);
    expect(kickoff).toContain('Codex wake-path capability check passed');
    expect(kickoff).toContain('Call borg_regen and follow the playbook');
    expect(kickoff).not.toContain('borg-opencode-correlation:');
    expect(kickoff).not.toContain('borg-inbox-monitor');
    expect(kickoff).not.toContain('.borgmcp/inbox-monitor');
    // gh#929: the read-log-triage paragraph is stripped from the kickoff
    // (the playbook owns it); not re-injected on the codex launch path.
    expect(kickoff).not.toContain('On every Monitor wake and every ScheduleWakeup heartbeat, triage');
    expect(kickoff).not.toContain('Never reflexively call borg_regen for routine text-only wakes');
  });

  it('surfaces failed Codex remote-wake capability in the kickoff prompt', async () => {
    const exec = vi.fn(async () => 0);
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      exec,
      stderr,
      runSync,
      prepareCodexRemoteLaunch: vi.fn(async () => ({
        args: [],
        env: {},
        warning: 'Codex remote-wake disabled: test failure',
      })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });

    await runAssimilate({ role: undefined, flags: { yes: true, cli: 'codex' } }, deps);

    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('Codex remote-wake disabled');
    const [, kickoffArgs] = exec.mock.calls[0];
    const kickoff = (kickoffArgs as string[]).at(-1) as string;
    expect(kickoff).toContain('Codex wake-path capability check failed');
    expect(kickoff).toContain('Run borg_regen manually whenever you return');
    const launchEnv = exec.mock.calls[0][3] as Record<string, string | undefined>;
    expect(launchEnv.BORG_AGENT_KIND).toBe('codex');
    expect(launchEnv.BORG_CODEX_REMOTE_WAKE).toBeUndefined();
    expect(kickoffArgs).toContain('mcp_servers.borg.env.BORG_AGENT_KIND="codex"');
    expect(kickoffArgs).not.toContain('mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="1"');
    // Codex MCP children read their pinned config instead of launchEnv. A
    // no-socket fallback must therefore explicitly override an installed
    // legacy BORG_CODEX_REMOTE_WAKE="1" config rather than merely omit 1.
    expect(kickoffArgs).toContain('mcp_servers.borg.env.BORG_CODEX_REMOTE_WAKE="0"');
  });

  it('clears a stale Codex transport marker when an existing seat relaunches with Claude', async () => {
    const savedRemoteWake = process.env.BORG_CODEX_REMOTE_WAKE;
    process.env.BORG_CODEX_REMOTE_WAKE = '1';
    try {
      const exec = vi.fn(async () => 0);
      const deps = makeStubDeps({ exec });
      const exit = await runAssimilate({ role: undefined, flags: { yes: true, cli: 'claude' } }, deps);
      expect(exit).toBe(0);
      const launchEnv = exec.mock.calls[0][3] as Record<string, string | undefined>;
      expect(launchEnv.BORG_AGENT_KIND).toBe('claude');
      expect(launchEnv.BORG_CODEX_REMOTE_WAKE).toBeUndefined();
    } finally {
      if (savedRemoteWake === undefined) delete process.env.BORG_CODEX_REMOTE_WAKE;
      else process.env.BORG_CODEX_REMOTE_WAKE = savedRemoteWake;
    }
  });
});

// Sprint 19 (gh#184): assimilate flow reorder + strict rollback.
// Worktree spawn now happens AFTER API success. Assimilate API failure
// no longer creates a worktree (no rollback needed; clean early-exit).
// Worktree rollback narrows to the single setActiveCube failure path
// post-worktree-creation.
describe('runAssimilate: reattach to an EVICTED seat is refused (gh#877 follow-up)', () => {
  const sameCubeSeat = vi.fn(async () => ({ cubeId: 'c', droneId: 'd-prior', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' }));
  const cubeResolves = {
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  };

  it('a --here reattach whose saved seat was evicted (410) prints the recovery message + exits 1, no worktree created', async () => {
    const runSyncSpy = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }
    );
    const stderr = vi.fn();
    const chdir = vi.fn();
    const assimilate = vi.fn(async () => { throw new DroneEvictedError('Your previous seat in cube "myrepo" was evicted'); });
    const deps = makeStubDeps({
      ...cubeResolves, runSync: runSyncSpy, stderr, chdir, assimilate,
      getActiveCube: sameCubeSeat, // same cube → --here sets reattachPriorId = 'd-prior'
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('seat evicted'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('assimilate failed')); // not the generic path
    const worktreeAdds = runSyncSpy.mock.calls.filter((c) => c[1][0] === 'worktree' && c[1][1] === 'add');
    expect(worktreeAdds).toHaveLength(0); // clean early-exit, no resurrection FS state
  });

  it('a NON-reattach DroneEvictedError falls through to the generic "assimilate failed" message', async () => {
    const runSyncSpy = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' }
    );
    const stderr = vi.fn();
    const assimilate = vi.fn(async () => { throw new DroneEvictedError('evicted'); });
    const deps = makeStubDeps({
      ...cubeResolves, runSync: runSyncSpy, stderr, assimilate,
      getActiveCube: vi.fn(async () => null), // no existing seat → reattachPriorId null → generic branch
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('assimilate failed'));
  });
});

describe('runAssimilate: Sprint 19 (gh#184) strict-rollback semantics', () => {
  it('assimilate API failure: no worktree created (clean early-exit)', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const chdir = vi.fn();
    const assimilate = vi.fn(async () => { throw new Error('Cannot assimilate directly into a Queen-class role.'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, assimilate, chdir,
      // Force worktree-want via stale-cubes.json (no worktree should still spawn).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('assimilate failed: Cannot assimilate'));
    // No worktree-add was attempted (API failure stopped flow BEFORE worktree step).
    const worktreeAddCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
    // No chdir was performed.
    expect(chdir).not.toHaveBeenCalled();
    // No rollback needed: no worktree-remove called.
    const removeCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'remove'
    );
    expect(removeCalls).toHaveLength(0);
  });

  it('setActiveCube failure (post-worktree-spawn): rolls back the spawned worktree', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const setActiveCube = vi.fn(async () => { throw new Error('keychain write failed'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, setActiveCube,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      chdir: vi.fn(),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('setActiveCube failed: keychain write failed'));
    // Rollback called: worktree-remove on the spawned worktree path.
    const rollbackCall = runSyncSpy.mock.calls.find(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'remove'
    );
    expect(rollbackCall).toBeDefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rolled back spawned worktree'));
  });

  it('worktree-remove failure on rollback surfaces manual-cleanup hint to stderr', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'remove') return { status: 128, stdout: '', stderr: 'fatal: cannot remove' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const setActiveCube = vi.fn(async () => { throw new Error('keychain write failed'); });
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, setActiveCube,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      chdir: vi.fn(),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('manual cleanup needed'));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('git worktree remove --force'));
  });

  it('gh#184 canonical: unknown role arg → role-resolution fails → no worktree created', async () => {
    // The original gh#184 bug: `borg assimilate frobnicate` (no matching
    // role) created an orphan worktree at ~/myrepo-frobnicate/ before
    // failing on role-match. The reorder eliminates this class
    // structurally — role resolution happens BEFORE worktree spawn.
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync: runSyncSpy, stderr, chdir,
      // Trigger worktree-want via stale-cubes.json (would have created
      // worktree under pre-Sprint-19 flow).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
      ]})),
    });
    const exit = await runAssimilate({ role: 'frobnicate', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no role matching "frobnicate"'));
    // No worktree-add — gh#184 canonical assertion.
    const worktreeAddCalls = runSyncSpy.mock.calls.filter(
      (call) => call[1][0] === 'worktree' && call[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
    expect(chdir).not.toHaveBeenCalled();
  });

  it('fuzzy-match suggestion: misspelled role surfaces "Did you mean" nudge', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:Org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr,
      runSync,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    // "buidler" (lowercase typo) → Levenshtein distance 2 from "builder"
    // (case-folded comparison) → match. Suggestion returns the original
    // cube-defined "Builder" casing.
    const exit = await runAssimilate({ role: 'buidler', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('Did you mean "Builder"?');
  });

  it('fuzzy-match suggestion absent when no close match (distance > 2)', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [
        { id: 'r-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    // "xyzzy" → far from "Builder" → no suggestion.
    const exit = await runAssimilate({ role: 'xyzzy', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('no role matching "xyzzy"');
    expect(stderrCalls).not.toContain('Did you mean');
  });
});

// Sprint 18: when `borg assimilate` spawned a sibling worktree, the user's
// terminal cwd resets to the pre-spawn directory after Claude exits (the
// borg process's chdir doesn't propagate to the parent shell). Print a
// stderr nudge after exec returns so the user knows how to get back into
// the worktree.
describe('runAssimilate: Sprint 18 (post-exit shell-cd hint)', () => {
  // Build a stateful cwd/chdir pair: chdir mutates a local cell so cwd()
  // reflects the worktree path after chdir (matches real process behavior).
  function makeCwdPair(initialCwd: string): { cwd: () => string; chdir: (p: string) => void } {
    let current = initialCwd;
    return { cwd: () => current, chdir: (p: string) => { current = p; } };
  }

  it('emits post-exit hint to stderr when a sibling worktree was spawned', async () => {
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      // Trigger worktree spawn via stale active-cube (worktree branch path).
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).toContain('Agent exited');
    expect(stderrPayload).toContain('You were working in /home/test/.borg/worktrees/myrepo/drone');
    expect(stderrPayload).toContain('your shell is back in /work/myrepo');
    expect(stderrPayload).toContain('To return:');
    // Spawned worktree path appears verbatim (no <placeholder> tokens) — Sprint 15 N1 invariant.
    expect(stderrPayload).toContain('/home/test/.borg/worktrees/myrepo/drone');
    // Original cwd referenced so user can orient on where they are now.
    expect(stderrPayload).toContain('/work/myrepo');
    expect(stderrPayload).not.toContain('<spawnedWorktreePath>');
    expect(stderrPayload).not.toContain('<originalCwd>');
  });

  it('quotes the cd path with single-quotes to handle spaces + shell metachars', async () => {
    // Real-user case: macOS user with capitalized name like "Jane Doe" causes
    // the spawn path to contain a space. Bare `cd /Users/Jane Doe/...` would fail.
    // gh#556 Part 1: the worktree path now derives from homedir (~/.borg/worktrees/...),
    // so the space is injected via the homedir seam (not the parent dir).
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/Users/Jane Doe/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      homedir: () => '/Users/Jane Doe',
      findProjectRoot: () => '/Users/Jane Doe/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    // cd line uses single-quotes wrapping the path so spaces parse as one arg.
    expect(stderrPayload).toMatch(/cd '\/Users\/Jane Doe\/\.borg\/worktrees\/myrepo\/drone'/);
  });

  it('does NOT emit hint when no sibling worktree was spawned (--here-style flow)', async () => {
    // User in existing cube root → no chdir → spawnedWorktreePath is null.
    const stderr = vi.fn();
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync,
      // No existing active cube + no --worktree flag → no spawn.
      getActiveCube: vi.fn(async () => null),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).not.toContain('Session ended');
    expect(stderrPayload).not.toContain('To return to the worktree');
  });

  it('does NOT emit hint when originalCwd equals spawnedWorktreePath (defensive case)', async () => {
    // Pathological edge case drone-9 UX-LANE flagged: if for any reason
    // originalCwd happens to match the worktree path, the "you're back in X"
    // message would be confusing ("back in X; worktree is at X"). Skip the hint.
    const stderr = vi.fn();
    // Stateless cwd that always returns the same path even after chdir —
    // simulates the defensive case where the cwd doesn't actually change.
    const cwd = vi.fn(() => '/work/myrepo');
    const chdir = vi.fn();
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrPayload).not.toContain('Session ended');
  });

  it('defangs shell metachars in pathological paths (drone-11 SR-axis injection-class test)', async () => {
    // SR-axis (cube entry 10:44:35Z): paths can legally contain $VAR /
    // backticks / $(cmd). Single-quote-with-escape MUST defang every
    // shell metachar so paste-execution can't inject arbitrary commands.
    const stderr = vi.fn();
    // gh#556 Part 1: the worktree path now derives from homedir, so the pathological
    // metachars are injected via the homedir seam (the realistic injection vector for
    // the relocated ~/.borg/worktrees/... path). shellEscape must still defang them.
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      homedir: () => '/work/$HOME-evil/`whoami`/$(curl evil)',
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrPayload = stderr.mock.calls.map((c) => String(c[0])).join('');
    // Emitted cd line wraps the literal pathological string in single-quotes.
    // The $HOME / backticks / $() appear as literal characters inside single-
    // quotes; POSIX shells do not expand inside single-quotes.
    expect(stderrPayload).toContain(`cd '/work/$HOME-evil/\`whoami\`/$(curl evil)/.borg/worktrees/myrepo/drone'`);
  });

  it('hint is emitted AFTER claude exec returns (so user sees it post-session)', async () => {
    const stderr = vi.fn();
    const { cwd, chdir } = makeCwdPair('/work/myrepo');
    const exec = vi.fn(async () => 0);
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, exec, runSync, cwd, chdir,
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    // Find the post-session stderr call vs exec call ordering.
    const agentExitedCall = stderr.mock.calls.find((c) => String(c[0]).includes('Agent exited'));
    expect(agentExitedCall).toBeDefined();
    const sessionEndedOrder = stderr.mock.invocationCallOrder[stderr.mock.calls.indexOf(agentExitedCall!)];
    const execOrder = exec.mock.invocationCallOrder[0];
    expect(sessionEndedOrder).toBeGreaterThan(execOrder);
  });
});

describe('runAssimilate: step 7 (assimilate + persist)', () => {
  it('calls assimilate with cube + role IDs and persists to cubes.json', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', session_token: 'tok', role_id: 'r' }));
    const setActiveCube = vi.fn(async () => {});
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, setActiveCube, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalled();
    expect(setActiveCube).toHaveBeenCalledWith(expect.objectContaining({
      cubeId: 'c',
      droneId: 'd',
      name: 'myrepo',
      sessionToken: 'tok',
      droneLabel: 'drone-1',
    }));
  });
});

describe('runAssimilate: step 6 (role resolution)', () => {
  it('first drone with no role → human-seat role', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-1', session_token: 's', role_id: 'r-coord' }));
    const createCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ assimilate, createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coord' })
    );
  });

  it('falls through to the default worker once the mandatory Coordinator seat is occupied', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-build' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
      drones: [{ role_id: 'r-coord' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-build' })
    );
  });

  // Task 2 (occupancy-aware bare assimilate): default role Builder already
  // has an active drone seated; Reviewer is a free worker role. A bare
  // assimilate (non-first-drone path — cube already has a drone) must skip
  // the occupied default and pick the unoccupied worker role instead.
  it('bare assimilate skips the occupied default and picks the next worker role', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-reviewer' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      // non-first-drone path: cube already exists (has a seat)
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-reviewer' })
    );
  });

  it('bare assimilate treats a presumed-abandoned role as fillable', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-builder' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder', presumed_abandoned: true }],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-builder' }),
    );
  });

  it('a live occupant still blocks its role when abandoned rows are also present', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-3', session_token: 's', role_id: 'r-reviewer' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-reviewer', name: 'Reviewer', is_default: false, is_human_seat: false, role_class: 'worker' },
      ],
      drones: [
        { role_id: 'r-builder', presumed_abandoned: true },
        { role_id: 'r-builder', presumed_abandoned: false },
      ],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-reviewer' }),
    );
  });

  it('bare assimilate refills a mandatory role past the give-up advisory', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-coordinator' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-coordinator', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-coordinator', presumed_abandoned: true }],
    }));
    const runSync = vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });

    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coordinator' }),
    );
  });

  it('bare assimilate fills an unoccupied mandatory Coordinator before worker roles', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-coordinator' }));
    const getCube = vi.fn(async () => ({
      id: 'c-existing', name: 'myrepo',
      roles: [
        { id: 'r-builder', name: 'Builder', is_default: true, is_human_seat: false, role_class: 'worker' },
        { id: 'r-coordinator', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true, role_class: 'worker' },
      ],
      drones: [{ role_id: 'r-builder' }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-coordinator' })
    );
  });

  it('explicit role arg matched case-insensitively', async () => {
    const assimilate = vi.fn(async () => ({ cube_id: 'c', drone_id: 'd', drone_label: 'drone-3', session_token: 's', role_id: 'r-cr' }));
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [
        { id: 'r-cr', name: 'Code Reviewer', is_default: false, is_human_seat: false },
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_mandatory: true, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      assimilate, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    await runAssimilate({ role: 'code-reviewer', flags: { yes: true } }, deps);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ role_id: 'r-cr' })
    );
  });

  it('errors when role name does not match', async () => {
    const stderr = vi.fn();
    const getCube = vi.fn(async () => ({
      id: 'c', name: 'myrepo',
      roles: [{ id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false }],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, getCube, runSync,
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    });
    const exit = await runAssimilate({ role: 'nonexistent', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no role matching'));
  });
});

describe('runAssimilate: step 5 (first-drone bootstrap)', () => {
  it('applies starter silently with --yes when cube does not exist', async () => {
    const createCube = vi.fn(async () => ({
      id: 'c-new',
      name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), { name: 'myrepo', template: 'starter' });
  });

  it('uses --template flag verbatim', async () => {
    const createCube = vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true, template: 'research' } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), { name: 'myrepo', template: 'research' });
  });

  it('passes no template with --no-template', async () => {
    const createCube = vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, runSync, listCubes: vi.fn(async () => []) });
    await runAssimilate({ role: undefined, flags: { yes: true, noTemplate: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), { name: 'myrepo' });
  });

  it('fails non-TTY without --yes when prompt would be needed', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      isTTY: () => false,
      listCubes: vi.fn(async () => []),
      runSync: vi.fn((cmd: string, args: string[]) =>
        args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
      ),
    });
    const exit = await runAssimilate({ role: undefined, flags: {} }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('cube creation needs a template choice'));
  });

  it('prompts interactively and applies user choice', async () => {
    const answers = ['1', '2']; // Borg Cloud, then template option 2
    const prompt = vi.fn(async () => answers.shift() ?? '1');
    const createCube = vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const listTemplates = vi.fn(async () => [
      { name: 'software-dev', description: 'sw' },
      { name: 'research', description: 'res' },
    ]);
    const deps = makeStubDeps({
      prompt,
      createCube,
      listTemplates,
      isTTY: () => true,
      listCubes: vi.fn(async () => []),
      runSync: vi.fn((cmd: string, args: string[]) =>
        args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
      ),
    });
    await runAssimilate({ role: undefined, flags: {} }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), { name: 'myrepo', template: 'research' });
  });
});

describe('runAssimilate: step 4 (cube existence + detail)', () => {
  it('skips create when cube exists and fetches detail', async () => {
    const listCubes = vi.fn(async () => [{ id: 'cube-existing', name: 'myrepo' }]);
    const getCube = vi.fn(async () => ({
      id: 'cube-existing',
      name: 'myrepo',
      roles: [{ id: 'r-default', name: 'Drone', is_default: true, is_human_seat: false }],
    }));
    const createCube = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ listCubes, getCube, createCube: createCube as any, runSync, getActiveCube: vi.fn(async () => null) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(getCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'cube-existing');
    expect(createCube).not.toHaveBeenCalled();
  });
});

describe('runAssimilate: step 3 (worktree decision)', () => {
  it('uses cwd when no cubes.json entry exists', async () => {
    const chdir = vi.fn();
    const runSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const deps = makeStubDeps({ chdir, runSync, getActiveCube: vi.fn(async () => null) });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(chdir).not.toHaveBeenCalled();
  });

  // gh#33 (Q2/Q4/Q6): in-place path ADOPTS the wt- branch — fetch + switch
  // the checkout onto wt-<suffix> at origin/main (clean + merged). A bare
  // ff would leave a main checkout on main; adoption moves it off main.
  it('adopts the wt- branch (switch -C) before launch when in-place + clean + merged', async () => {
    const calls: string[][] = [];
    const stderr = vi.fn();
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.join(' ') === 'status --porcelain') return { status: 0, stdout: '', stderr: '' };       // clean
      // adoptWorktree checks HEAD merged into origin/main
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync, stderr,
      getActiveCube: vi.fn(async () => null),  // no cube => no sibling spawn => in-place
      cwd: () => '/work/borg-mcp',
      findProjectRoot: () => '/work/borg-mcp',
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(calls).toContainEqual(['fetch', 'origin', '--prune']);
    // wt-<suffix> for dir 'borg-mcp' under repo 'borg-mcp' => 'wt-borg-mcp'
    expect(calls).toContainEqual(['switch', '-C', 'wt-borg-mcp', 'origin/main']);
    const stderrPayload = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrPayload).toContain('worktree: adopted branch wt-borg-mcp at origin/main');
    expect(stderrPayload).toContain('WORKTREE STEERING');
    expect(stderrPayload).toContain('This checkout is now on branch wt-borg-mcp');
    expect(stderrPayload).toContain('Do ALL work HERE');
    expect(stderrPayload).toContain('in /work/borg-mcp');
    expect(stderrPayload).toContain('cut your feature branch (fix/.../feat/...) off wt-borg-mcp');
    expect(stderrPayload).not.toContain('NEVER `git -C /work/borg-mcp`');
    expect(stderrPayload).not.toContain('primary checkout /work/borg-mcp');
  });

  // gh#33: dirty in-place worktree => adoption must NOT mutate (no switch,
  // no reset/checkout) — never discards uncommitted work.
  it('skips wt- adoption without mutation when the in-place worktree is dirty', async () => {
    const calls: string[][] = [];
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.join(' ') === 'status --porcelain') return { status: 0, stdout: ' M src/x.ts\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync,
      getActiveCube: vi.fn(async () => null),
      cwd: () => '/work/borg-mcp',
      findProjectRoot: () => '/work/borg-mcp',
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
    expect(calls.some((a) => a[0] === 'reset' || (a[0] === 'checkout' && a[1] === '--'))).toBe(false);
  });

  // gh#33: in-place HEAD with unmerged work => BLOCKED, no switch, no
  // discard — the never-discard safety the CR/QA blocker emphasized.
  it('does NOT adopt (no switch) when in-place HEAD has unmerged work', async () => {
    const calls: string[][] = [];
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args.join(' ') === 'status --porcelain') return { status: 0, stdout: '', stderr: '' };   // clean
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 1, stdout: '', stderr: '' }; // unmerged
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync,
      getActiveCube: vi.fn(async () => null),
      cwd: () => '/work/borg-mcp',
      findProjectRoot: () => '/work/borg-mcp',
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(calls.some((a) => a[0] === 'switch')).toBe(false);
  });

  it('auto-creates sibling worktree on collision', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // gh#864: no lingering per-worktree branch → localBranchExists false → -b path.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn();
    const stderr = vi.fn();
    const pathExists = vi.fn(() => false);
    const deps = makeStubDeps({
      runSync,
      chdir, stderr,
      pathExists,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    // gh#556 Part 1: NEW worktree at ~/.borg/worktrees/<repo>/<name> (homedir stub = /home/test).
    // gh#33: named per-worktree branch (wt-<suffix>) UNAFFECTED by the relocation, NOT detached HEAD.
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-builder', '/home/test/.borg/worktrees/myrepo/builder', 'origin/main'], expect.any(String));
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/builder');
    // gh#556 Part 1: the intermediate ~/.borg/worktrees/<repo>/ is mkdir-p'd before `git worktree add`.
    expect(deps.mkdirp).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo');
    const stderrPayload = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(stderrPayload).toContain('WORKTREE STEERING');
    expect(stderrPayload).toContain('You are in worktree /home/test/.borg/worktrees/myrepo/builder on branch wt-builder');
    expect(stderrPayload).toContain('Do ALL work HERE');
    expect(stderrPayload).toContain('NEVER `git -C /work/myrepo`');
    expect(stderrPayload).toContain('work created in the primary won\'t reach your wt-branch without manual surgery (cherry-pick/merge)');
  });

  // BUG-4 / gh#150 regression (Sprint 3): step 3 must detect unborn-HEAD
  // before calling `git worktree add --detach` and surface an actionable
  // error rather than git's cryptic "fatal: not a valid object name: 'HEAD'".
  // Sprint 4 / gh#147 — verify the wt.stderr interpolation site
  // applies safeStderr so a hostile .git/config can't corrupt the
  // operator's terminal via ANSI escapes in git's stderr output.
  it('Sprint 4: worktree-add failure stderr is safeStderr-stripped (gh#147)', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        // git returns stderr containing an ANSI escape (clear-screen + cursor move).
        return { status: 128, stdout: '', stderr: 'fatal: \x1b[2Jmalicious\x00\x07' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync, stderr,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    // Original control chars are gone.
    expect(stderrCalls).not.toContain('\x1b[2J');
    expect(stderrCalls).not.toContain('\x00');
    expect(stderrCalls).not.toContain('\x07');
    // Printable remainder of the git message is preserved.
    expect(stderrCalls).toContain('git worktree add failed:');
    expect(stderrCalls).toContain('fatal: [2Jmalicious');
  });

  it('BUG-4 / unborn HEAD: fails fast with actionable error before git worktree add', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      // unborn HEAD: git rev-parse --verify HEAD exits non-zero.
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 128, stdout: '', stderr: "fatal: Needed a single revision\n" };
      }
      // If we got here for worktree add, the guard failed.
      if (args[0] === 'worktree' && args[1] === 'add') {
        throw new Error('worktree add called despite unborn-HEAD guard');
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      runSync, stderr,
      // Force step 3 sibling-spawn via stale cubes.json collision.
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(1);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain('sibling worktree spawn requires HEAD pointing at a commit');
    expect(stderrCalls).toContain('git commit --allow-empty');
    expect(stderrCalls).toContain('pass --here');
    // Crucially, `worktree add` was never invoked — runSync would have thrown.
    const worktreeAddCalls = runSync.mock.calls.filter(
      (c) => c[1][0] === 'worktree' && c[1][1] === 'add'
    );
    expect(worktreeAddCalls).toHaveLength(0);
  });

  it('BUG-4 / born HEAD: rev-parse --verify HEAD succeeds → worktree add proceeds normally', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync, chdir,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    await runAssimilate({ role: 'builder', flags: { yes: true } }, deps);
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/builder');
  });

  it('--here errors out on collision instead of spawning', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const deps = makeStubDeps({
      runSync,
      stderr,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('already hosts an active drone'));
  });

  it('--here collision aborts BEFORE the API assimilate — no orphan drone row minted (gh#780)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const assimilateSpy = vi.fn(async () => {
      throw new Error('should never be reached: the collision check must precede the mint');
    });
    const deps = makeStubDeps({
      runSync,
      stderr: vi.fn(),
      assimilate: assimilateSpy as any,
      getActiveCube: vi.fn(async () => ({ cubeId: 'old', droneId: 'd', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(1);
    // Pre-gh#780, Step 6 minted the drone row server-side and Step 7 then
    // aborted without ever persisting the mapping — orphaning the row.
    expect(assimilateSpy).not.toHaveBeenCalled();
  });

  it('--here + existing + SAME cube = broken-seat recovery: POSTs with prior_drone_id, adopts the rotated token, no sibling spawn (gh#780 PR-D)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const setActiveCube = vi.fn(async () => {});
    const assimilateSpy = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-prior',
      drone_label: 'one-of-one-builder',
      session_token: 'rotated-token',
      role_id: 'role-builder',
      reattached: true,
    }));
    const deps = makeStubDeps({
      runSync,
      stderr,
      setActiveCube,
      assimilate: assimilateSpy as any,
      // Saved identity for THIS worktree, SAME cube as the target.
      getActiveCube: vi.fn(async () => ({ cubeId: 'cube-1', droneId: 'drone-prior', name: 'myrepo', sessionToken: 'dead-token', droneLabel: 'one-of-one-builder', apiUrl: 'a' })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: false, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: 'builder', flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(0);
    expect(assimilateSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ prior_drone_id: 'drone-prior' })
    );
    // The rotated identity is persisted: same seat, NEW token.
    expect(setActiveCube).toHaveBeenCalledWith(
      expect.objectContaining({ droneId: 'drone-prior', sessionToken: 'rotated-token' })
    );
    // In-place recovery: no sibling worktree spawned.
    expect(runSync).not.toHaveBeenCalledWith('git', expect.arrayContaining(['worktree']), expect.anything());
    // The recovery is announced; the gh#700 "didn't grant" note is NOT
    // (the seat's role is authoritative on reattach).
    const stderrText = (stderr.mock.calls as unknown as string[][]).map((c) => c[0]).join('');
    expect(stderrText).toMatch(/re-?attached/i);
    expect(stderrText).not.toContain("didn't grant");
  });

  it('a normal mint does NOT send prior_drone_id (fresh worktree, no saved identity)', async () => {
    const assimilateSpy = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-new',
      drone_label: 'one-of-one-builder',
      session_token: 'sess',
      role_id: 'role-builder',
    }));
    const deps = makeStubDeps({
      assimilate: assimilateSpy as any,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
        { id: 'role-builder', name: 'Builder', is_default: true, is_human_seat: false },
      ]})),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true, here: true } }, deps);
    expect(exit).toBe(0);
    const params = (assimilateSpy.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];
    expect(params.prior_drone_id).toBeUndefined();
  });
});

describe('runAssimilate: step 2 (cube-name derivation)', () => {
  it('uses --cube-name flag override', async () => {
    const createCube = vi.fn(async () => ({ id: 'c', name: 'override', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ createCube });
    await runAssimilate({ role: undefined, flags: { yes: true, cubeName: 'override' } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'override' }));
  });

  it('derives from git remote origin', async () => {
    const runSync = vi.fn((cmd, args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { status: 0, stdout: 'git@github.com:Org/cool-repo.git\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const createCube = vi.fn(async () => ({ id: 'c', name: 'cool-repo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ runSync, createCube });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'cool-repo' }));
  });

  it('passes undefined name when no remote (server auto-generates)', async () => {
    const runSync = vi.fn(() => ({ status: 1, stdout: '', stderr: 'fatal: No such remote' }));
    const createCube = vi.fn(async () => ({ id: 'c', name: 'sphere-042', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ runSync, createCube, cwd: () => '/work/myrepo', findProjectRoot: () => '/work/myrepo' });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: undefined }));
  });
});

// v0.9.2 hotfix regression tests (drone-1 DISPATCH-FIX 2026-05-18T10:48Z).
describe('runAssimilate: BUG-1 — UX-F4 stderr false positive', () => {
  it('does not emit basename-fallback nudge when remote parses to same name as basename', async () => {
    const stderr = vi.fn();
    // remote parses → 'myrepo' (real success), cwd basename → 'myrepo'.
    // The prior `cubeName === deriveCubeName(projectRoot, null)` proxy
    // produced a false positive here; the v0.9.2 fix calls parseGitRemote
    // directly so this case is silent.
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:Org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      stderr, runSync,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain("couldn't parse git remote");
  });

  it('does NOT emit basename-fallback nudge when remote is unparseable (cubeName is null)', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'not-a-url', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const createCube = vi.fn(async () => ({ id: 'c', name: 'sphere-042', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      stderr, runSync, createCube,
      cwd: () => '/work/somerepo',
      findProjectRoot: () => '/work/somerepo',
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).not.toContain("couldn't parse git remote");
  });
});

describe('runAssimilate: BUG-2 — wire shape unwrap', () => {
  // The bug was that the orchestrator received the wrapped `{cube, roles}`
  // shape, but stub-based Phase E tests hid the mismatch by returning a
  // pre-unwrapped shape. The v0.9.2 fix moved the unwrap to remote-client.
  // These tests stub the WIRE-shape `{cube, roles}` returned by remote-client
  // to exercise the orchestrator's expected flat-shape contract end-to-end.
  it('orchestrator step 5 → step 6 transitions correctly with createCube returning flat shape', async () => {
    const createCube = vi.fn(async () => ({
      // Flat shape per the v0.9.2 remote-client unwrap contract.
      id: 'c-new',
      name: 'myrepo',
      roles: [
        { id: 'r-coord', name: 'Coordinator', is_default: false, is_human_seat: true },
        { id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false },
      ],
    }));
    const assimilate = vi.fn(async () => ({
      cube_id: 'c-new', drone_id: 'd', drone_label: 'drone-1', session_token: 's', role_id: 'r-coord',
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({ createCube, assimilate, runSync, listCubes: vi.fn(async () => []) });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    // Step 6 reached cubeDetail.roles.find without "Cannot read properties of undefined".
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.objectContaining({ role_id: 'r-coord' })
    );
  });

  it('orchestrator handles getCube returning flat shape on existing-cube path', async () => {
    const getCube = vi.fn(async () => ({
      id: 'c-existing',
      name: 'myrepo',
      roles: [{ id: 'r-build', name: 'Builder', is_default: true, is_human_seat: false }],
      drones: [],
    }));
    const assimilate = vi.fn(async () => ({
      cube_id: 'c-existing', drone_id: 'd', drone_label: 'drone-2', session_token: 's', role_id: 'r-build',
    }));
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const deps = makeStubDeps({
      getCube, assimilate, runSync,
      listCubes: vi.fn(async () => [{ id: 'c-existing', name: 'myrepo' }]),
    });
    const exit = await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(exit).toBe(0);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String), expect.any(String),
      expect.objectContaining({ role_id: 'r-build' })
    );
  });
});

describe('runAssimilate: step 1 (auth)', () => {
  it('uses cached auth when available', async () => {
    const getCachedAuth = vi.fn(async () => ({ token: 'cached', apiUrl: 'http://api.test' }));
    const runSetup = vi.fn(async () => ({ token: 'fresh', apiUrl: 'http://api.test' }));
    const deps = makeStubDeps({ getCachedAuth, runSetup });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(getCachedAuth).toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
  });

  it('runs setup inline when no cached auth', async () => {
    const getCachedAuth = vi.fn(async () => null);
    const runSetup = vi.fn(async () => ({ token: 'fresh', apiUrl: 'http://api.test' }));
    const deps = makeStubDeps({ getCachedAuth, runSetup });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(runSetup).toHaveBeenCalled();
  });
});

describe('runAssimilate: #1015 authority selection', () => {
  it('connects directly to an explicit server before touching cloud auth and persists its endpoint', async () => {
    const getCachedAuth = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const runSetup = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const listCubes = vi.fn(async () => []);
    const setActiveCube = vi.fn(async () => {});
    const prompt = vi.fn(async () => 'must-not-prompt');
    const deps = makeStubDeps({
      getCachedAuth,
      runSetup,
      connectServer,
      listCubes,
      setActiveCube,
      prompt,
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'localhost:8787', yes: true } }, deps)).toBe(0);

    expect(connectServer).toHaveBeenCalledWith('https://localhost:8787');
    expect(getCachedAuth).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(listCubes).toHaveBeenCalledWith(
      'https://localhost:8787',
      'local-token',
      SERVER_TRUST_IDENTITY,
    );
    expect(setActiveCube).toHaveBeenCalledWith(expect.objectContaining({
      apiUrl: 'https://localhost:8787',
      serverTrustIdentity: SERVER_TRUST_IDENTITY,
      localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
      localSessionGeneration: 1,
    }));
    expect(setActiveCube.mock.calls[0][0]).not.toHaveProperty('sessionToken');
  });

  it('reads an explicitly requested enrollment invitation through the hidden-input seam', async () => {
    const invitation = 'i'.repeat(43);
    const prompt = vi.fn(async () => 'must-not-prompt');
    const promptSecret = vi.fn(async () => invitation);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({ prompt, promptSecret, connectServer });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(0);

    expect(promptSecret).toHaveBeenCalledWith(
      'Single-use invitation for https://localhost:8787: ',
    );
    expect(connectServer).toHaveBeenCalledWith(
      'https://localhost:8787',
      { invitation },
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('refuses enrollment without a TTY before reading or sending a secret', async () => {
    const stderr = vi.fn();
    const promptSecret = vi.fn(async () => 'i'.repeat(43));
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      stderr,
      promptSecret,
      connectServer,
      isTTY: () => false,
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true },
    }, deps)).toBe(1);

    expect(promptSecret).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('requires an interactive terminal'));
  });

  it('fails closed when an explicit server cannot connect', async () => {
    const stderr = vi.fn();
    const getCachedAuth = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const runSetup = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const listCubes = vi.fn(async () => []);
    const deps = makeStubDeps({
      stderr,
      getCachedAuth,
      runSetup,
      listCubes,
      connectServer: vi.fn(async () => { throw new Error('enrollment credential rejected'); }),
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'server.example.com' } }, deps)).toBe(1);

    expect(getCachedAuth).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(listCubes).not.toHaveBeenCalled();
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://server.example.com');
    expect(output).toContain('enrollment credential rejected');
    expect(output).toContain('Borg did not connect to borgmcp.ai');
    expect(output).toContain('borg assimilate --host https://server.example.com --enroll');
  });

  it('redacts token-shaped and terminal-control data from generic server failures', async () => {
    const stderr = vi.fn();
    const secret = 's'.repeat(43);
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error(`request failed for ${secret}\u001b[2J`);
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('\u001b');
  });

  it('uses deterministic recovery copy when no enrollment is stored', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new BorgServerError('NOT_ENROLLED', 'not enrolled');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Not enrolled with Borg server https://localhost:8787');
    expect(output).toContain('Borg did not connect to borgmcp.ai');
    expect(output).toContain('borg assimilate --host https://localhost:8787 --enroll');
    expect(output).toContain('prompted to paste the invitation securely');
  });

  it('distinguishes a rejected saved enrollment without exposing a credential', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new BorgServerError('CREDENTIAL_REJECTED', 'credential rejected');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'server.example.com' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('saved enrollment for https://server.example.com was rejected');
    expect(output).toContain('--enroll to replace it');
    expect(output).toContain('Borg did not connect to borgmcp.ai');
  });

  it('offers a detected local server before the general authority choice', async () => {
    const prompt = vi.fn(async () => '');
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      detectLocalServer: vi.fn(async () => 'localhost:8787'),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {} }, deps)).toBe(0);

    expect(prompt).toHaveBeenCalledTimes(2); // authority + first-cube template
    expect(String(prompt.mock.calls[0][0])).toContain('Local Borg server detected');
    expect(connectServer).toHaveBeenCalledWith('https://localhost:8787');
  });

  it('allows declining detection and choosing Cloud explicitly', async () => {
    const answers = ['n', '1', '1'];
    const prompt = vi.fn(async () => answers.shift() ?? '1');
    const getCachedAuth = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const connectServer = vi.fn(async () => ({
      token: 'local-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      getCachedAuth,
      detectLocalServer: vi.fn(async () => 'https://localhost:8787'),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {} }, deps)).toBe(0);

    expect(getCachedAuth).toHaveBeenCalledOnce();
    expect(connectServer).not.toHaveBeenCalled();
    expect(String(prompt.mock.calls[1][0])).toContain('Borg Cloud');
  });

  it('prompts for a custom host when no local server is detected', async () => {
    const answers = ['2', 'server.example.com', '1'];
    const prompt = vi.fn(async () => answers.shift() ?? '1');
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      prompt,
      detectLocalServer: vi.fn(async () => null),
      connectServer,
    });

    expect(await runAssimilate({ role: undefined, flags: {} }, deps)).toBe(0);

    expect(String(prompt.mock.calls[0][0])).toContain('Borg server host');
    expect(String(prompt.mock.calls[1][0])).toContain('host or URL');
    expect(connectServer).toHaveBeenCalledWith('https://server.example.com');
  });

  it('rejects an unsafe explicit endpoint before cloud auth or network access', async () => {
    const stderr = vi.fn();
    const getCachedAuth = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({ stderr, getCachedAuth, connectServer });

    expect(await runAssimilate({ role: undefined, flags: { server: 'http://server.example.com' } }, deps)).toBe(1);

    expect(getCachedAuth).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('must use https://'));
  });

  it('fails closed on a selected server auth error from the first API call', async () => {
    const stderr = vi.fn();
    const runSetup = vi.fn(async () => ({ token: 'cloud-token', apiUrl: 'https://api.borgmcp.ai' }));
    const deps = makeStubDeps({
      stderr,
      runSetup,
      connectServer: vi.fn(async () => ({
        token: 'local-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
      })),
      listCubes: vi.fn(async () => { throw new Error('HTTP 401: invalid server credential'); }),
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).toBe(1);

    expect(runSetup).not.toHaveBeenCalled();
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('HTTP 401');
    expect(output).toContain('Borg did not connect to borgmcp.ai');
  });
});

// Phase G Task 19 — fills coverage gap on spec scenarios 5 + 12.
// Other 10 scenarios already covered by the Phase E tests; see the
// REVIEW-READY post for the full mapping.
describe('runAssimilate: integration scenario 5 (--worktree force-create)', () => {
  it('--worktree <name> force-creates a sibling even when no cubes.json collision', async () => {
    const runSyncSpy = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // gh#864: no lingering per-worktree branch → localBranchExists false → -b path.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const chdir = vi.fn();
    const deps = makeStubDeps({
      runSync: runSyncSpy, chdir,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
      getActiveCube: vi.fn(async () => null), // NO cubes.json collision
      listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
    });
    await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps);
    // --worktree forces sibling spawn regardless of collision state.
    // gh#556 Part 1: NEW worktree at ~/.borg/worktrees/<repo>/<name> (homedir stub = /home/test).
    // gh#33: named per-worktree branch (wt-<suffix>) UNAFFECTED, NOT detached HEAD.
    expect(runSyncSpy).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-review-1', '/home/test/.borg/worktrees/myrepo/review-1', 'origin/main'], expect.any(String));
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1');
  });
});

// gh#864 — `git worktree add -b` hard-fails on a lingering wt-<suffix> branch
// whose old worktree was pruned. Adopt a MERGED lingering branch; bump the
// suffix past an UNMERGED one (never reuse/clobber un-merged work).
describe('runAssimilate: gh#864 worktree branch-collision dedup', () => {
  const baseDeps = (runSync: any) => makeStubDeps({
    runSync,
    chdir: vi.fn(),
    cwd: () => '/work/myrepo',
    findProjectRoot: () => '/work/myrepo',
    getActiveCube: vi.fn(async () => null),
    listCubes: vi.fn(async () => [{ id: 'c', name: 'myrepo' }]),
    getCube: vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] })),
  });

  it('adopts a lingering MERGED wt-<suffix> branch (no -b, SAME suffix)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // wt-review-1 already exists (lingering)...
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) return { status: 0, stdout: 'abc123\n', stderr: '' };
      // ...and is fully merged into origin/main → adoptable.
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps);
    // Adopt form: `git worktree add <path> wt-review-1` — no -b, no startRef, SAME suffix.
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '/home/test/.borg/worktrees/myrepo/review-1', 'wt-review-1'], expect.any(String));
    expect(deps.chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1');
    // The failing -b create on the colliding branch is NEVER attempted.
    const dashBcreates = runSync.mock.calls.filter(
      (c: any[]) => c[1][0] === 'worktree' && c[1][1] === 'add' && c[1][2] === '-b'
    );
    expect(dashBcreates).toHaveLength(0);
  });

  it('bumps the suffix past a lingering UNMERGED wt-<suffix> branch (-b on the fresh suffix)', async () => {
    const runSync = vi.fn((cmd: string, args: string[]) => {
      if (args[0] === 'remote') return { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      // wt-review-1 exists; the bumped wt-review-1-2 does not.
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return args[3] === 'refs/heads/wt-review-1'
          ? { status: 0, stdout: 'abc123\n', stderr: '' }
          : { status: 1, stdout: '', stderr: '' };
      }
      // wt-review-1 carries commits NOT on origin/main → unmerged → must not reuse.
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = baseDeps(runSync);
    await runAssimilate({ role: undefined, flags: { yes: true, worktree: 'review-1' } }, deps);
    // Bumped to review-1-2, freshly created at startRef with -b (its ref is absent).
    expect(runSync).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-review-1-2', '/home/test/.borg/worktrees/myrepo/review-1-2', 'origin/main'], expect.any(String));
    expect(deps.chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1-2');
    // The unmerged wt-review-1 is never adopted (no add of that path/branch).
    const adoptReview1 = runSync.mock.calls.filter(
      (c: any[]) => c[1][0] === 'worktree' && c[1][1] === 'add' && c[1][2] === '/home/test/.borg/worktrees/myrepo/review-1'
    );
    expect(adoptReview1).toHaveLength(0);
  });
});

// Helper: runSync stub that returns a git remote URL so cube name = 'myrepo'.
const gitRemoteRunSync = vi.fn((_cmd: string, args: string[]) =>
  args[0] === 'remote'
    ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
    : { status: 0, stdout: '', stderr: '' }
);

describe('runAssimilate: temporary Claude model compatibility', () => {
  const successDeps = (overrides: Partial<AssimilateDeps> = {}) =>
    makeStubDeps({
      exec: vi.fn(async () => 0),
      assimilate: vi.fn(async () => ({
        cube_id: 'cube-1',
        drone_id: 'drone-x',
        drone_label: 'drone-1',
        session_token: 'sess',
        role_id: 'role-builder',
      })),
      runSync: gitRemoteRunSync,
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-builder', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      ...overrides,
    });

  it('forwards an explicit Claude descriptor and sets only ANTHROPIC_MODEL', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      session_token: 'sess',
      role_id: 'role-builder',
    }));
    const exec = vi.fn(async () => 0);
    const deps = successDeps({ assimilate, exec });

    expect(await runAssimilate(
      { role: 'builder', flags: { model: 'claude:claude-opus-4-8', yes: true } },
      deps
    )).toBe(0);

    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: 'claude:claude-opus-4-8', agent_kind: 'claude' })
    );
    const [, , , envArg] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
    expect(envArg.ANTHROPIC_MODEL).toBe('claude-opus-4-8');
    expect(envArg).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(envArg).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('does not inherit a role default model when no flag is provided', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      session_token: 'sess',
      role_id: 'role-builder',
    }));
    const deps = successDeps({
      assimilate,
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{
          id: 'role-builder',
          name: 'Builder',
          is_default: true,
          is_human_seat: false,
          default_model: 'claude:configured-elsewhere',
        }],
      })),
    });

    expect(await runAssimilate({ role: 'builder', flags: { yes: true } }, deps)).toBe(0);
    expect(assimilate).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ model: null })
    );
  });

  it('leaves provider-specific environment variables untouched without a Borg override', async () => {
    const exec = vi.fn(async () => 0);
    const deps = successDeps({ exec });
    const priorBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const priorAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_BASE_URL = 'http://agent-cli.example';
    process.env.ANTHROPIC_AUTH_TOKEN = 'agent-cli-owned';
    try {
      expect(await runAssimilate({ role: 'builder', flags: { yes: true } }, deps)).toBe(0);
      const [, , , envArg] = exec.mock.calls[0] as [string, string[], string, Record<string, string>];
      expect(envArg.ANTHROPIC_BASE_URL).toBe('http://agent-cli.example');
      expect(envArg.ANTHROPIC_AUTH_TOKEN).toBe('agent-cli-owned');
    } finally {
      if (priorBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = priorBaseUrl;
      if (priorAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = priorAuthToken;
    }
  });
});
