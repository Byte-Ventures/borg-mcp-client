import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withAgentRuntimeEnv } from '../src/agent-runtime.js';
import { __resetOpenCodeDroneForTests, connectOpenCodeDrone, createOpenCodeLaunchKickoff, injectInitialKickoff } from '../src/opencode-drone.js';
import { OPENCODE_LAUNCH_CORRELATION_METADATA_KEY } from '../src/opencode-plugin.js';

const exec = promisify(execFile);
const child = fileURLToPath(new URL('./fixtures/agent-session-child.ts', import.meta.url));
let root: string;
let originalRoot: string | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-session-')));
  originalRoot = process.env.BORG_STATE_ROOT;
  process.env.BORG_STATE_ROOT = root;
});
afterEach(() => {
  __resetOpenCodeDroneForTests();
  if (originalRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalRoot;
  rmSync(root, { recursive: true, force: true });
});

async function run(env: NodeJS.ProcessEnv) {
  const result = await exec(process.execPath, ['--import', 'tsx', child], {
    env: { ...process.env, ...env, BORG_STATE_ROOT: root, TEST_WORKTREE: root },
  });
  const parsed = JSON.parse(result.stdout);
  expect(parsed.processIdReads).toBe(0);
  return parsed;
}

describe('agent session identity across separate children', () => {
  it('never reads a process id, including at module initialization', () => {
    const source = readFileSync(new URL('../src/agent-session-identity.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:pid|ppid)\b/);
  });

  it('the real borg-regen hook records session identity before checking for an active cube', async () => {
    const env = { ...process.env, ...withAgentRuntimeEnv({}, 'claude'), BORG_SESSION: '1', BORG_STATE_ROOT: root };
    await new Promise<void>((resolve, reject) => {
      const hook = execFile(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
        fileURLToPath(new URL('../src/regen.ts', import.meta.url))], { cwd: root, env, timeout: 10_000 },
      (error) => error ? reject(error) : resolve());
      hook.stdin!.end(JSON.stringify({ session_id: 'hook-session', source: 'startup' }));
    });
    expect(await run(env)).toMatchObject({ suppress: false, identity: { kind: 'known', id: 'claude:hook-session' } });
    expect((await run(env)).suppress).toBe(true);
  });

  it('Claude reconnect retains identity; successful resume and new launch do not reuse stale hook state', async () => {
    const env = withAgentRuntimeEnv({}, 'claude');
    expect((await run(env)).identity.kind).toBe('unknown');
    const first = await run({ ...env, TEST_HOOK_PAYLOAD: JSON.stringify({ session_id: 'session-a', source: 'startup' }) });
    expect(first).toMatchObject({ suppress: false, identity: { kind: 'known', id: 'claude:session-a' } });
    const reconnect = await run(env);
    expect(reconnect.identity).toEqual(first.identity);
    expect(reconnect.suppress).toBe(true);
    const resumed = await run({ ...env, TEST_HOOK_PAYLOAD: JSON.stringify({ session_id: 'session-b', source: 'resume' }) });
    expect(resumed).toMatchObject({ suppress: false, identity: { kind: 'known', id: 'claude:session-b' } });
    const nextLaunch = withAgentRuntimeEnv(env, 'claude');
    expect((await run(nextLaunch))).toMatchObject({ suppress: false, identity: { kind: 'unknown', reason: 'claude-launch-correlation-mismatch' } });
    expect((await run({ ...nextLaunch, TEST_HOOK_PAYLOAD: JSON.stringify({ session_id: 'session-c' }) })).suppress).toBe(false);
    expect(statSync(join(root, '.borgmcp', 'claude-session.json')).mode & 0o777).toBe(0o600);
  });

  it('retains old observed-at evidence without expiring identity on reconnect; malformed hook input announces', async () => {
    const env = withAgentRuntimeEnv({}, 'claude');
    await run({ ...env, TEST_HOOK_PAYLOAD: JSON.stringify({ session_id: 'session-a' }) });
    const path = join(root, '.borgmcp', 'claude-session.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.observedAt = new Date(0).toISOString();
    writeFileSync(path, JSON.stringify(record));
    expect(await run(env)).toMatchObject({ suppress: true, identity: { observedAt: record.observedAt } });
    expect(await run({ ...env, TEST_HOOK_PAYLOAD: '{' })).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
  });

  it('Codex distinguishes reconnect and a new user thread without selecting ephemeral, subagent, or ambiguous candidates', async () => {
    const excluded = [
      { id: 'system', ephemeral: true, threadSource: 'system', source: 'vscode' },
      { id: 'subagent', source: { subAgent: {} } },
    ];
    const env = { BORG_AGENT_KIND: 'codex', BORG_CODEX_APP_SERVER_SOCKET: '/fixture/socket' };
    const threads = (id: string) => JSON.stringify([...excluded, { id, threadSource: 'user', ephemeral: false }]);
    expect(await run({ ...env, TEST_CODEX_THREADS: threads('user-a') })).toMatchObject({ suppress: false, identity: { id: 'codex:user-a' } });
    expect(await run({ ...env, TEST_CODEX_THREADS: threads('user-a') })).toMatchObject({ suppress: true, identity: { id: 'codex:user-a' } });
    expect(await run({ ...env, TEST_CODEX_THREADS: threads('user-b') })).toMatchObject({ suppress: false, identity: { id: 'codex:user-b' } });
    for (const candidates of [[], excluded, [{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'unreadable', unreadable: true }]]) {
      expect(await run({ ...env, TEST_CODEX_THREADS: JSON.stringify(candidates) })).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
    }
  });

  it('OpenCode restores the correlation-bound session in a new child and refuses a changed or ambiguous binding', async () => {
    const kickoff = createOpenCodeLaunchKickoff('fixture kickoff');
    let session = { id: 'ses_a', directory: root, time: { created: 1 } };
    let extra: typeof session[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, 'http://localhost').pathname;
      response.setHeader('content-type', 'application/json');
      if (path === '/session') response.end(JSON.stringify([session, ...extra]));
      else if (path.endsWith('/message')) response.end(JSON.stringify([{
        info: { role: 'user' }, parts: [{ type: 'text', metadata: { [OPENCODE_LAUNCH_CORRELATION_METADATA_KEY]: kickoff.correlationIdentity } }],
      }]));
      else { response.statusCode = 404; response.end('{}'); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const deps = { serverUrl: `http://127.0.0.1:${address.port}`, directory: root, droneLabel: 'drone', cubeName: 'cube', launchIdentity: kickoff.correlationIdentity, apiPassword: kickoff.apiPassword };
    const env = { BORG_AGENT_KIND: 'opencode', TEST_OPENCODE: JSON.stringify(deps) };
    try {
      await connectOpenCodeDrone(deps);
      expect(await injectInitialKickoff(kickoff)).toBe(true);
      expect(await run(env)).toMatchObject({ suppress: false, identity: { id: 'opencode:ses_a' } });
      expect(await run(env)).toMatchObject({ suppress: true, identity: { id: 'opencode:ses_a' } });
      extra = [{ ...session, id: 'ses_fork' }];
      expect(await run(env)).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
      extra = [];
      session = { ...session, id: 'ses_b' };
      expect(await run(env)).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
      await connectOpenCodeDrone(deps);
      expect(await injectInitialKickoff(kickoff)).toBe(true);
      expect(await run(env)).toMatchObject({ suppress: false, identity: { id: 'opencode:ses_b' } });
    } finally { server.close(); await once(server, 'close'); }
  });

  it('unknown harnesses announce repeatedly; another drone does not inherit suppression', async () => {
    expect(await run({ BORG_AGENT_KIND: 'unsupported' })).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
    expect(await run({ BORG_AGENT_KIND: 'unsupported' })).toMatchObject({ suppress: false, identity: { kind: 'unknown' } });
    const env = withAgentRuntimeEnv({}, 'claude');
    await run({ ...env, TEST_HOOK_PAYLOAD: JSON.stringify({ session_id: 'session-a' }) });
    expect((await run({ ...env, TEST_DRONE: 'other-drone' })).suppress).toBe(false);
  });
});
