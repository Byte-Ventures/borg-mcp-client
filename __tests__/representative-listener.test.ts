import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, readdir, chmod, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepresentativeStore } from '../src/representative-store.js';
import { bindingFor, CUBE_ID, REP_ID, COORD_ID } from './fixtures/representative-mock-backend.js';
import { formatInboxLine } from '../src/log-stream.js';
import { parseRepresentativeArgs } from '../src/representative-cmd.js';
let root: string, worktree: string, file: string, origin: string, server: Server;
let responses: ServerResponse[], requests: URL[], entries: any[], status: number, errorCode: string, expireOnce: boolean;
const children: ChildProcess[] = [];
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
function entry(index: number, message = 'BODY_SENTINEL', visibility = 'direct') {
  return { id: randomUUID(), cube_id: CUBE_ID, drone_id: COORD_ID,
    drone_label: 'coordinator', role_name: 'Coordinator', message, visibility,
    recipient_drone_ids: [REP_ID], created_at: new Date(1700000000000 + index * 1000).toISOString() };
}
function frame(value: any) {
  return `event: log\nid: ${value.id}\ndata: ${JSON.stringify({ ...value, cursor: { id: value.id, created_at: value.created_at } })}\n\n`;
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rep-listener-')));
  worktree = join(root, 'work'); await mkdir(worktree, { mode: 0o700 });
  file = join(root, 'representative.json'); responses = []; requests = []; entries = []; status = 200; errorCode = 'DRONE_EVICTED'; expireOnce = false;
  server = createServer((req, res) => {
    const url = new URL(req.url!, origin); requests.push(url);
    if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: errorCode, message: 'fixture error' } })); if (expireOnce) { status = 200; expireOnce = false; } return; }
    responses.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    // Replay deliberately includes old entries to exercise client dedupe.
    for (const value of entries) res.write(frame(value));
    res.write('event: bookmark\ndata: {}\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
  await createRepresentativeStore(file).saveBinding(bindingFor(worktree, { origin }), { rebind: false });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }));
  for (const res of responses) res.destroy();
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
});
function start(action = 'listen', replayAfter?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('__tests__/fixtures/representative-listener-process.ts'), worktree, file, origin, action, ...(replayAfter ? [replayAfter] : [])],
    { env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config') }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const events: any[] = []; let raw = '', stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.stdout!.on('data', chunk => {
    raw += chunk; buffer += chunk;
    if (action !== 'listen') return;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) events.push(JSON.parse(line)); }
  });
  const exited = once(child, 'exit');
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 3000; i++) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`listener exited before control: ${stderr}; ${raw}`);
      await delay(10);
    }
    throw new Error(`listener timeout: ${stderr}; ${raw}`);
  };
  return { child, events, exited, wait, raw: () => raw };
}
async function stop(client: ReturnType<typeof start>, signal: NodeJS.Signals = 'SIGTERM') { client.child.kill(signal); return client.exited; }
async function ready(client: ReturnType<typeof start>) { await client.wait(() => client.events.some(e => e.event === 'listening')); return client.events.find(e => e.event === 'listening'); }
async function send(values: any[]) { entries.push(...values); for (const res of responses) if (!res.destroyed) for (const value of values) res.write(frame(value)); }
async function files(dir: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, item.name); if (item.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
it('routes the documented listen command', () => {
  expect(parseRepresentativeArgs(['listen', '--worktree', '/fixture'])).toEqual({ ok: true, command: { action: 'listen', worktree: '/fixture' } });
});
it('persists a burst once in order and emits body-free hints with positive and negative correlation', async () => {
  const client = start(), hello = await ready(client), request = randomUUID();
  const values = [entry(1, `BODY_SENTINEL request_id: ${request}`), entry(2, 'BODY_SENTINEL request_id: invalid'), ...Array.from({ length: 18 }, (_, i) => entry(i + 3))];
  await send(values); await client.wait(() => client.events.filter(e => e.event === 'entry').length === 20);
  expect(client.events.filter(e => e.event === 'entry').map(e => e.entry_id)).toEqual(values.map(e => e.id));
  expect(client.events.filter(e => e.event === 'entry').map(e => e.request_id)).toEqual([request, ...Array(19).fill(null)]);
  expect(client.raw()).not.toContain('BODY_SENTINEL');
  const lines = (await readFile(hello.inbox, 'utf8')).trim().split('\n'); expect(lines).toHaveLength(20);
  values.forEach((value, i) => expect(lines[i]).toContain(`[entry_id: ${value.id}]`));
  await stop(client); expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
});
it('resumes after SIGKILL mid-burst from the persisted cursor without duplicate appends', async () => {
  const first = start(), hello = await ready(first); await send([entry(1), entry(2)]);
  await first.wait(() => first.events.filter(e => e.event === 'entry').length === 2); await stop(first, 'SIGKILL');
  entries.push(entry(3), entry(4)); const second = start(); await ready(second);
  await second.wait(() => second.events.filter(e => e.event === 'entry').length === 2);
  const cursor = JSON.parse(Buffer.from(requests.at(-1)!.searchParams.get('cursor')!, 'base64url').toString());
  expect(cursor.id).toBe(entries[1].id);
  const raw = await readFile(hello.inbox, 'utf8'); entries.forEach(e => expect(raw.split(`[entry_id: ${e.id}]`).length - 1).toBe(1));
});
it('deduplicates five reconnect bursts including already-written hint events', async () => {
  const client = start(); await ready(client);
  for (let i = 0; i < 5; i++) {
    await send([entry(i)]); await client.wait(() => client.events.filter(e => e.event === 'entry').length === i + 1);
    const count = requests.length; responses.at(-1)!.end(); await client.wait(() => requests.length > count);
  }
  expect(client.events.filter(e => e.event === 'entry')).toHaveLength(5);
  expect(client.events.filter(e => e.event === 'reconnecting')).toHaveLength(5);
});
it('refuses a second listener without changing inbox or lock and takes over after kill', async () => {
  const first = start(), hello = await ready(first); await send([entry(1)]); await first.wait(() => first.events.some(e => e.event === 'entry'));
  const raw = await readFile(hello.inbox, 'utf8'); const second = start(); const [code] = await second.exited;
  expect(code).toBe(3); expect(second.events).toEqual([{ event: 'refused', code: 'REPRESENTATIVE_LISTENER_OWNED', exit_code: 3, owner_pid: first.child.pid, owner_started_at: expect.any(String) }]);
  expect(await readFile(hello.inbox, 'utf8')).toBe(raw); await stop(first, 'SIGKILL'); await ready(start());
});
it.each(['evicted', 'rebound'])('stops on %s, releases lease and never reconnects', async reason => {
  const client = start(); await ready(client);
  if (reason === 'evicted') { status = 410; responses.at(-1)!.end(); }
  else await createRepresentativeStore(file).saveBinding(bindingFor(worktree, { origin, coordinatorDroneId: randomUUID() }), { rebind: true });
  const [code] = await client.exited; expect(code).toBe(4);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason, exit_code: 4 });
  expect((await files(join(root, '.config'))).filter(p => p.endsWith('owner.json'))).toEqual([]);
});
it('status reports independent tools and listener owners without mutation', async () => {
  const listener = start(); await ready(listener);
  const tool = start('mcp');
  tool.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) + '\n');
  await tool.wait(() => tool.raw().includes('"id":1'));
  tool.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  tool.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'borg_representative-read', arguments: {} } }) + '\n');
  await tool.wait(() => tool.raw().includes('"id":2'));
  const ledger = await readFile(file, 'utf8'); const probe = start('status'); await probe.exited;
  const snapshot = JSON.parse(probe.raw()); expect(snapshot.ownership.pid).toBe(tool.child.pid); expect(snapshot.listener.pid).toBe(listener.child.pid);
  expect(await readFile(file, 'utf8')).toBe(ledger);
});
it.each(['symlink', 'mode'])('refuses an unsafe inbox %s without modifying outside content', async kind => {
  const first = start(), hello = await ready(first); await send([entry(1)]); await first.wait(() => first.events.some(e => e.event === 'entry')); await stop(first);
  const sentinel = join(root, 'sentinel'); await writeFile(sentinel, 'OUTSIDE');
  if (kind === 'symlink') { await rm(hello.inbox); await symlink(sentinel, hello.inbox); }
  else await chmod(join(hello.inbox, '..'), 0o777);
  const second = start(); const [code] = await second.exited; expect(code).not.toBe(0); expect(await readFile(sentinel, 'utf8')).toBe('OUTSIDE'); expect(second.events.some(e => e.event === 'listening')).toBe(false);
});

