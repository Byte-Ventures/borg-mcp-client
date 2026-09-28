import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:https';
import { X509Certificate, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRepresentativeStore } from '../src/representative-store.js';
import { bindingFor, CUBE_ID, REP_ID, COORD_ID, MockCube } from './fixtures/representative-mock-backend.js';
import { serveBackend } from './fixtures/backend-proxy.js';

// Production pinned-HTTPS transport (createPinnedServerFetch) against a disposable
// local TLS server; abrupt resets surface Node errno/string-code errors.
let root: string, worktree: string, origin: string, cert: string, server: Server;
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let responses: ServerResponse[], entries: any[], requests: number;
let cube: MockCube, backend: { url: string; close(): Promise<void> };
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
  // In-process store writes and the child listener share this private root.
  process.env.HOME = root; process.env.BORG_STATE_ROOT = root;
  worktree = join(root, 'work'); await mkdir(worktree, { mode: 0o700 });
  responses = []; entries = []; requests = 0; handle = (_req, res) => stream(res);
  cube = new MockCube(); backend = await serveBackend(cube);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  cert = join(root, 'cert.pem');
  server = createServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(cert) }, (req, res) => { requests++; handle(req, res); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `https://127.0.0.1:${(server.address() as any).port}`;
  await createRepresentativeStore().saveBinding(bindingFor(worktree, { origin, boundAt: '2020-01-01T00:00:00.000Z' }), { rebind: false });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  }));
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await backend.close();
  await rm(root, { recursive: true, force: true });
});
function start(extraEnv: Record<string, string> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('__tests__/fixtures/representative-listener-process.ts'), worktree, origin, 'listen'],
    { env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), REPRESENTATIVE_TEST_PIN_CERT: cert, BACKEND_URL: backend.url, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  return { child, events, exited, wait, stderr: () => stderr };
}
const count = (events: any[], name: string) => events.filter(e => e.event === name).length;

it('reconnects after abrupt pinned-TLS resets, including mid-frame, and wakes each reply exactly once', async () => {
  const client = start(); await client.wait(() => count(client.events, 'listening') === 1 && responses.length === 1);
  const posted: string[] = [];
  for (let i = 0; i < 3; i++) {
    const value = entry(i);
    posted.push(cube.post(COORD_ID, value.message, [REP_ID], new Date().toISOString()).id);
    responses.at(-1)!.write(frame(value)); // a trigger: discovery reads the log itself
    await client.wait(() => count(client.events, 'wake') === i + 1);
    const wake = client.events.filter(e => e.event === 'wake').at(-1);
    client.child.stdin!.write(`${JSON.stringify({ wake_id: wake.wake_id, accepted: true })}\n`);
    const before = requests;
    // Alternate a clean-boundary reset with a reset inside a partially written frame.
    if (i % 2) responses.at(-1)!.write(frame(entry(99)).slice(0, 40));
    responses.at(-1)!.destroy();
    await client.wait(() => requests > before && responses.length === before + 1);
    await delay(300); // the reconnect's own discovery finds nothing new
  }
  expect(client.events.filter(e => e.event === 'wake').map(e => [e.reason, e.count])).toEqual([['new-reply', 1], ['new-reply', 1], ['new-reply', 1]]);
  client.child.kill('SIGTERM'); const [code] = await client.exited;
  expect(code).toBe(0); expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
  expect(client.events.some(e => e.event === 'refused')).toBe(false);
  expect(posted).toHaveLength(3);
}, 60_000);

it('retries a pinned-TLS reset before listening instead of refusing startup', async () => {
  handle = (req, res) => { if (requests === 1) req.socket.destroy(); else stream(res); };
  // Listening is announced before the stream connects; the reset only delays the stream.
  const client = start(); await client.wait(() => count(client.events, 'listening') === 1 && responses.length === 1);
  expect(requests).toBe(2);
  expect(client.events.map(e => e.event)).toEqual(['listening']);
  client.child.kill('SIGTERM'); const [code] = await client.exited;
  expect(code).toBe(0); expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'signal', exit_code: 0 });
});

// Production trust: no injected loader or fetch, so the process-lifetime cache
// of the local-authority loader is exercised. Trust files change A -> B after
// `listening` while the A connection stays open; the next frame must not land.
it('stops on local authority trust replaced during an open connection with the production loader', async () => {
  const spki = (pem: string) => createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const authority = join(root, 'authority'); await mkdir(authority, { mode: 0o700 });
  const certA = await readFile(cert, 'utf8');
  const writeTrust = async (pem: string) => {
    for (const [name, value] of [['ca.crt', pem], ['server.json', JSON.stringify({ ca_spki_sha256: spki(pem) })]]) {
      await writeFile(join(authority, `${name}.tmp`), value, { mode: 0o600 }); await rename(join(authority, `${name}.tmp`), join(authority, name));
    }
  };
  await writeTrust(certA);
  const identityA = `spki-sha256:${spki(certA)}`;
  await createRepresentativeStore().saveBinding(bindingFor(worktree, { origin, trustIdentity: identityA }), { rebind: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'b-key.pem'), '-out', join(root, 'b-cert.pem'),
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore' });
  const client = start({ BORG_SERVER_DATA_DIR: authority, REPRESENTATIVE_TEST_TRUST_IDENTITY: identityA });
  await client.wait(() => count(client.events, 'listening') === 1 && responses.length === 1);
  // Positive control: before the change a reply wakes over the same connection.
  const before = entry(1); cube.post(COORD_ID, before.message, [REP_ID], new Date().toISOString()); responses.at(-1)!.write(frame(before));
  await client.wait(() => count(client.events, 'wake') === 1);
  await writeTrust(await readFile(join(root, 'b-cert.pem'), 'utf8'));
  const after = { ...entry(2), message: 'POST_TRUST_CHANGE_SENTINEL' };
  cube.post(COORD_ID, after.message, [REP_ID], new Date().toISOString()); responses.at(-1)!.write(frame(after));
  // Either outcome ends the wait: the listener exits, or it wakes for the post-change reply.
  for (let i = 0; i < 1000 && client.child.exitCode === null && count(client.events, 'wake') < 2; i++) await delay(10);
  expect(count(client.events, 'wake')).toBe(1);
  const [code] = await client.exited;
  expect(code).toBe(4);
  expect(client.events.at(-1)).toEqual({ event: 'stopped', reason: 'trust-changed', exit_code: 4 });
  expect(requests).toBe(1);
  expect((await readdir(join(root, '.config'), { recursive: true })).filter(p => String(p).endsWith('owner.json'))).toEqual([]);
});
