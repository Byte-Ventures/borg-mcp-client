import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runAssimilate,
  safeStderr,
  type ActiveCube,
  type AssimilateDeps,
  type AssimilateResult,
} from '../src/assimilate-cmd';
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
    runSync: vi.fn((_cmd: string, args: string[]) =>
      args[0] === 'remote'
        ? { status: 0, stdout: 'git@github.com:org/myrepo.git', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
    ),
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
    hasPersistedActiveCube: vi.fn(async () => false),
    probeSeat: vi.fn(async () => 'live'),
    getPendingLocalAttach: vi.fn(async () => null),
    completeLocalAttach: vi.fn(async () => {}),
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
    resumeServerEnrollment: vi.fn(async () => null),
    listCubes: vi.fn(async () => []),
    getCube: vi.fn(async () => { throw new Error('not called in this scenario'); }),
    createCube: vi.fn(async () => ({ id: 'cube-1', name: 'myrepo', roles: [
      { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false },
    ]})),
    assimilate: vi.fn(async (apiUrl, _token, params, serverTrustIdentity) => ({
      cube_id: 'cube-1',
      drone_id: 'drone-x',
      drone_label: 'drone-1',
      role_id: 'role-default',
      ...(serverTrustIdentity === undefined
        ? { session_token: 'sess' }
        : {
          local_attach_completion: {
            binding: {
              origin: apiUrl,
              trustIdentity: serverTrustIdentity,
              cubeId: params.cube_id,
              roleId: params.role_id,
            },
            operation: params.local_attach_operation!,
            retryKey: '44444444-4444-4444-8444-444444444444',
          },
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
    expect(stdoutPayload).toContain('Attached `drone-1`');
    expect(stdoutPayload).toContain('coordinator');
    expect(stdoutPayload).toContain('myrepo');
    expect(stdoutPayload).toContain('borg_whoami');
    expect(stdoutPayload).toContain('borg_roster');
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
    expect(stdoutPayload).toContain('borg_whoami');
    expect(stdoutPayload).toContain('borg_roster');
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
  const sameCubeSeat = vi.fn(async () => ({ cubeId: 'c', droneId: 'd-prior', name: 'myrepo', sessionToken: 's', droneLabel: 'l', apiUrl: 'http://api.test' }));
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

  it('starts a sibling from local HEAD when the repository has no usable origin', async () => {
    const calls: string[][] = [];
    const runSync = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { status: 2, stdout: '', stderr: 'error: No such remote origin' };
      }
      if (args.join(' ') === 'rev-parse --is-bare-repository') {
        return { status: 0, stdout: 'false\n', stderr: '' };
      }
      if (args.join(' ') === 'rev-parse --verify HEAD') {
        return { status: 0, stdout: '16c1405abcdef0123456789\n', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && typeof args[3] === 'string' && args[3].startsWith('refs/heads/')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const stderr = vi.fn();
    const deps = makeStubDeps({
      runSync,
      stderr,
      cwd: () => '/work/myrepo',
      findProjectRoot: () => '/work/myrepo',
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { yes: true, worktree: 'builder' },
    }, deps)).resolves.toBe(0);

    expect(calls).not.toContainEqual(['fetch', 'origin']);
    expect(calls).not.toContainEqual(['rev-parse', '--verify', 'origin/main']);
    expect(runSync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'wt-builder', '/home/test/.borg/worktrees/myrepo/builder', 'HEAD'],
      '/work/myrepo',
    );
    expect(stderr).toHaveBeenCalledWith(
      'note: no usable origin; new worktree will start on local HEAD (16c1405)\n',
    );
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
      getActiveCube: vi.fn(async () => ({ cubeId: 'cube-1', droneId: 'drone-prior', name: 'myrepo', sessionToken: 'dead-token', droneLabel: 'one-of-one-builder', apiUrl: 'http://api.test' })),
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
    const prompt = vi.fn();
    const createCube = vi.fn(async () => ({ id: 'c', name: 'override', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ prompt, createCube });
    await runAssimilate({ role: undefined, flags: { server: 'localhost:8787', cubeName: 'override' } }, deps);
    expect(createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ name: 'override' }),
      SERVER_TRUST_IDENTITY,
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('rejects a local --cube-name outside the closed create contract before enrollment', async () => {
    const connectServer = vi.fn();
    const deps = makeStubDeps({ connectServer });
    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, cubeName: '../escape' },
    }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Invalid cube name for https://localhost:8787'));
    expect(connectServer).not.toHaveBeenCalled();
    expect(deps.promptSecret).not.toHaveBeenCalled();
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

  it('uses the sanitized repository basename with --yes when no origin exists', async () => {
    const runSync = vi.fn(() => ({ status: 1, stdout: '', stderr: 'fatal: No such remote' }));
    const prompt = vi.fn();
    const createCube = vi.fn(async () => ({ id: 'c', name: 'my-repo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ runSync, prompt, createCube, cwd: () => '/work/My_Repo', findProjectRoot: () => '/work/My_Repo' });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'my-repo' }));
    expect(prompt).not.toHaveBeenCalled();
  });

  it('confirms the repository basename interactively when no origin exists', async () => {
    const runSync = vi.fn(() => ({ status: 1, stdout: '', stderr: 'fatal: No such remote' }));
    const prompt = vi.fn(async () => 'yes');
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const createCube = vi.fn(async () => ({ id: 'c', name: 'myrepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({ runSync, prompt, connectServer, createCube });
    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787' } }, deps)).resolves.toBe(0);
    expect(prompt).toHaveBeenCalledWith(
      "No usable origin remote was found. Use directory name 'myrepo' as the cube name? [Y/n]: ",
    );
    expect(prompt).toHaveBeenCalledBefore(connectServer);
    expect(createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ name: 'myrepo' }),
      SERVER_TRUST_IDENTITY,
    );
  });

  it('does not enroll when the user declines a no-origin basename', async () => {
    const runSync = vi.fn(() => ({ status: 1, stdout: '', stderr: 'fatal: No such remote' }));
    const prompt = vi.fn(async () => 'no');
    const connectServer = vi.fn();
    const deps = makeStubDeps({ runSync, prompt, connectServer });
    await expect(runAssimilate({ role: undefined, flags: { server: 'localhost:8787', enroll: true } }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Cube creation for https://localhost:8787 was cancelled'));
    expect(connectServer).not.toHaveBeenCalled();
    expect(deps.promptSecret).not.toHaveBeenCalled();
  });

  it('requires --cube-name or --yes for a non-interactive no-origin repository', async () => {
    const runSync = vi.fn(() => ({ status: 1, stdout: '', stderr: 'fatal: No such remote' }));
    const createCube = vi.fn();
    const deps = makeStubDeps({ runSync, createCube, isTTY: () => false });
    await expect(runAssimilate({ role: undefined, flags: {} }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('Re-run with --cube-name <name> or --yes'));
    expect(createCube).not.toHaveBeenCalled();
  });

  it('fails closed when a no-origin repository is bare', async () => {
    const runSync = vi.fn((_cmd: string, commandArgs: string[]) => {
      if (commandArgs[0] === 'rev-parse') {
        return { status: 0, stdout: 'true\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'fatal: No such remote' };
    });
    const createCube = vi.fn();
    const deps = makeStubDeps({ runSync, createCube, cwd: () => '/work/repo.git', findProjectRoot: () => '/work/repo.git' });
    await expect(runAssimilate({ role: undefined, flags: { yes: true } }, deps)).resolves.toBe(1);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('requires a non-bare repository worktree'));
    expect(createCube).not.toHaveBeenCalled();
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

  it('emits a basename-fallback nudge when the origin remote is unparseable', async () => {
    const stderr = vi.fn();
    const runSync = vi.fn((cmd: string, args: string[]) =>
      args[0] === 'remote' ? { status: 0, stdout: 'not-a-url', stderr: '' } : { status: 0, stdout: '', stderr: '' }
    );
    const createCube = vi.fn(async () => ({ id: 'c', name: 'somerepo', roles: [{ id: 'r', name: 'Drone', is_default: true, is_human_seat: false }] }));
    const deps = makeStubDeps({
      stderr, runSync, createCube,
      cwd: () => '/work/somerepo',
      findProjectRoot: () => '/work/somerepo',
    });
    await runAssimilate({ role: undefined, flags: { yes: true } }, deps);
    const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrCalls).toContain("Could not parse the origin remote; using directory name 'somerepo'");
    expect(createCube).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ name: 'somerepo' }));
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

  it('gives an endpoint-bound recovery command when a local role is unavailable', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
    });

    expect(await runAssimilate({
      role: 'reviewer',
      flags: { server: 'localhost:8787', yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('`borg assimilate --host https://localhost:8787 <role>`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound recovery command when a local cube has no default role', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [],
      })),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('`borg assimilate --host https://localhost:8787 <role>`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound recovery command when local MCP setup fails', async () => {
    const stderr = vi.fn();
    mcpConfigMocks.ensureCliMcpConfigured.mockImplementationOnce(() => {
      throw new Error('opencode CLI not found');
    });
    const deps = makeStubDeps({
      stderr,
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cli: 'opencode' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain(
      '`borg assimilate --host https://localhost:8787 --cli opencode`',
    );
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('gives an endpoint-bound fresh-worktree command when a local seat was evicted', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      getActiveCube: vi.fn(async () => ({
        cubeId: 'cube-1',
        droneId: 'drone-prior',
        droneLabel: 'builder-1',
        name: 'myrepo',
        roleName: 'Builder',
        apiUrl: 'https://localhost:8787',
        serverTrustIdentity: SERVER_TRUST_IDENTITY,
        localSessionCredentialRef: 'borg-server-session:' + 'a'.repeat(64),
        localSessionGeneration: 1,
      })),
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => ({
        id: 'cube-1',
        name: 'myrepo',
        roles: [{ id: 'role-default', name: 'Builder', is_default: true, is_human_seat: false }],
      })),
      assimilate: vi.fn(async () => {
        throw new DroneEvictedError('evicted');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, here: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toContain('from a fresh worktree');
    expect(output).toContain('`borg assimilate --host https://localhost:8787`');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('reads an explicitly requested enrollment invitation through the hidden-input seam', async () => {
    const invitation = 'i'.repeat(43);
    const prompt = vi.fn(async () => 'must-not-prompt');
    const promptSecret = vi.fn(async () => invitation);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
      serverCapabilities: ['create_cube'],
    }));
    const deps = makeStubDeps({ prompt, promptSecret, connectServer });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(0);

    expect(promptSecret).toHaveBeenCalledWith(
      'Enrollment invitation for `https://localhost:8787` (single-use; hidden input):',
    );
    expect(connectServer).toHaveBeenCalledWith(
      'https://localhost:8787',
      { invitation },
    );
    expect(deps.stderr).toHaveBeenCalledWith(
      'Owner client enrolled with `https://localhost:8787`. ' +
        'Creating or joining this repository’s cube next.\n',
    );
    expect(prompt).not.toHaveBeenCalled();
  });

  it('gives an ordinary enrolled client a distinct next step without owner wording', async () => {
    const invitation = 'i'.repeat(43);
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      promptSecret: vi.fn(async () => invitation),
      connectServer: vi.fn(async () => ({
        token: 'ordinary-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
        serverCapabilities: [],
      })),
      createCube: vi.fn(async () => {
        throw new BorgServerError(
          'CREATE_CUBE_DENIED',
          'This Borg server client is not authorized to create cubes',
        );
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain(
      'Ordinary client enrolled with `https://localhost:8787`. ' +
        'Checking for an accessible repository cube next.',
    );
    expect(output).toContain(
      'This enrolled client cannot create a cube on https://localhost:8787.',
    );
    expect(output).not.toContain('Owner client enrolled');
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it('resumes a durable pending enrollment before prompting for another invitation', async () => {
    const promptSecret = vi.fn(async () => 'must-not-prompt');
    const connectServer = vi.fn(async () => {
      throw new Error('must not start a new enrollment');
    });
    const resumeServerEnrollment = vi.fn(async (_apiUrl: string, onPending?: () => void) => {
      onPending?.();
      return {
        token: 'resumed-server-token',
        trustIdentity: SERVER_TRUST_IDENTITY,
      };
    });
    const deps = makeStubDeps({
      promptSecret,
      connectServer,
      resumeServerEnrollment,
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(0);

    expect(resumeServerEnrollment).toHaveBeenCalledWith(
      'https://localhost:8787',
      expect.any(Function),
    );
    expect(promptSecret).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(
      'Resuming the pending enrollment for `https://localhost:8787`; do not enter another invitation.\n',
    );
    expect(deps.listCubes).toHaveBeenCalledWith(
      'https://localhost:8787',
      'resumed-server-token',
      SERVER_TRUST_IDENTITY,
    );
  });

  it('refuses enrollment without a TTY before reading or sending a secret', async () => {
    const stderr = vi.fn();
    const promptSecret = vi.fn(async () => 'i'.repeat(43));
    const resumeServerEnrollment = vi.fn(async () => null);
    const connectServer = vi.fn(async () => ({
      token: 'server-token',
      trustIdentity: SERVER_TRUST_IDENTITY,
    }));
    const deps = makeStubDeps({
      stderr,
      promptSecret,
      connectServer,
      resumeServerEnrollment,
      isTTY: () => false,
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true },
    }, deps)).toBe(1);

    expect(promptSecret).not.toHaveBeenCalled();
    expect(connectServer).not.toHaveBeenCalled();
    expect(resumeServerEnrollment).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Local enrollment requires an interactive operator terminal. ' +
        'Re-run `borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
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
      connectServer: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    });

    expect(await runAssimilate({ role: undefined, flags: { server: 'server.example.com' } }, deps)).toBe(1);

    expect(getCachedAuth).not.toHaveBeenCalled();
    expect(runSetup).not.toHaveBeenCalled();
    expect(listCubes).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'Could not reach Borg server at https://server.example.com. ' +
        'Start or restart it with `borg-mcp-server start`, then rerun ' +
        '`borg assimilate --host https://server.example.com`.\n',
    );
  });

  it('uses dedicated recovery copy while another Borg process owns secure state', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('Borg server keychain state is busy');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'The OS keychain is busy for https://localhost:8787 because another Borg process is ' +
        'creating or resuming secure state. Wait for it to finish, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
  });

  it('distinguishes an unavailable keychain from trust, auth, and connectivity failures', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('OS keychain unavailable for Borg server credentials');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Borg could not access the OS keychain for https://localhost:8787. ' +
        'Unlock or enable the keychain, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
  });

  it('uses identity recovery only for Borg server trust failures', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => {
        throw new Error('Borg server CA certificate does not match its pinned identity');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'Borg could not verify the expected server identity for https://localhost:8787. ' +
        'Verify that this is the expected server. If it was re-initialized, stop it, ' +
        'run `borg-mcp-server start`, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
  });

  it('tells an enrolled ordinary client to request a grant or join an accessible cube', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      createCube: vi.fn(async () => {
        throw new BorgServerError(
          'CREATE_CUBE_DENIED',
          'This Borg server client is not authorized to create cubes',
        );
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    expect(stderr).toHaveBeenCalledWith(
      'This enrolled client cannot create a cube on https://localhost:8787. ' +
        'Ask the server operator to grant access to a cube, then rerun ' +
        '`borg assimilate --host https://localhost:8787`.\n',
    );
    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).not.toMatch(/invitation|connectivity|borgmcp\.ai/i);
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

    expect(stderr).toHaveBeenCalledWith(
      'No saved enrollment for https://localhost:8787. Run ' +
        '`borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
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

    expect(stderr).toHaveBeenCalledWith(
      'The saved enrollment for https://server.example.com was rejected. Re-run ' +
        '`borg assimilate --host https://server.example.com --enroll` from the operator’s terminal.\n',
    );
  });

  it('explains how the operator replaces a rejected enrollment invitation', async () => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      promptSecret: vi.fn(async () => 'i'.repeat(43)),
      connectServer: vi.fn(async () => {
        throw new BorgServerError('INVITATION_REJECTED', 'invitation rejected');
      }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', enroll: true, yes: true },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('replacement enrollment invitation');
    expect(output).toContain('`borg-mcp-server owner-invite`');
    expect(output).toContain('`borg-mcp-server client-invite`');
    expect(output).toContain(
      '`borg assimilate --host https://localhost:8787 --enroll`',
    );
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
  });

  it.each([
    ['no saved enrollment', new BorgServerError('NOT_ENROLLED', 'not enrolled')],
    ['saved credential rejected', new BorgServerError('CREDENTIAL_REJECTED', 'credential rejected')],
    ['keychain busy', new Error('Borg server keychain state is busy')],
    ['keychain unavailable', new Error('OS keychain unavailable for Borg server credentials')],
    ['trust mismatch', new Error('Borg server CA certificate does not match its pinned identity')],
    ['server unreachable', new Error('connect ECONNREFUSED')],
    ['unexpected protocol', new Error('protocol response shape changed')],
  ])('keeps the %s recovery local, endpoint-specific, and actionable', async (_label, failure) => {
    const stderr = vi.fn();
    const deps = makeStubDeps({
      stderr,
      connectServer: vi.fn(async () => { throw failure; }),
    });

    expect(await runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787' },
    }, deps)).toBe(1);

    const output = stderr.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('https://localhost:8787');
    expect(output).toMatch(/`borg assimilate --host https:\/\/localhost:8787|`borg-mcp-server start`/);
    expect(output).not.toMatch(/borgmcp\.ai|Cloud/i);
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

    expect(prompt).toHaveBeenCalledTimes(1); // authority; local server owns its fixed template
    expect(String(prompt.mock.calls[0][0])).toContain('Local Borg server detected');
    expect(connectServer).toHaveBeenCalledWith('https://localhost:8787');
    expect(deps.createCube).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ template: 'default', projectRoot: '/work/myrepo' }),
      SERVER_TRUST_IDENTITY,
    );
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
    expect(stderr).toHaveBeenCalledWith(
      'The saved enrollment for https://localhost:8787 was rejected. Re-run ' +
        '`borg assimilate --host https://localhost:8787 --enroll` from the operator’s terminal.\n',
    );
  });
});

describe('runAssimilate: local saved-seat idempotency', () => {
  const localActive = (overrides: Partial<ActiveCube> = {}): ActiveCube => ({
    cubeId: 'cube-1',
    droneId: 'drone-saved',
    name: 'myrepo',
    sessionToken: 'saved-local-session',
    droneLabel: 'one-of-one-drone',
    apiUrl: 'https://localhost:8787',
    serverTrustIdentity: SERVER_TRUST_IDENTITY,
    localSessionCredentialRef: 'borg-server-session:' + 'b'.repeat(64),
    localSessionGeneration: 1,
    roleName: 'Drone',
    roleClass: 'worker',
    isHumanSeat: false,
    ...overrides,
  });

  const localCube = (occupied = false) => ({
    id: 'cube-1',
    name: 'myrepo',
    roles: [
      { id: 'role-default', name: 'Drone', is_default: true, is_human_seat: false, role_class: 'worker' as const },
      { id: 'role-other', name: 'Other', is_default: false, is_human_seat: false, role_class: 'worker' as const },
    ],
    drones: occupied ? [{ role_id: 'role-default' }] : [],
  });

  it('reattaches an identical rerun after restart without minting another drone', async () => {
    let active: ActiveCube | null = null;
    let droneCount = 0;
    let generation = 0;
    const getActiveCube = vi.fn(async () => active);
    const setActiveCube = vi.fn(async (next: ActiveCube) => {
      active = { ...next, sessionToken: `session-${next.localSessionGeneration}` };
    });
    const probeSeat = vi.fn(async () => 'live' as const);
    const assimilate = vi.fn(async (
      _apiUrl: string,
      _token: string,
      params: { prior_drone_id?: string },
    ) => {
      if (!params.prior_drone_id) droneCount += 1;
      generation += 1;
      return {
        cube_id: 'cube-1',
        drone_id: 'drone-saved',
        drone_label: 'one-of-one-drone',
        role_id: 'role-default',
        reattached: params.prior_drone_id === 'drone-saved',
        local_attach_completion: {
          binding: {
            origin: 'https://localhost:8787',
            trustIdentity: SERVER_TRUST_IDENTITY,
            cubeId: 'cube-1',
            roleId: 'role-default',
          },
          operation: {
            projectRoot: '/work/myrepo',
            kind: 'seat' as const,
            operationKey: 'current-worktree',
          },
          retryKey: '44444444-4444-4444-8444-444444444444',
        },
        local_session: {
          credential_ref: `borg-server-session:${String(generation).padStart(64, 'c')}`,
          generation,
          expires_at: null,
        },
      };
    });
    const deps = makeStubDeps({
      getActiveCube,
      setActiveCube,
      probeSeat,
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube(active !== null)),
    });
    const args = {
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    };

    await expect(runAssimilate(args, deps)).resolves.toBe(0);
    await expect(runAssimilate(args, deps)).resolves.toBe(0);

    expect(droneCount).toBe(1);
    expect(assimilate).toHaveBeenCalledTimes(2);
    expect(assimilate.mock.calls[1][2]).toMatchObject({
      cube_id: 'cube-1',
      role_id: 'role-default',
      prior_drone_id: 'drone-saved',
    });
    expect(probeSeat).toHaveBeenCalledWith(
      'session-1',
      'https://localhost:8787',
      SERVER_TRUST_IDENTITY,
    );
    expect(active).toMatchObject({ droneId: 'drone-saved', localSessionGeneration: 2 });
  });

  it('remints only after the saved seat is authoritatively evicted', async () => {
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-replacement',
      drone_label: 'one-of-one-drone',
      role_id: 'role-default',
      reattached: false,
      local_attach_completion: {
        binding: {
          origin: 'https://localhost:8787',
          trustIdentity: SERVER_TRUST_IDENTITY,
          cubeId: 'cube-1',
          roleId: 'role-default',
        },
        operation: {
          projectRoot: '/work/myrepo',
          kind: 'seat' as const,
          operationKey: 'current-worktree',
        },
        retryKey: '55555555-5555-4555-8555-555555555555',
      },
      local_session: {
        credential_ref: 'borg-server-session:' + 'd'.repeat(64),
        generation: 1,
        expires_at: null,
      },
    }));
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => localActive()),
      probeSeat: vi.fn(async () => 'evicted'),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(0);

    expect(assimilate.mock.calls[0][2]).toMatchObject({
      prior_drone_id: 'drone-saved',
      remint_invalid_prior: true,
      role_id: 'role-default',
    });
  });

  it('never mints when saved-seat liveness is ambiguous', async () => {
    const assimilate = vi.fn();
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => localActive()),
      probeSeat: vi.fn(async () => 'indeterminate'),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(1);

    expect(assimilate).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('could not verify'));
  });

  it('never treats persisted local metadata with a missing keychain session as a new seat', async () => {
    const assimilate = vi.fn();
    const deps = makeStubDeps({
      getActiveCube: vi.fn(async () => null),
      hasPersistedActiveCube: vi.fn(async () => true),
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(1);

    expect(assimilate).not.toHaveBeenCalled();
    expect(deps.getPendingLocalAttach).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('secure session could not be loaded'));
  });

  it('resumes an unfinished exact attach tuple without probing a revoked old session', async () => {
    const probeSeat = vi.fn();
    const getPendingLocalAttach = vi.fn(async (
      _apiUrl: string,
      _trust: string,
      _cubeId: string,
      roleId: string,
    ) => roleId === 'role-default'
      ? { priorDroneId: 'drone-saved', remintInvalidPrior: false }
      : null);
    const assimilate = vi.fn(async () => ({
      cube_id: 'cube-1',
      drone_id: 'drone-saved',
      drone_label: 'one-of-one-drone',
      role_id: 'role-default',
      reattached: true,
      local_attach_completion: {
        binding: {
          origin: 'https://localhost:8787',
          trustIdentity: SERVER_TRUST_IDENTITY,
          cubeId: 'cube-1',
          roleId: 'role-default',
        },
        operation: {
          projectRoot: '/work/myrepo',
          kind: 'seat' as const,
          operationKey: 'current-worktree',
        },
        retryKey: '66666666-6666-4666-8666-666666666666',
      },
      local_session: {
        credential_ref: 'borg-server-session:' + 'e'.repeat(64),
        generation: 2,
        expires_at: null,
      },
    }));
    const deps = makeStubDeps({
      // The prior session was revoked by the server-side commit whose response
      // was lost, so hydration can no longer return an active seat.
      getActiveCube: vi.fn(async () => null),
      getPendingLocalAttach,
      probeSeat,
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube(true)),
    });

    await expect(runAssimilate({
      role: undefined,
      flags: { server: 'localhost:8787', here: true, yes: true, cubeName: 'myrepo' },
    }, deps)).resolves.toBe(0);

    expect(probeSeat).not.toHaveBeenCalled();
    expect(assimilate.mock.calls[0][2]).toMatchObject({
      role_id: 'role-default',
      prior_drone_id: 'drone-saved',
    });
    expect(deps.completeLocalAttach).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ roleId: 'role-default' }),
      operation: expect.objectContaining({
        projectRoot: '/work/myrepo',
        kind: 'seat',
      }),
      retryKey: '66666666-6666-4666-8666-666666666666',
    }));
  });

  it('retries one implicit sibling exactly, then mints a distinct later sibling', async () => {
    let cwd = '/work/myrepo';
    const spawned = new Set<string>();
    let pending: {
      retryKey: string;
      droneId: string;
      operation: NonNullable<Parameters<AssimilateDeps['assimilate']>[2]['local_attach_operation']>;
      bindingRoleId: string;
    } | null = null;
    let nextDrone = 1;
    let loseFirstResponse = true;
    const setActiveCube = vi.fn(async () => {});
    const completeLocalAttach = vi.fn(async (completion: NonNullable<AssimilateResult['local_attach_completion']>) => {
      expect(pending).not.toBeNull();
      expect(completion.retryKey).toBe(pending!.retryKey);
      expect(completion.binding.roleId).toBe(pending!.bindingRoleId);
      pending = null;
    });
    const assimilate = vi.fn(async (
      apiUrl: string,
      _token: string,
      params: Parameters<AssimilateDeps['assimilate']>[2],
      trustIdentity?: string,
    ) => {
      const operation = params.local_attach_operation!;
      if (pending === null) {
        pending = {
          retryKey: `44444444-4444-4444-8444-${String(nextDrone).padStart(12, '0')}`,
          droneId: `sibling-${nextDrone++}`,
          operation,
          bindingRoleId: params.role_id,
        };
      } else {
        expect(operation).toEqual(pending.operation);
        expect(params.role_id).toBe(pending.bindingRoleId);
      }
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error('response lost after server commit');
      }
      return {
        cube_id: 'cube-1',
        drone_id: pending.droneId,
        drone_label: pending.droneId,
        // A valid server reattach may retain a different role. Completion must
        // still consume the originally prepared role binding.
        role_id: 'role-other',
        local_attach_completion: {
          binding: {
            origin: apiUrl,
            trustIdentity: trustIdentity!,
            cubeId: params.cube_id,
            roleId: pending.bindingRoleId,
          },
          operation: pending.operation,
          retryKey: pending.retryKey,
        },
        local_session: {
          credential_ref: 'borg-server-session:' + 'f'.repeat(64),
          generation: 1,
          expires_at: null,
        },
      };
    });
    const runSync = vi.fn((_cmd: string, argv: string[]) => {
      if (argv[0] === 'worktree' && argv[1] === 'add') {
        const path = argv[2] === '-b' ? argv[4] : argv[2];
        spawned.add(path);
        return { status: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return { status: 0, stdout: '/work/myrepo\n', stderr: '' };
      }
      if (argv[0] === 'rev-parse' && argv.includes('refs/heads/wt-other')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (argv[0] === 'rev-parse' && argv.includes('refs/heads/wt-other-2')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      if (argv[0] === 'rev-parse') {
        return { status: 0, stdout: 'abc123\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    const deps = makeStubDeps({
      cwd: () => cwd,
      chdir: vi.fn((next: string) => { cwd = next; }),
      findProjectRoot: () => '/work/myrepo',
      pathExists: (path: string) => spawned.has(path),
      runSync,
      getActiveCube: vi.fn(async () => localActive()),
      getPendingLocalAttach: vi.fn(async (
        _apiUrl,
        _trust,
        _cubeId,
        roleId,
        operation,
      ) => pending !== null && roleId === pending.bindingRoleId &&
          JSON.stringify(operation) === JSON.stringify(pending.operation)
        ? { remintInvalidPrior: false }
        : null),
      completeLocalAttach,
      setActiveCube,
      assimilate: assimilate as AssimilateDeps['assimilate'],
      listCubes: vi.fn(async () => [{ id: 'cube-1', name: 'myrepo' }]),
      getCube: vi.fn(async () => localCube()),
    });
    const args = {
      role: undefined,
      flags: { server: 'localhost:8787', yes: true, cubeName: 'myrepo' },
    };

    await expect(runAssimilate(args, deps)).resolves.toBe(1);
    expect(pending?.droneId).toBe('sibling-1');

    cwd = '/work/myrepo';
    await expect(runAssimilate(args, deps)).resolves.toBe(0);
    expect(setActiveCube).toHaveBeenLastCalledWith(expect.objectContaining({
      droneId: 'sibling-1',
      roleName: 'Other',
    }));
    expect(completeLocalAttach).toHaveBeenLastCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ roleId: 'role-default' }),
      operation: {
        projectRoot: '/work/myrepo',
        kind: 'sibling',
        operationKey: 'implicit-sibling',
      },
    }));

    cwd = '/work/myrepo';
    await expect(runAssimilate(args, deps)).resolves.toBe(0);
    expect(setActiveCube).toHaveBeenLastCalledWith(expect.objectContaining({
      droneId: 'sibling-2',
    }));
    expect(new Set(setActiveCube.mock.calls.map(([active]) => active.droneId))).toEqual(
      new Set(['sibling-1', 'sibling-2']),
    );
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
    await runAssimilate({
      role: undefined,
      flags: { yes: true, server: 'localhost:8787', worktree: 'review-1' },
    }, deps);
    // --worktree forces sibling spawn regardless of collision state.
    // gh#556 Part 1: NEW worktree at ~/.borg/worktrees/<repo>/<name> (homedir stub = /home/test).
    // gh#33: named per-worktree branch (wt-<suffix>) UNAFFECTED, NOT detached HEAD.
    expect(runSyncSpy).toHaveBeenCalledWith('git', ['worktree', 'add', '-b', 'wt-review-1', '/home/test/.borg/worktrees/myrepo/review-1', 'origin/main'], expect.any(String));
    expect(chdir).toHaveBeenCalledWith('/home/test/.borg/worktrees/myrepo/review-1');
    expect(deps.assimilate).toHaveBeenCalledWith(
      'https://localhost:8787',
      'server-token',
      expect.objectContaining({
        local_attach_operation: {
          projectRoot: '/work/myrepo',
          kind: 'sibling',
          operationKey: 'named-sibling:review-1',
        },
      }),
      SERVER_TRUST_IDENTITY,
    );
    expect(deps.completeLocalAttach).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ roleId: 'r' }),
      operation: {
        projectRoot: '/work/myrepo',
        kind: 'sibling',
        operationKey: 'named-sibling:review-1',
      },
    }));
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
