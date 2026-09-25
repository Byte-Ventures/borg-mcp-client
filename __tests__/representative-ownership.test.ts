import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRepresentativeStore } from '../src/representative-store.js';
import { MockCube, bindingFor, COORD_ID, REP_ID, BUILDER_ID, CUBE_ID } from './fixtures/representative-mock-backend.js';
import { acquireStreamLease, readOwnershipSnapshot } from '../src/stream-owner.js';

let root: string;
let worktree: string;
let ledger: string;
let log: string;
let cube: MockCube;
let appendBarrier: { entered: () => void; wait: Promise<void> } | undefined;
const children: ChildProcess[] = [];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'rep-owner-')));
  worktree = join(root, 'work'); mkdirSync(worktree);
  ledger = join(root, 'representative.json');
  log = join(root, 'backend.json');
  writeFileSync(log, '[]');
  cube = new MockCube();
  appendBarrier = undefined;
  await createRepresentativeStore(ledger).saveBinding(bindingFor(worktree), { rebind: false });
});
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
    }
  }));
  rmSync(root, { recursive: true, force: true });
});

async function start(heartbeatIntervalMs?: number) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('__tests__/fixtures/representative-process.ts'), worktree, ledger,
    ...(heartbeatIntervalMs === undefined ? [] : [String(heartbeatIntervalMs)])], {
    env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), TMPDIR: root },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  const backend = cube.backend();
  child.on('message', async (message: any) => {
    try {
      if (message.method === 'append' && appendBarrier) {
        const barrier = appendBarrier; appendBarrier = undefined;
        barrier.entered(); await barrier.wait;
      }
      const result = await (backend as any)[message.method](...message.args);
      writeFileSync(log, JSON.stringify(cube.entries));
      if (child.connected) child.send({ id: message.id, result });
    } catch (error: any) {
      if (child.connected) child.send({ id: message.id, error: { message: error.message, code: error.code } });
    }
  });
  let buffer = '', nextId = 0, stderr = '';
  child.stderr!.on('data', (chunk) => { stderr += chunk; });
  const waiting = new Map<number, (reply: any) => void>();
  child.stdout!.on('data', (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      const reply = JSON.parse(line); waiting.get(reply.id)?.(reply); waiting.delete(reply.id);
    }
  });
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => reject(new Error(`Timed out: ${method}; ${stderr}`)), 10000);
    waiting.set(id, (reply) => { clearTimeout(timeout); resolve(reply); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'process-control', version: '1' } });
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    child,
    call: async (name: string, args = {}) => {
      const reply = await request('tools/call', { name: `borg_representative-${name}`, arguments: args });
      return { isError: reply.result.isError === true, body: JSON.parse(reply.result.content[0].text) };
    },
  };
}
// Ledger, backend log and every private delivery-state file (checkpoint and read fence).
function deliveryState(): string[] {
  const base = join(root, '.config', 'borgmcp', 'representative-delivery');
  if (!existsSync(base)) return [];
  return readdirSync(base).flatMap((dir) => readdirSync(join(base, dir)).map((file) => readFileSync(join(base, dir, file), 'utf8')));
}
const snapshot = () => [...[ledger, log].map((file) => readFileSync(file, 'utf8')), ...deliveryState()];
const input = { request_id: '55555555-5555-4555-8555-555555555555', kind: 'question', authorization: 'model_advice', message: 'Once only' };
function ownerPath() {
  const binding = bindingFor(worktree);
  const authority = createHash('sha256').update(JSON.stringify([binding.origin, binding.trustIdentity])).digest('hex');
  return join(root, '.config', 'borgmcp', 'representative-host-locks', authority, CUBE_ID, `${REP_ID}.lock`, 'owner.json');
}
function expireOwner() {
  const file = ownerPath();
  const record = JSON.parse(readFileSync(file, 'utf8'));
  record.heartbeatAt = '2000-01-01T00:00:00.000Z';
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

it('refuses a second real process read before delivery state, ledger or backend changes', async () => {
  const first = await start(), second = await start();
  expect((await first.call('read')).isError).toBe(false);
  const reply = cube.post(COORD_ID, 'Only the owner may consume this reply', [REP_ID]);
  writeFileSync(log, JSON.stringify(cube.entries));
  const before = snapshot(), calls = cube.calls.length;
  const denied = await second.call('read');
  expect(denied.body.error?.code).toBe('REPRESENTATIVE_OWNERSHIP_REQUIRED');
  expect(snapshot()).toEqual(before);
  expect(cube.calls).toHaveLength(calls);
  expect((await first.call('read')).body.replies.map((entry: any) => entry.entry_id)).toEqual([reply.id]);
});

it('starts lazily, status is read-only, and non-owner send/read/deliver/ack have no effects', async () => {
  const first = await start(), second = await start();
  const before = snapshot();
  const stamp = statSync(ledger).mtimeMs;
  expect((await second.call('status')).body.ownership.state).toBe('unowned');
  expect(snapshot()).toEqual(before);
  expect(statSync(ledger).mtimeMs).toBe(stamp);
  expect(existsSync(join(root, '.config', 'borgmcp', 'representative-host-locks'))).toBe(false);
  expect((await first.call('send', input)).isError).toBe(false);
  const status = await second.call('status');
  expect(status.body.ownership).toMatchObject({ state: 'owned-by-other-process', pid: first.child.pid });
  expect(typeof status.body.ownership.startedAt).toBe('string');
  expect(typeof status.body.ownership.ageMs).toBe('number');
  expect((await first.call('read')).isError).toBe(false);
  const stable = snapshot(), calls = cube.calls.length;
  expect(deliveryState()).toHaveLength(1); // the owner's checkpoint file exists and must stay unchanged
  for (const [name, args] of [['send', input], ['read', {}], ['deliver', { through: input.request_id }], ['ack', { entry_id: input.request_id }]] as const) {
    const denied = await second.call(name, args);
    expect(denied.body.error.code).toBe('REPRESENTATIVE_OWNERSHIP_REQUIRED');
    expect(denied.body.error.details.owner.pid).toBe(first.child.pid);
    expect(denied.body.error.message).toContain(status.body.ownership.startedAt);
    expect(snapshot()).toEqual(stable);
    expect(cube.calls).toHaveLength(calls);
  }
  expect((await first.call('status')).body.ownership.state).toBe('owner');
});

it('replays an undelivered reply to the successor after the owner is killed between read and deliver', async () => {
  const first = await start();
  const reply = cube.post(COORD_ID, 'Persist me before deliver', [REP_ID]);
  writeFileSync(log, JSON.stringify(cube.entries));
  expect((await first.call('read')).body.replies.map((entry: any) => entry.entry_id)).toEqual([reply.id]);
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const second = await start();
  expect((await second.call('read')).body.replies.map((entry: any) => entry.entry_id)).toEqual([reply.id]);
  expect((await second.call('deliver', { through: reply.id })).body.advanced).toBe(true);
  expect((await second.call('read')).body.replies).toEqual([]);
});

it.each(['SIGKILL', 'SIGTERM', 'clean'] as const)('takes over after owner %s without manual cleanup', async (mode) => {
  const first = await start(), second = await start();
  await first.call('read');
  expect((await second.call('read')).isError).toBe(true);
  const exited = once(first.child, 'exit');
  if (mode === 'clean') first.child.stdin!.end(); else first.child.kill(mode);
  await exited;
  if (mode !== 'SIGKILL') expect(existsSync(ownerPath())).toBe(false);
  expect((await second.call('read')).isError).toBe(false);
  expect((await second.call('status')).body.ownership.pid).toBe(second.child.pid);
});

it('refreshes an idle owner while status acquires and changes nothing', async () => {
  const first = await start(500), second = await start();
  await first.call('read');
  const heartbeat = () => {
    try { return JSON.parse(readFileSync(ownerPath(), 'utf8')).heartbeatAt as string; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  // Refresh temporarily renames the directory while holding its takeover claim.
  let initial: string | null = null;
  await expect.poll(() => initial = heartbeat(), { timeout: 10000, interval: 25 }).not.toBeNull();
  await expect.poll(() => { const next = heartbeat(); return next !== null && next !== initial; },
    { timeout: 10000, interval: 25 }).toBe(true);
  const before = snapshot();
  await expect.poll(async () => (await second.call('status')).body.ownership?.pid,
    { timeout: 10000, interval: 25 }).toBe(first.child.pid);
  expect(snapshot()).toEqual(before);
  // Heartbeats may continue during status, so file timestamps are not a status
  // side effect. The lazy-status control separately proves no lease creation.
});

it('status does not prune or rewrite an existing ledger', async () => {
  const file = JSON.parse(readFileSync(ledger, 'utf8'));
  file.requests[worktree] = Array.from({ length: 201 }, (_, i) => ({
    requestId: `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`,
    payloadDigest: 'digest', kind: 'question', authorization: 'model_advice', state: 'sent',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  }));
  writeFileSync(ledger, JSON.stringify(file), { mode: 0o600 });
  const first = await start(), second = await start(), before = snapshot();
  expect((await first.call('status')).isError).toBe(false);
  expect((await second.call('status')).isError).toBe(false);
  expect(snapshot()).toEqual(before);
});

it('refuses the former owner after stale takeover and refresh failure', async () => {
  const first = await start(), second = await start();
  await first.call('read');
  first.child.kill('SIGSTOP'); expireOwner();
  expect((await second.call('read')).isError).toBe(false);
  first.child.kill('SIGCONT');
  const before = snapshot(), calls = cube.calls.length;
  expect((await first.call('read')).body.error.code).toBe('REPRESENTATIVE_OWNERSHIP_REQUIRED');
  expect(snapshot()).toEqual(before); expect(cube.calls).toHaveLength(calls);
});

it('stores one entry when the same request id crosses an in-flight stale takeover', async () => {
  const first = await start(), second = await start();
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  appendBarrier = { entered, wait: new Promise<void>((resolve) => { release = resolve; }) };
  const oldSend = first.call('send', input);
  await reached;
  first.child.kill('SIGSTOP'); expireOwner();
  const newSend = await second.call('send', input);
  expect(newSend.body.outcome).toBe('sent');
  first.child.kill('SIGCONT'); release();
  expect((await oldSend).body.outcome).toBe('ambiguous');
  expect(cube.entries.filter((entry) => entry.drone_id === REP_ID)).toHaveLength(1);
  expect((await second.call('send', input)).body.entry_id).toBe(newSend.body.entry_id);
});

it.each(['rebind', 'eviction'] as const)('both processes fail closed after %s', async (change) => {
  const first = await start(), second = await start();
  await first.call('read');
  if (change === 'rebind') await createRepresentativeStore(ledger).saveBinding(bindingFor(worktree, { coordinatorDroneId: BUILDER_ID }), { rebind: true });
  else cube.drones = cube.drones.filter((drone) => drone.id !== REP_ID);
  const before = snapshot();
  expect((await first.call('read')).isError).toBe(true);
  expect((await second.call('read')).isError).toBe(true);
  expect(snapshot()).toEqual(before);
});

it('does not acquire or report an ordinary drone stream lease', async () => {
  const locksDir = join(root, '.config', 'borgmcp', 'stream-locks');
  const ordinary = await acquireStreamLease(CUBE_ID, REP_ID, undefined, { locksDir });
  const first = await start();
  expect((await first.call('status')).body.ownership.state).toBe('unowned');
  expect((await first.call('read')).isError).toBe(false);
  expect((await readOwnershipSnapshot(CUBE_ID, REP_ID, { locksDir })).pid).toBe(process.pid);
  await ordinary!.release();
});
