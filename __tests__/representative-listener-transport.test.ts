import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepresentativeStore } from '../src/representative-store.js';
import { bindingFor, CUBE_ID, REP_ID, COORD_ID } from './fixtures/representative-mock-backend.js';

// Production pinned-HTTPS transport (createPinnedServerFetch) against a disposable
// local TLS server; abrupt resets surface Node errno/string-code errors.
let root: string, worktree: string, file: string, origin: string, cert: string, server: Server;
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let responses: ServerResponse[], entries: any[], requests: number;
const children: ChildProcess[] = [];
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));
function entry(index: number) {
  return { id: randomUUID(), cube_id: CUBE_ID, drone_id: COORD_ID, drone_label: 'coordinator', role_name: 'Coordinator',
    message: 'BODY_SENTINEL', visibility: 'direct', recipient_drone_ids: [REP_ID], created_at: new Date(1700000000000 + index * 1000).toISOString() };
}
function frame(value: any) {
  return `event: log\nid: ${value.id}\ndata: ${JSON.stringify({ ...value, cursor: { id: value.id, created_at: value.created_at } })}\n\n`;
}
function stream(res: ServerResponse) {
  responses.push(res); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
  // Replay deliberately includes already-delivered entries to exercise dedupe.
  for (const value of entries) res.write(frame(value));
  res.write('event: bookmark\ndata: {}\n\n');
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'rep-listener-tls-')));
  worktree = join(root, 'work'); await mkdir(worktree, { mode: 0o700 });
  file = join(root, 'representative.json'); responses = []; entries = []; requests = 0; handle = (_req, res) => stream(res);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  cert = join(root, 'cert.pem');
  server = createServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(cert) }, (req, res) => { requests++; handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `https://127.0.0.1:${(server.address() as any).port}`;
  await createRepresentativeStore(file).saveBinding(bindingFor(worktree, { origin }), { rebind: false });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }));
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await rm(root, { recursive: true, force: true });
});
function start() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('__tests__/fixtures/representative-listener-process.ts'), worktree, file, origin, 'listen'],
    { env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), REPRESENTATIVE_TEST_PIN_CERT: cert }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const events: any[] = []; let stderr = '', buffer = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  child.stdout!.on('data', chunk => {
    buffer += chunk; let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) events.push(JSON.parse(line)); }
  });
  const exited = once(child, 'exit');
  const wait = async (predicate: () => boolean) => {
    for (let i = 0; i < 3000; i++) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`listener exited before control: ${stderr}; ${JSON.stringify(events)}`);
      await delay(10);
    }
    throw new Error(`listener timeout: ${stderr}; ${JSON.stringify(events)}`);
  };
  return { child, events, exited, wait };
}
const count = (events: any[], name: string) => events.filter(e => e.event === name).length;

it('reconnects after abrupt pinned-TLS resets, including mid-frame, without duplicate appends', async () => {
  const client = start(); await client.wait(() => count(client.events, 'listening') === 1);
  const hello = client.events.find(e => e.event === 'listening');
  for (let i = 0; i < 3; i++) {
    const value = entry(i); entries.push(value); responses.at(-1)!.write(frame(value));
    await client.wait(() => count(client.events, 'entry') === i + 1);
    const before = requests;
    // Alternate a clean-boundary reset with a reset inside a partially written frame.
    if (i % 2) responses.at(-1)!.write(frame(entry(99)).slice(0, 40));
    responses.at(-1)!.destroy();
    await client.wait(() => requests > before && count(client.events, 'connected') === i + 1);
  }
  expect(client.events.filter(e => e.event === 'reconnecting')).toEqual([1, 2, 3].map(attempt => ({ event: 'reconnecting', attempt, delay_ms: 10 })));
  expect(client.events.filter(e => e.event === 'entry').map(e => e.entry_id)).toEqual(entries.map(e => e.id));
  const raw = await readFile(hello.inbox, 'utf8');
  entries.forEach(e => expect(raw.split(`[entry_id: ${e.id}]`).length - 1).toBe(1));
  expect(raw.trim().split('\n')).toHaveLength(entries.length);
  client.child.kill('SIGTERM'); const [code] = await client.exited;
  expect(code).toBe(0); expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
  expect(client.events.some(e => e.event === 'refused')).toBe(false);
});

it('retries a pinned-TLS reset before listening instead of refusing startup', async () => {
  handle = (req, res) => { if (requests === 1) req.socket.destroy(); else stream(res); };
  const client = start(); await client.wait(() => count(client.events, 'listening') === 1);
  expect(requests).toBe(2);
  expect(client.events.map(e => e.event)).toEqual(['listening']);
  client.child.kill('SIGTERM'); const [code] = await client.exited;
  expect(code).toBe(0); expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
});
