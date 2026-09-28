/**
 * `borg representative listen --protocol 2` as a real process: protocol
 * refusals, the host pipe, wakes and acks over stdio, EOF, the listener lease,
 * startup and live stops, and a crash between persisting and emitting a wake.
 * The log is a controlled mock cube served to the child over loopback; the
 * SSE stream only triggers discovery.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readdir, rm, chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingFingerprint, createRepresentativeStore } from '../src/representative-store.js';
import { bindingFor, COORD_ID, MockCube, REP_ID } from './fixtures/representative-mock-backend.js';
import { parseRepresentativeArgs } from '../src/representative-cmd.js';
import { serveBackend } from './fixtures/backend-proxy.js';
import { withStateDb } from './fixtures/representative-state.js';

let root: string, worktree: string, origin: string, server: Server, backend: { url: string; close(): Promise<void> };
let responses: ServerResponse[], requests: URL[], status: number, errorCode: string;
let cube: MockCube;
const children: ChildProcess[] = [];
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
const trigger = () => {
  const id = randomUUID();
  for (const res of responses) if (!res.destroyed && !res.writableEnded) res.write(`event: log\nid: ${id}\ndata: ${JSON.stringify({ id, created_at: new Date().toISOString(), cursor: { id, created_at: new Date().toISOString() } })}\n\n`);
};
const reply = (text = 'BODY_SENTINEL') => cube.post(COORD_ID, text, [REP_ID], new Date().toISOString());

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rep-listener-')));
  // In-process store writes and the child listener share this private root.
  process.env.HOME = root; process.env.BORG_STATE_ROOT = root;
  worktree = join(root, 'work'); await mkdir(worktree, { mode: 0o700 });
  responses = []; requests = []; status = 200; errorCode = 'DRONE_EVICTED';
  cube = new MockCube();
  backend = await serveBackend(cube);
  server = createServer((req, res) => {
    const url = new URL(req.url!, origin); requests.push(url);
    if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: errorCode, message: 'fixture error' } })); return; }
    responses.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    res.write('event: bookmark\ndata: {}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  await createRepresentativeStore().saveBinding(bindingFor(worktree, { origin, boundAt: '2020-01-01T00:00:00.000Z' }), { rebind: false });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }));
  for (const res of responses) res.destroy();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await backend.close();
  await rm(root, { recursive: true, force: true });
});

function start(action = 'listen', options: { protocol?: string; stdin?: 'pipe' | 'ignore'; env?: Record<string, string> } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('__tests__/fixtures/representative-listener-process.ts'), worktree, origin, action, options.protocol ?? '2'],
    { env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), BACKEND_URL: backend.url, ...options.env },
      stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'] });
  children.push(child);
  const events: any[] = []; let raw = '', stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.stdout!.on('data', chunk => {
    raw += chunk; buffer += chunk;
    if (action === 'status') return; // pretty-printed JSON, read whole from raw()
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) events.push(JSON.parse(line)); }
  });
  const exited = once(child, 'exit') as Promise<[number | null, string | null]>;
  const wait = async (predicate: () => boolean, ms = 30_000) => {
    for (let i = 0; i < ms / 10; i++) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`listener exited before control: ${stderr}; ${raw}`);
      await delay(10);
    }
    throw new Error(`listener timeout: ${stderr}; ${raw}`);
  };
  const send = (value: unknown) => child.stdin!.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
  return { child, events, exited, wait, send, raw: () => raw, stderr: () => stderr };
}
const ready = async (client: ReturnType<typeof start>) => { await client.wait(() => client.events.some(e => e.event === 'listening')); return client.events.find(e => e.event === 'listening'); };
const wakes = (client: ReturnType<typeof start>) => client.events.filter(e => e.event === 'wake');
const wakeDoc = () => withStateDb((db) => {
  const row = db.prepare('SELECT state FROM wake_state').get() as { state: string } | undefined;
  return row ? JSON.parse(row.state) : null;
});
const ownerFiles = async () => (await readdir(join(root, '.config'), { recursive: true }).catch(() => [])).filter(p => String(p).endsWith('owner.json'));

it('routes the documented listen command with --protocol', () => {
  expect(parseRepresentativeArgs(['listen', '--worktree', '/fixture', '--protocol', '2'])).toEqual({ ok: true, command: { action: 'listen', worktree: '/fixture', protocol: 2 } });
  expect(parseRepresentativeArgs(['listen', '--replay-after', randomUUID()])).toMatchObject({ ok: false });
  expect(parseRepresentativeArgs(['listen', '--protocol', 'two'])).toMatchObject({ ok: false });
});

it.each([['none'], ['1']])('refuses protocol %s as its only stdout line, before any state or lease', async (protocol) => {
  const client = start('listen', { protocol });
  const [code] = await client.exited;
  expect(code).toBe(2);
  expect(client.events).toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_PROTOCOL_REQUIRED', exit_code: 2 }]);
  expect(requests).toHaveLength(0); expect(await ownerFiles()).toEqual([]);
});

it('refuses without a host pipe on stdin (/dev/null)', async () => {
  const client = start('listen', { stdin: 'ignore' });
  const [code] = await client.exited;
  expect(code).toBe(2);
  expect(client.events).toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_HOST_REQUIRED', exit_code: 2 }]);
  expect(requests).toHaveLength(0); expect(await ownerFiles()).toEqual([]);
});

it('announces protocol 2, wakes body-free for a new reply, and applies the host ack', async () => {
  const client = start();
  const hello = await ready(client);
  expect(hello).toEqual({ event: 'listening', protocol: 2, binding_fingerprint: bindingFingerprint(bindingFor(worktree, { origin, boundAt: '2020-01-01T00:00:00.000Z' })), undelivered: 0 });
  await client.wait(() => responses.length > 0);
  reply(); trigger();
  await client.wait(() => wakes(client).length === 1);
  const [wake] = wakes(client);
  expect(wake).toEqual({ event: 'wake', wake_id: expect.stringMatching(/^[0-9a-f-]{36}$/), reason: 'new-reply', count: 1 });
  expect(client.raw()).not.toContain('BODY_SENTINEL');
  expect(wakeDoc().outstanding.batch).toBe(wake.wake_id);
  client.send('x'.repeat(5000)); // oversized: ignored
  client.send({ wake_id: wake.wake_id, accepted: true });
  for (let i = 0; i < 300 && wakeDoc().outstanding !== null; i++) await delay(10);
  expect(wakeDoc()).toMatchObject({ outstanding: null, refusals: { count: 0 } });
  client.child.kill('SIGTERM');
  const [code] = await client.exited;
  expect(code).toBe(0);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
});

it('sends one startup wake for replies undelivered before it started', async () => {
  reply('a'); reply('b'); reply('c');
  const client = start();
  await ready(client);
  await client.wait(() => wakes(client).length === 1);
  expect(wakes(client)[0]).toMatchObject({ reason: 'startup', count: 3 });
});

it('exits 0 on EOF from its host and releases the lease', async () => {
  const client = start();
  await ready(client);
  expect(await ownerFiles()).toHaveLength(1);
  client.child.stdin!.end();
  const [code] = await client.exited;
  expect(code).toBe(0);
  expect(await ownerFiles()).toEqual([]);
  const next = start(); await ready(next); // the lease is free
});

it('refuses a second listener (exit 3) without changing state', async () => {
  const first = start(); await ready(first);
  for (let i = 0; i < 300 && wakeDoc()?.cohort == null; i++) await delay(10); // the startup capture completed
  const before = wakeDoc();
  const second = start();
  const [code] = await second.exited;
  expect(code).toBe(3);
  expect(second.events).toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_OWNED', exit_code: 3, owner_pid: first.child.pid, owner_started_at: expect.any(String) }]);
  expect(wakeDoc()).toEqual(before);
});

it('persists a wake before writing it: killed in between, the restart does not re-emit it early', async () => {
  const crashed = start('listen', { env: { LISTEN_KILL_AFTER_PERSIST: '1' } });
  await ready(crashed);
  await crashed.wait(() => responses.length > 0);
  reply(); trigger();
  const [, signal] = await crashed.exited;
  expect(signal).toBe('SIGKILL');
  expect(wakes(crashed)).toEqual([]);
  const persisted = wakeDoc().outstanding;
  expect(persisted).toMatchObject({ reason: 'new-reply', replies: [expect.any(String)] });
  // The killed process still holds the listener lease until it is reclaimable;
  // like the host, retry a refused (exit 3) start.
  let restarted = start();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const outcome = await Promise.race([restarted.exited.then(() => 'exited'), restarted.wait(() => restarted.events.some(e => e.event === 'listening')).then(() => 'ready', () => 'exited')]);
    if (outcome === 'ready') break;
    expect(restarted.events).toEqual([expect.objectContaining({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_OWNED' })]);
    await delay(500);
    restarted = start();
  }
  await ready(restarted);
  await delay(3_000); // well past the debounce: the outstanding batch holds the wake until its deadline
  expect(wakes(restarted)).toEqual([]);
  expect(wakeDoc().outstanding).toEqual(persisted);
});

it.each(['rebound', 'evicted'])('stops on %s during a live connection (exit 4), releasing its lease', async (kind) => {
  const client = start(); await ready(client);
  await client.wait(() => responses.length > 0);
  if (kind === 'evicted') { status = 410; for (const res of responses) res.end(); }
  else await createRepresentativeStore().saveBinding(bindingFor(worktree, { origin, coordinatorDroneId: randomUUID() }), { rebind: true });
  trigger();
  const [code] = await client.exited;
  expect(code).toBe(4);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: kind, exit_code: 4 });
  expect(await ownerFiles()).toEqual([]);
});

it('reports the listener and its wake state in status without mutation', async () => {
  const client = start(); await ready(client);
  await client.wait(() => responses.length > 0);
  reply(); trigger();
  await client.wait(() => wakes(client).length === 1);
  const before = wakeDoc();
  const probe = start('status'); await probe.exited;
  const snapshot = JSON.parse(probe.raw());
  expect(snapshot.listener).toMatchObject({ protocol: 2, running: true, pid: client.child.pid,
    wakes: { undelivered: 1, outstanding: { wake_id: wakes(client)[0].wake_id, count: 1 }, cohort_open: false } });
  expect(wakeDoc()).toEqual(before);
});

it('refuses a missing binding at startup as the only stdout line', async () => {
  withStateDb(db => db.prepare('DELETE FROM bindings').run());
  const client = start(); const [code] = await client.exited;
  expect(code).toBe(2); expect(client.events).toEqual([{ event: 'refused', code: 'NOT_PREPARED', exit_code: 2 }]);
  expect(requests).toHaveLength(0);
});

it.each([['evicted', 'BACKEND_ERROR'], ['rebound', 'BINDING_MISMATCH']])('refuses startup %s with the MCP code before lease creation', async (mode, code) => {
  const client = start(mode); const [exit] = await client.exited;
  expect(exit).toBe(2); expect(JSON.parse(client.raw())).toEqual({ event: 'refused', code, exit_code: 2 });
  expect(await ownerFiles()).toEqual([]); expect(requests).toHaveLength(0);
});

it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'typed'])('refuses startup with SERVER_UNREACHABLE when verification fails with %s', async code => {
  const client = start(`unreachable:${code}`); const [exit] = await client.exited;
  expect(exit).toBe(1); expect(client.raw().trim().split('\n').map(line => JSON.parse(line)))
    .toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_SERVER_UNREACHABLE', exit_code: 1 }]);
  expect(await ownerFiles()).toEqual([]); expect(requests).toHaveLength(0);
});

it('keeps a permanent untyped verification failure off SERVER_UNREACHABLE', async () => {
  const client = start('unreachable:'); const [exit] = await client.exited;
  expect(exit).toBe(1); expect(JSON.parse(client.raw())).toEqual({ event: 'refused', code: 'REPRESENTATIVE_LISTENER_STORAGE_REFUSED', exit_code: 1 });
});

it('emits one typed fatal startup storage refusal without a lease', async () => {
  const config = join(root, '.config', 'borgmcp'); await chmod(config, 0o777);
  const client = start(); const [code] = await client.exited; expect(code).toBe(1);
  expect(client.events).toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_STORAGE_REFUSED', exit_code: 1 }]);
  await chmod(config, 0o700);
  expect(await ownerFiles()).toEqual([]);
});

it('stops on changed authority trust during an open connection before another wake', async () => {
  const client = start(); await ready(client);
  await client.wait(() => responses.length > 0);
  await writeFile(join(worktree, 'fixture-trust'), 'changed-trust');
  reply(); trigger();
  const [code] = await client.exited;
  expect(code).toBe(4);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'trust-changed', exit_code: 4 });
  expect(wakes(client)).toEqual([]);
  expect(await ownerFiles()).toEqual([]);
});

it('reports a killed listener as not running without reclaiming its lock', async () => {
  const client = start(); await ready(client); client.child.kill('SIGKILL'); await client.exited;
  const probe = start('status'); await probe.exited;
  expect(JSON.parse(probe.raw()).listener.running).toBe(false);
  expect(await ownerFiles()).toHaveLength(1);
});

describe('review controls (S2 round 1): EOF and startup under a growing log', () => {
  it('EOF stops discovery even while every page reports more, and exits promptly', async () => {
    const client = start(); await ready(client); await client.wait(() => responses.length > 0);
    await delay(100);
    const original = cube.backend.bind(cube); let grow = true; let calls = 0;
    cube.backend = () => ({ ...original(), readAfter: async (cursor, limit) => {
      if (!grow) return original().readAfter(cursor, limit);
      calls++; await delay(25);
      const entry = cube.post(COORD_ID, 'growth', [REP_ID], new Date(Date.now() + calls * 1000).toISOString());
      return { entries: [entry], has_more: true, behind_by: 1 };
    } });
    trigger(); await client.wait(() => calls >= 3);
    client.child.stdin!.end(); const atEof = calls;
    await delay(300);
    const afterEof = calls;
    const exitedWhileGrowing = client.child.exitCode;
    grow = false;
    const [code] = await client.exited;
    expect(afterEof).toBeLessThanOrEqual(atEof + 1);
    expect(exitedWhileGrowing).toBe(0);
    expect(code).toBe(0);
    expect(await ownerFiles()).toEqual([]);
  });

  it('announces listening before any log walk: startup is not starved by a growing log', async () => {
    const initial = start(); await ready(initial); initial.child.stdin!.end(); await initial.exited;
    const original = cube.backend.bind(cube); let grow = true; let calls = 0; const limits: number[] = [];
    cube.backend = () => ({ ...original(), readAfter: async (cursor, limit) => {
      if (!grow) return original().readAfter(cursor, limit);
      calls++; limits.push(limit); await delay(25);
      const entries = Array.from({ length: limit }, (_, i) => cube.post(COORD_ID, 'startup growth', [REP_ID], new Date(1900000000000 + calls * 10000 + i).toISOString()));
      return { entries, has_more: true, behind_by: 10_000 };
    } });
    const client = start();
    // Listening arrives while the log is still growing without end: the startup cannot be starved.
    await client.wait(() => client.events.some(e => e.event === 'listening'), 10_000);
    await client.wait(() => calls >= 12);
    const listenedWhileGrowing = client.events.some(e => e.event === 'listening');
    grow = false;
    client.child.stdin!.end();
    const [code] = await client.exited;
    expect(listenedWhileGrowing).toBe(true);
    expect(limits[0]).toBe(1); // the cohort capture: one bounded request, not a walk
    expect(limits.slice(1).every(limit => limit === 200)).toBe(true); // then ordinary discovery pages
    expect(code).toBe(0);
  });

  it('exits on EOF while the startup capture request hangs', async () => {
    const initial = start(); await ready(initial); initial.child.stdin!.end(); await initial.exited;
    const original = cube.backend.bind(cube);
    cube.backend = () => ({ ...original(), readAfter: () => new Promise(() => {}) }); // never answers
    const client = start(); await ready(client);
    await delay(200);
    const stoppedAt = Date.now();
    client.child.stdin!.end();
    const [code] = await client.exited;
    expect(code).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(await ownerFiles()).toEqual([]);
  });
});

describe('review controls (S2 round 3): every startup step honors EOF', () => {
  it('exits on EOF during the imported 5.x binding head walk, with page 1 held, after announcing listening', async () => {
    const { plantLegacyBindings } = await import('./fixtures/representative-state.js');
    const { representativeStateRoot } = await import('../src/representative-db.js');
    await rm(representativeStateRoot(), { recursive: true, force: true });
    plantLegacyBindings(root, [bindingFor(worktree, { origin, boundAt: '2020-01-01T00:00:00.000Z' })]);
    const original = cube.backend.bind(cube); let calls = 0; let release!: () => void;
    const hold = new Promise<void>((done) => { release = done; });
    cube.backend = () => ({ ...original(), readAfter: async (cursor, limit) => { calls++; await hold; return original().readAfter(cursor, limit); } });
    const client = start();
    await client.wait(() => calls > 0);
    // The head walk runs after `listening`: the host sees the listener up while page 1 is held.
    expect(client.events.map((event) => event.event)).toEqual(['listening']);
    const stoppedAt = Date.now();
    client.child.stdin!.end();
    for (let i = 0; i < 400 && client.child.exitCode === null; i++) await delay(10);
    const exitBeforeRelease = client.child.exitCode;
    const eventsBeforeRelease = client.events.map((event) => event.event);
    release();
    await client.exited;
    expect(exitBeforeRelease).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(4_000);
    expect(eventsBeforeRelease).toEqual(['listening', 'stopped']);
    expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'eof', exit_code: 0 });
    expect(calls).toBe(1);
    expect(await ownerFiles()).toEqual([]);
  }, 15_000);

  it('exits 0 on EOF while the startup server verification is held, before announcing anything', async () => {
    const original = cube.backend.bind(cube); let calls = 0;
    cube.backend = () => ({ ...original(), whoami: async () => { calls++; return new Promise(() => {}); } });
    const client = start();
    await client.wait(() => calls > 0);
    const stoppedAt = Date.now();
    client.child.stdin!.end();
    const [code] = await client.exited;
    expect(code).toBe(0);
    expect(Date.now() - stoppedAt).toBeLessThan(4_000);
    expect(client.events).toEqual([]);
    expect(await ownerFiles()).toEqual([]);
  }, 15_000);
});

