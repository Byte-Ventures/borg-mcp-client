/**
 * Slice 2 delivery semantics: replayable bounded read, explicit deliver
 * checkpoint, migration from the client unread cursor, binding fingerprint.
 * Backend evidence is the controlled in-memory mock, not a real Borg server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILDER_ID, COORD_ID, MockCube, REP_ID, bindingFor } from './fixtures/representative-mock-backend.js';
import {
  deliverRepresentativeReplies,
  readRepresentativeReplies,
  representativeStatus,
  sendRepresentativeMessage,
  serializeRepresentativeResult,
  type RepresentativeContext,
} from '../src/representative-core.js';
import { bindingFingerprint, createRepresentativeStore } from '../src/representative-store.js';
import { deliveryPaths } from '../src/representative-delivery-store.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const WORKTREE = '/work/hermes-representative';
let root: string;
let cube: MockCube;

function context(binding = bindingFor(WORKTREE)): RepresentativeContext {
  return { binding, backend: cube.backend(), store: createRepresentativeStore(join(root, '.config', 'borgmcp', 'representative.json')) };
}
const toRep = (message = 'reply') => cube.post(COORD_ID, message, [REP_ID]);
const ids = (result: { replies: Array<{ entry_id: string }> }) => result.replies.map((reply) => reply.entry_id);
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'NO_ERROR'; } catch (error) { return (error as { code?: string }).code ?? 'UNTYPED'; }
}
function deliveryFiles(): string[] {
  const base = join(root, '.config', 'borgmcp', 'representative-delivery');
  try { return readdirSync(base).flatMap((dir) => readdirSync(join(base, dir)).map((file) => join(base, dir, file))); }
  catch { return []; }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-delivery-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  cube = new MockCube();
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

describe('replayable read and deliver', () => {
  it('returns the same window twice until deliver moves it; deliver through the last makes the next read empty', async () => {
    const entries = [toRep('one'), cube.post(BUILDER_ID, 'not for us', [REP_ID]), toRep('two')];
    const ctx = context();
    const first = await readRepresentativeReplies(ctx, {});
    const second = await readRepresentativeReplies(ctx, {});
    expect(ids(first)).toEqual([entries[0].id, entries[2].id]);
    expect(second).toEqual(first);
    expect(first.checkpoint).toEqual({ entry_id: null, created_at: null });
    expect(first.ignored_entries).toBe(1);
    const delivered = await deliverRepresentativeReplies(ctx, { through: entries[2].id });
    expect(delivered).toMatchObject({ advanced: true, checkpoint: { entry_id: entries[2].id, created_at: entries[2].created_at } });
    const after = await readRepresentativeReplies(ctx, {});
    expect(after.replies).toEqual([]);
    expect(after.has_more).toBe(false);
    expect(after.checkpoint).toEqual({ entry_id: entries[2].id, created_at: entries[2].created_at });
  });

  it('refuses deliver outside the read window and leaves the checkpoint unchanged', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    const ctx = context();
    await readRepresentativeReplies(ctx, { limit: 1 });
    const later = toRep('arrived after the read');
    const other = cube.post(BUILDER_ID, 'worker entry', [REP_ID]);
    for (const through of [b.id, later.id, other.id, '12345678-1234-4123-8123-123456789abc']) {
      expect(await codeOf(deliverRepresentativeReplies(ctx, { through }))).toBe('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY');
    }
    expect((await readRepresentativeReplies(ctx, { limit: 1 })).checkpoint).toEqual({ entry_id: null, created_at: null });
    expect(await deliverRepresentativeReplies(ctx, { through: a.id })).toMatchObject({ advanced: true });
  });

  it('treats the same or an older id as a no-op', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: b.id });
    for (const through of [b.id, a.id]) {
      expect(await deliverRepresentativeReplies(ctx, { through }))
        .toMatchObject({ advanced: false, checkpoint: { entry_id: b.id, created_at: b.created_at } });
    }
  });

  it('refuses malformed and unknown deliver input', async () => {
    const ctx = context();
    for (const input of [{}, { through: 'not-a-uuid' }, { through: toRep().id, extra: 1 }]) {
      expect(await codeOf(deliverRepresentativeReplies(ctx, input))).toBe('INVALID_INPUT');
    }
    expect(await codeOf(readRepresentativeReplies(ctx, { cursor: 'x' }))).toBe('INVALID_INPUT');
  });

  it('replays after a restart between read and deliver, and a lost deliver result never double-advances', async () => {
    const entries = [toRep('a'), toRep('b'), toRep('c')];
    const before = await readRepresentativeReplies(context(), { limit: 2 });
    // Restart: a fresh context and store object over the same private state.
    expect(await readRepresentativeReplies(context(), { limit: 2 })).toEqual(before);
    await deliverRepresentativeReplies(context(), { through: entries[1].id }); // result treated as lost
    expect(await deliverRepresentativeReplies(context(), { through: entries[1].id })).toMatchObject({ advanced: false });
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual([entries[2].id]);
  });

  it('never advances the client unread cursor, the server ack or any other state on read', async () => {
    toRep('a');
    cube.unreadCursorValue = null;
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await readRepresentativeReplies(ctx, {});
    expect(cube.acks).toEqual([]);
    expect(cube.calls.filter((call) => !['whoami', 'roster', 'readAfter', 'unreadCursor'].includes(call))).toEqual([]);
  });

  it('never moves the checkpoint backwards when a read overlaps a deliver in the same process', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const slow = { ...ctx, backend: { ...ctx.backend, readAfter: async (...args: Parameters<typeof ctx.backend.readAfter>) => {
      entered(); await gate; return ctx.backend.readAfter(...args);
    } } };
    toRep('c'); // widens the read fence when the slow read saves it
    const pending = readRepresentativeReplies(slow, {});
    await reached; // the slow read has loaded the pre-deliver state
    expect(await deliverRepresentativeReplies(ctx, { through: b.id })).toMatchObject({ advanced: true });
    release(); await pending;
    const after = await readRepresentativeReplies(ctx, {});
    expect(after.checkpoint).toEqual({ entry_id: b.id, created_at: b.created_at });
    expect(ids(after)).not.toContain(a.id);
  });

  it('reports exactly one advance for two overlapping identical delivers', async () => {
    const entry = toRep();
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = { ...ctx, backend: { ...ctx.backend, readEntry: async (id: string) => {
      reached(); await gate; return ctx.backend.readEntry(id);
    } } };
    const first = deliverRepresentativeReplies(slow, { through: entry.id });
    await entered;
    expect((await deliverRepresentativeReplies(ctx, { through: entry.id })).advanced).toBe(true);
    release();
    expect(await first).toMatchObject({ advanced: false, checkpoint: { entry_id: entry.id } });
  });

  it('stores the checkpoint privately, without message text', async () => {
    const entry = toRep('PRIVATE_MESSAGE_SENTINEL');
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    const files = deliveryFiles();
    // The generation's checkpoint and the seat's migration marker.
    expect(files.map((file) => file.split('/').at(-1)).sort()).toEqual(['checkpoint.json', 'migration.json']);
    for (const file of files) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
      expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE_MESSAGE_SENTINEL');
      expect(readFileSync(file, 'utf8')).not.toContain(WORKTREE);
    }
  });

  it('refuses before writing when the continuation guard fails', async () => {
    const entry = toRep('a');
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    const before = deliveryFiles().map((file) => readFileSync(file, 'utf8'));
    const guarded = { ...ctx, guard: async () => { throw Object.assign(new Error('owner lost'), { code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' }); } };
    expect(await codeOf(deliverRepresentativeReplies(guarded, { through: entry.id }))).toBe('REPRESENTATIVE_OWNERSHIP_REQUIRED');
    expect(deliveryFiles().map((file) => readFileSync(file, 'utf8'))).toEqual(before);
  });
});

describe('bounds', () => {
  it('pages 60 addressed entries with limit 10 in six pages, has_more on five', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => toRep(`reply ${i}`));
    const ctx = context();
    const seen: string[] = [];
    const more: boolean[] = [];
    for (let page = 0; page < 6; page++) {
      const result = await readRepresentativeReplies(ctx, { limit: 10 });
      expect(result.replies).toHaveLength(10);
      seen.push(...ids(result)); more.push(result.has_more);
      await deliverRepresentativeReplies(ctx, { through: result.replies.at(-1)!.entry_id });
    }
    expect(seen).toEqual(entries.map((entry) => entry.id));
    expect(more).toEqual([true, true, true, true, true, false]);
    expect((await readRepresentativeReplies(ctx, { limit: 10 })).replies).toEqual([]);
  });

  it('defaults limit to 10 and refuses out-of-range limit and max_bytes', async () => {
    Array.from({ length: 12 }, () => toRep());
    const ctx = context();
    expect((await readRepresentativeReplies(ctx, {})).replies).toHaveLength(10);
    for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { max_bytes: 4095 }, { max_bytes: 60001 }, { max_bytes: '4096' }]) {
      expect(await codeOf(readRepresentativeReplies(ctx, input))).toBe('INVALID_INPUT');
    }
  });

  it('keeps every measured serialized result within max_bytes, one 3000-byte entry per 4096-byte page', async () => {
    const entries = Array.from({ length: 4 }, (_, i) => toRep(`${i}`.padEnd(3000, 'x')));
    const ctx = context();
    for (const entry of entries) {
      const result = await readRepresentativeReplies(ctx, { max_bytes: 4096 });
      expect(ids(result)).toEqual([entry.id]);
      expect(Buffer.byteLength(serializeRepresentativeResult(result))).toBeLessThanOrEqual(4096);
      expect(result.replies[0].message).toHaveLength(3000);
      await deliverRepresentativeReplies(ctx, { through: entry.id });
    }
  });

  it('returns an entry larger than max_bytes alone, whole and marked oversize', async () => {
    const big = toRep('y'.repeat(5000));
    const next = toRep('small');
    const ctx = context();
    const result = await readRepresentativeReplies(ctx, { max_bytes: 4096 });
    expect(ids(result)).toEqual([big.id]);
    expect(result.replies[0]).toMatchObject({ oversize: true, message: big.message });
    expect(result.has_more).toBe(true);
    await deliverRepresentativeReplies(ctx, { through: big.id });
    const after = await readRepresentativeReplies(ctx, { max_bytes: 4096 });
    expect(ids(after)).toEqual([next.id]);
    expect(after.replies[0].oversize).toBeUndefined();
  });

  it('orders same-millisecond entries by entry id with no skip or repeat across pages', async () => {
    const stamp = '2026-02-01T00:00:00.000Z';
    const entries = Array.from({ length: 7 }, (_, i) => cube.post(COORD_ID, `same ms ${i}`, [REP_ID], stamp));
    const ctx = context();
    const seen: string[] = [];
    for (;;) {
      const result = await readRepresentativeReplies(ctx, { limit: 2 });
      if (result.replies.length === 0) break;
      seen.push(...ids(result));
      await deliverRepresentativeReplies(ctx, { through: result.replies.at(-1)!.entry_id });
    }
    expect(seen).toEqual(entries.map((entry) => entry.id).sort());
  });
});

describe('migration from the client unread cursor', () => {
  it('replays exactly the replies unread at upgrade time', async () => {
    const read = [toRep('read before upgrade 1'), toRep('read before upgrade 2')];
    cube.unreadCursorValue = { id: read[1].id, created_at: read[1].created_at };
    const unread = [toRep('unread 1'), toRep('unread 2')];
    const result = await readRepresentativeReplies(context(), {});
    expect(ids(result)).toEqual(unread.map((entry) => entry.id));
    expect(result.checkpoint).toEqual({ entry_id: read[1].id, created_at: read[1].created_at });
  });

  it('survives a crash between reading the cursor and persisting the checkpoint', async () => {
    const read = toRep('already read');
    cube.unreadCursorValue = { id: read.id, created_at: read.created_at };
    const unread = [toRep('u1'), toRep('u2')];
    // The guard runs immediately before the bootstrap write: failing it models a crash there.
    const crashed = { ...context(), guard: async () => { throw new Error('killed before persisting'); } };
    expect(await codeOf(readRepresentativeReplies(crashed, {}))).not.toBe('NO_ERROR');
    expect(cube.calls).toContain('unreadCursor');
    expect(deliveryFiles()).toEqual([]);
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual(unread.map((entry) => entry.id));
    // Once persisted, a later change of the old cursor no longer matters.
    cube.unreadCursorValue = null;
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual(unread.map((entry) => entry.id));
  });

  it('reads the production migration input from the seat\'s own client unread cursor, read-only', async () => {
    // local-server-cursor resolves its file at import time: import only after isolating the root.
    vi.resetModules();
    const cursors = await import('../src/local-server-cursor.js');
    const { createSeatBackend } = await import('../src/representative-core.js');
    const binding = bindingFor(WORKTREE);
    const seat = { origin: binding.origin, trustIdentity: binding.trustIdentity, cubeId: binding.cubeId, droneId: REP_ID };
    const point = { id: '12345678-1234-4123-8123-123456789abc', created_at: '2026-03-01T00:00:00.000Z' };
    await cursors.advanceLocalServerCursor(seat, point);
    await cursors.advanceLocalServerCursor({ ...seat, droneId: BUILDER_ID }, { ...point, id: '87654321-4321-4321-8321-cba987654321' });
    chmodSync(join(root, '.config', 'borgmcp'), 0o700); // a prepared install's private root
    const file = join(root, '.config', 'borgmcp', 'local-server-cursors.json');
    const before = readFileSync(file, 'utf8');
    const backend = await createSeatBackend({ cubeId: binding.cubeId, droneId: REP_ID, apiUrl: binding.origin,
      serverTrustIdentity: binding.trustIdentity, sessionToken: 'fixture-only' } as never);
    expect(await backend.unreadCursor()).toEqual(point);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not import the unread cursor into a new generation after any generation has a checkpoint', async () => {
    const old = toRep('old generation read this');
    cube.unreadCursorValue = { id: old.id, created_at: old.created_at };
    const later = toRep('later');
    await readRepresentativeReplies(context(), {}); // the one-time upgrade bootstrap for this seat
    const rebound = context(bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' }));
    expect(ids(await readRepresentativeReplies(rebound, {}))).toEqual([old.id, later.id]);
    expect((await readRepresentativeReplies(rebound, {})).checkpoint).toEqual({ entry_id: null, created_at: null });
  });

  it('replays a changed Coordinator\'s addressed history from before the old unread cursor after a rebind', async () => {
    const otherId = '77777777-7777-4777-8777-777777777777';
    cube.drones.push({ id: otherId, label: 'coordinator-2', role_id: cube.drones.find((d) => d.id === COORD_ID)!.role_id });
    const hidden = cube.post(otherId, 'new Coordinator historical reply', [REP_ID]);
    const old = toRep('old Coordinator read watermark');
    cube.unreadCursorValue = { id: old.id, created_at: old.created_at };
    await readRepresentativeReplies(context(), {}); // the old binding generation upgraded first
    const ctx = context(bindingFor(WORKTREE, {
      coordinatorDroneId: otherId, coordinatorLabel: 'coordinator-2', boundAt: '2026-06-01T00:00:00.000Z',
    }));
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([hidden.id]);
  });

  it('bootstraps from the unread cursor only for its own seat: another seat\'s checkpoint does not count', async () => {
    const read = toRep('read before upgrade');
    cube.unreadCursorValue = { id: read.id, created_at: read.created_at };
    const unread = toRep('unread');
    const otherSeat = context(bindingFor(WORKTREE, { trustIdentity: 'sha256:another-authority' }));
    await readRepresentativeReplies(otherSeat, {});
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual([unread.id]);
  });

  it('repeats an upgrade interrupted after the marker with the recorded cursor, never re-reading the legacy one', async () => {
    const read = toRep('read before upgrade');
    cube.unreadCursorValue = { id: read.id, created_at: read.created_at };
    const unread = toRep('unread at upgrade');
    let writes = 0;
    // The first guarded write (the marker) succeeds; the checkpoint write "crashes".
    const crashed = { ...context(), guard: async () => { if (++writes === 2) throw new Error('killed after the marker'); } };
    expect(await codeOf(readRepresentativeReplies(crashed, {}))).not.toBe('NO_ERROR');
    expect(deliveryFiles().map((file) => file.split('/').at(-1))).toEqual(['migration.json']);
    cube.unreadCursorValue = null; // the legacy cursor changes afterwards
    const calls = cube.calls.filter((call) => call === 'unreadCursor').length;
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual([unread.id]);
    expect(cube.calls.filter((call) => call === 'unreadCursor')).toHaveLength(calls); // not read again
  });

  it('starts from the beginning when the binding never read', async () => {
    const entries = [toRep('first'), toRep('second')];
    expect(ids(await readRepresentativeReplies(context(), {}))).toEqual(entries.map((entry) => entry.id));
  });
});

describe('binding fingerprint', () => {
  const expected = (binding = bindingFor(WORKTREE)) => createHash('sha256').update(JSON.stringify([
    binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId, binding.coordinatorDroneId, binding.boundAt,
  ])).digest('hex');

  it('is the hex SHA-256 of the canonical binding tuple, identical in status, read, send and deliver', async () => {
    const ctx = context();
    const fingerprint = expected();
    expect(bindingFingerprint(ctx.binding)).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const entry = toRep();
    expect((await representativeStatus(ctx)).binding_fingerprint).toBe(fingerprint);
    expect((await readRepresentativeReplies(ctx, {})).binding_fingerprint).toBe(fingerprint);
    expect((await deliverRepresentativeReplies(ctx, { through: entry.id })).binding_fingerprint).toBe(fingerprint);
    const sent = await sendRepresentativeMessage(ctx, { kind: 'question', authorization: 'model_advice', message: 'hi' });
    expect(sent.binding_fingerprint).toBe(fingerprint);
  });

  it('changes on rebind and on trust change, stays stable otherwise, and names no worktree path', () => {
    const base = bindingFor(WORKTREE);
    expect(bindingFingerprint(bindingFor('/elsewhere'))).toBe(bindingFingerprint(base));
    expect(bindingFingerprint({ ...base, boundAt: '2026-06-01T00:00:00.000Z' })).not.toBe(bindingFingerprint(base));
    expect(bindingFingerprint({ ...base, trustIdentity: 'sha256:rotated' })).not.toBe(bindingFingerprint(base));
    for (const segment of WORKTREE.split('/').filter(Boolean)) expect(bindingFingerprint(base)).not.toContain(segment);
  });

  it('keeps delivery state separate per binding generation', async () => {
    const entry = toRep();
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    const rebound = context(bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' }));
    expect(ids(await readRepresentativeReplies(rebound, {}))).toEqual([entry.id]);
  });
});

describe('hostile migration input and checkpoint files', () => {
  const config = () => join(root, '.config', 'borgmcp');
  const seatHash = (binding = bindingFor(WORKTREE)) => createHash('sha256').update(JSON.stringify([
    binding.origin, binding.trustIdentity, binding.cubeId, binding.representativeDroneId,
  ])).digest('hex');
  const cursorKey = (binding = bindingFor(WORKTREE)) => createHash('sha256').update(binding.origin).update('\0')
    .update(binding.trustIdentity).update('\0').update(binding.cubeId).update('\0').update(binding.representativeDroneId).digest('hex');
  function privateTree(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (let current = directory; current.startsWith(join(root, '.config')); current = join(current, '..')) chmodSync(current, 0o700);
  }
  // The production migration reader, over the mock log for everything else.
  async function productionContext() {
    vi.resetModules();
    const core = await import('../src/representative-core.js');
    const binding = bindingFor(WORKTREE);
    const seat = await core.createSeatBackend({ cubeId: binding.cubeId, droneId: REP_ID, apiUrl: binding.origin,
      serverTrustIdentity: binding.trustIdentity, sessionToken: 'fixture-only' } as never);
    return { core, ctx: { ...context(binding), backend: { ...cube.backend(), unreadCursor: seat.unreadCursor } } };
  }
  const cursorFile = (entry: { id: string; created_at: string }) =>
    JSON.stringify({ version: 1, cursors: { [cursorKey()]: { id: entry.id, created_at: entry.created_at } } });

  it.each(['symlink to an outside 0666 file', 'world-writable file', 'group-writable file'])(
    'never imports a legacy unread cursor from a %s: the undelivered reply replays', async (kind) => {
      const entry = toRep('never read or delivered');
      privateTree(config());
      const target = join(config(), 'local-server-cursors.json');
      if (kind.startsWith('symlink')) {
        const outside = join(root, 'outside-cursor.json');
        writeFileSync(outside, cursorFile(entry)); chmodSync(outside, 0o666);
        symlinkSync(outside, target);
      } else {
        writeFileSync(target, cursorFile(entry)); chmodSync(target, kind.startsWith('world') ? 0o666 : 0o620);
      }
      const { core, ctx } = await productionContext();
      const result = await core.readRepresentativeReplies(ctx, {});
      expect(ids(result)).toEqual([entry.id]);
      expect(result.checkpoint).toEqual({ entry_id: null, created_at: null });
    });

  it.each([0o600, 0o644])('still imports a genuine private cursor file of mode %o', async (mode) => {
    const read = toRep('read before upgrade');
    const unread = toRep('unread at upgrade');
    privateTree(config());
    const target = join(config(), 'local-server-cursors.json');
    writeFileSync(target, cursorFile(read)); chmodSync(target, mode);
    const { core, ctx } = await productionContext();
    expect(ids(await core.readRepresentativeReplies(ctx, {}))).toEqual([unread.id]);
  });

  it('never blocks on a planted FIFO in place of the legacy cursor file', () => {
    privateTree(config());
    execFileSync('mkfifo', ['-m', '600', join(config(), 'local-server-cursors.json')]);
    const payload = `
      const { createSeatBackend } = await import(${JSON.stringify(join(process.cwd(), 'src', 'representative-core.ts'))});
      const backend = await createSeatBackend({ apiUrl: 'https://127.0.0.1:65530', serverTrustIdentity: 'sha256:mock-server',
        cubeId: '${bindingFor(WORKTREE).cubeId}', droneId: '${REP_ID}', sessionToken: 'fixture-only' });
      console.log('RESULT', JSON.stringify(await backend.unreadCursor()));`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BORG_')));
    // Bounded: a blocking open would hang the child, which this timeout turns into a failure.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', payload],
      { env: { ...env, HOME: root, BORG_STATE_ROOT: root }, timeout: 15_000, encoding: 'utf8' });
    expect(child.error).toBeUndefined();
    expect(child.stdout).toContain('RESULT null');
    expect(child.status).toBe(0);
  });

  it.each(['another seat', 'a checkpoint beyond its read fence'])(
    'replays from the start after the operator removes an invalid checkpoint of %s', async (kind) => {
      const before = toRep('read before upgrade');
      const after = toRep('unread at upgrade');
      cube.unreadCursorValue = { id: before.id, created_at: before.created_at };
      const ctx = context();
      expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([after.id]); // the one-time upgrade
      const file = deliveryFiles().find((path) => path.endsWith('checkpoint.json'))!;
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (kind === 'another seat') data.seat = 'f'.repeat(64);
      else { data.checkpoint = { id: after.id, created_at: after.created_at }; data.readThrough = null; }
      writeFileSync(file, JSON.stringify(data));
      expect((await representativeStatus(ctx)).checkpoint_problem?.code).toBe('REPRESENTATIVE_CHECKPOINT_INVALID');
      unlinkSync(file);
      expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([before.id, after.id]);
    });

  it('never loses a read-but-undelivered reply when recovery follows a later move of the old unread cursor', async () => {
    const entry = toRep('read, not yet delivered');
    const ctx = context();
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([entry.id]); // bootstrap with no legacy cursor
    // An older version's destructive read later moves the legacy cursor past the entry.
    cube.unreadCursorValue = { id: entry.id, created_at: entry.created_at };
    const file = deliveryFiles().find((path) => path.endsWith('checkpoint.json'))!;
    const data = JSON.parse(readFileSync(file, 'utf8')); data.seat = 'f'.repeat(64);
    writeFileSync(file, JSON.stringify(data));
    unlinkSync(file); // the documented recovery
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([entry.id]);
  });

  const plant = (content: object) => {
    const { directory, file } = deliveryPaths(bindingFor(WORKTREE));
    privateTree(directory);
    writeFileSync(file, JSON.stringify(content), { mode: 0o600 });
    return file;
  };
  const point = (entry: { id: string; created_at: string }) => ({ id: entry.id, created_at: entry.created_at });

  it.each([
    ['another seat', (e: any) => ({ version: 1, seat: 'f'.repeat(64), checkpoint: point(e), readThrough: point(e) })],
    ['a checkpoint beyond its read fence', (e: any) => ({ version: 1, seat: seatHash(), checkpoint: point(e), readThrough: null })],
    ['a missing seat key', (e: any) => ({ version: 1, checkpoint: point(e), readThrough: point(e) })],
  ])('refuses read and deliver on a checkpoint file of %s, and status reports it', async (_label, content) => {
    const entry = toRep('never delivered');
    const file = plant(content(entry));
    const before = readFileSync(file, 'utf8');
    const ctx = context();
    // Start each call only when it is awaited, so no rejection is ever unobserved.
    for (const call of [() => readRepresentativeReplies(ctx, {}), () => deliverRepresentativeReplies(ctx, { through: entry.id })]) {
      const error = await call().then(() => null, (e) => e);
      expect(error?.code).toBe('REPRESENTATIVE_CHECKPOINT_INVALID');
      expect(error.message).toContain(file);
    }
    const status = await representativeStatus(ctx);
    expect(status.checkpoint_problem).toMatchObject({ code: 'REPRESENTATIVE_CHECKPOINT_INVALID' });
    expect(readFileSync(file, 'utf8')).toBe(before); // never silently reset
  });
});