it.each(['in-tail', 'missing', 'none'])('replays hints for %s checkpoint before live events without body text', async mode => {
  const first = start(), hello = await ready(first); await send([entry(1), entry(2), entry(3)]);
  await first.wait(() => first.events.filter(e => e.event === 'entry').length === 3); await stop(first);
  const raw = await readFile(hello.inbox, 'utf8');
  const checkpoint = mode === 'in-tail' ? entries[0].id : mode === 'missing' ? randomUUID() : undefined;
  const second = start('listen', checkpoint); await ready(second); await send([entry(4)]);
  await second.wait(() => second.events.some(e => e.event === 'entry' && e.entry_id === entries[3].id));
  expect(second.events.filter(e => e.event === 'entry' && e.replay).map(e => e.entry_id))
    .toEqual(mode === 'in-tail' ? entries.slice(1, 3).map(e => e.id) : mode === 'missing' ? entries.slice(0, 3).map(e => e.id) : []);
  expect(second.events.filter(e => e.event === 'gap')).toEqual(mode === 'missing' ? [{ event: 'gap', after: checkpoint, reason: 'replay-checkpoint-missing' }] : []);
  expect(second.events.at(-1)).toMatchObject({ event: 'entry', entry_id: entries[3].id, replay: false });
  expect(second.raw()).not.toContain('BODY_SENTINEL');
  expect(await readFile(hello.inbox, 'utf8')).toContain(raw);
});
it('trims above 1024 to 512 and never re-appends a trimmed id', async () => {
  const first = start(), hello = await ready(first);
  await stop(first);
  entries.push(...Array.from({ length: 1024 }, (_, i) => entry(i)));
  await mkdir(join(hello.inbox, '..'), { recursive: true, mode: 0o700 });
  await writeFile(hello.inbox, entries.map(formatInboxLine).join('\n') + '\n', { mode: 0o600 });
  const trimming = start(); await ready(trimming); await send([entry(1024)]);
  await trimming.wait(() => trimming.events.filter(e => e.event === 'entry').length === 1); await stop(trimming);
  const lines = (await readFile(hello.inbox, 'utf8')).trim().split('\n'); expect(lines).toHaveLength(512);
  expect(lines[0]).toContain(entries[513].id);
  const second = start(); await ready(second); await send([entry(1026)]);
  await second.wait(() => second.events.some(e => e.event === 'entry'));
  expect(second.events.filter(e => e.event === 'entry')).toHaveLength(1);
  expect((await readFile(hello.inbox, 'utf8')).trim().split('\n')).toHaveLength(513);
});
it('refuses a missing binding at startup as the only stdout line without creating state', async () => {
  await rm(file); const client = start(); const [code] = await client.exited;
  expect(code).toBe(2); expect(client.events).toEqual([{ event: 'refused', code: 'NOT_PREPARED', exit_code: 2 }]);
  expect(await files(join(root, '.config'))).toEqual([]); expect(requests).toHaveLength(0);
});
it('preserves distinct live entries with equal timestamps in reverse UUID order', async () => {
  const client = start(); await ready(client);
  const a = { ...entry(1), id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' };
  const b = { ...entry(1), id: '00000000-0000-4000-8000-000000000000' };
  await send([a, b]);
  await client.wait(() => client.events.filter(e => e.event === 'entry').length === 2);
  expect(client.events.filter(e => e.event === 'entry').map(e => e.entry_id)).toEqual([a.id, b.id]);
});

it('preserves a previously unseen older live entry', async () => {
  const client = start(), hello = await ready(client);
  await send([entry(10)]); await client.wait(() => client.events.filter(e => e.event === 'entry').length === 1);
  await send([entry(1)]); await client.wait(() => client.events.filter(e => e.event === 'entry').length === 2);
  expect(client.events.filter(e => e.event === 'entry').map(e => e.entry_id)).toEqual(entries.map(e => e.id));
  expect((await readFile(hello.inbox, 'utf8')).trim().split('\n')).toHaveLength(2);
});

it.each([['evicted', 'BACKEND_ERROR'], ['rebound', 'BINDING_MISMATCH']])('refuses startup %s with the MCP code before lease creation', async (mode, code) => {
  const client = start(mode); const [exit] = await client.exited;
  expect(exit).toBe(2); expect(JSON.parse(client.raw())).toEqual({ event: 'refused', code, exit_code: 2 });
  expect(await files(join(root, '.config'))).toEqual([]); expect(requests).toHaveLength(0);
});

it('latches lost ownership before another inbox write and leaves the successor lock intact', async () => {
  const client = start(), hello = await ready(client);
  await send([entry(1)]); await client.wait(() => client.events.some(e => e.event === 'entry'));
  const ownerPath = (await files(join(root, '.config'))).find(p => p.endsWith('owner.json'))!;
  const successor = JSON.parse(await readFile(ownerPath, 'utf8')); successor.processNonce = randomUUID();
  await writeFile(ownerPath, JSON.stringify(successor), { mode: 0o600 });
  const before = await readFile(hello.inbox, 'utf8'); await send([entry(2)]);
  const [code] = await client.exited; expect(code).toBe(4);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'lease-lost', exit_code: 4 });
  expect(await readFile(hello.inbox, 'utf8')).toBe(before);
  expect(JSON.parse(await readFile(ownerPath, 'utf8')).processNonce).toBe(successor.processNonce);
});

it('reports an expired resume cursor after listening and preserves the durable tail', async () => {
  const first = start(), hello = await ready(first); await send([entry(1)]);
  await first.wait(() => first.events.some(e => e.event === 'entry')); await stop(first);
  status = 410; errorCode = 'CURSOR_EXPIRED'; expireOnce = true;
  const second = start(); await ready(second); await send([entry(2)]);
  await second.wait(() => second.events.some(e => e.event === 'entry'));
  expect(second.events.slice(0, 2).map(e => e.event)).toEqual(['listening', 'gap']);
  expect(second.events[1]).toEqual({ event: 'gap', after: entries[0].id, reason: 'cursor-expired' });
  expect(requests.at(-1)!.searchParams.has('cursor')).toBe(false);
  expect((await readFile(hello.inbox, 'utf8')).trim().split('\n')).toHaveLength(2);
});
