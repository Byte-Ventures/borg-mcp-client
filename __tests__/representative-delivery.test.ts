/**
 * Delivery semantics: replayable bounded read, explicit deliver checkpoint,
 * the 6.0 start rule over 5.x inputs, binding fingerprint.
 * Backend evidence is the controlled in-memory mock, not a real Borg server.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { bindingFingerprint, createRepresentativeStore, type RepresentativeBinding } from '../src/representative-store.js';
import { representativeStateRoot } from '../src/representative-db.js';
import {
  configRoot, deliveryRow, plantLegacyBindings, legacyDeliveryRoot, plantLegacyCheckpoint, plantLegacyTombstone, privateTree, returnedRows,
  seatHash, withStateDb,
} from './fixtures/representative-state.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const WORKTREE = '/work/hermes-representative';
let root: string;
let cube: MockCube;

function context(binding = bindingFor(WORKTREE)): RepresentativeContext {
  return { binding, backend: cube.backend(), store: createRepresentativeStore() };
}
/** `borg representative prepare` for this binding: a 6.x-prepared binding row. */
async function prepare(binding = bindingFor(WORKTREE), rebind = false): Promise<RepresentativeContext> {
  const store = createRepresentativeStore();
  await store.saveBinding(binding, { rebind });
  store.state.close();
  return context(binding);
}
const toRep = (message = 'reply') => cube.post(COORD_ID, message, [REP_ID]);
const ids = (result: { replies: Array<{ entry_id: string }> }) => result.replies.map((reply) => reply.entry_id);
const statMode = (path: string) => lstatSync(path).mode & 0o777;
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try { await promise; return 'NO_ERROR'; } catch (error) { return (error as { code?: string }).code ?? 'UNTYPED'; }
}
const point = (entry: { id: string; created_at: string }) => ({ id: entry.id, created_at: entry.created_at });

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-delivery-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  cube = new MockCube();
  await prepare();
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

  it('refuses an addressed id that no read returned, advances a returned one, and keeps an older id a no-op after restart', async () => {
    const [a, b, c] = [toRep('a'), toRep('b'), toRep('c')];
    await readRepresentativeReplies(context(), { limit: 2 }); // returns a, b
    expect(await codeOf(deliverRepresentativeReplies(context(), { through: c.id }))).toBe('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY');
    expect(await deliverRepresentativeReplies(context(), { through: b.id })).toMatchObject({ advanced: true });
    // Restart: fresh context and store objects over the persisted state.
    expect(await deliverRepresentativeReplies(context(), { through: a.id }))
      .toMatchObject({ advanced: false, checkpoint: { entry_id: b.id } });
  });

  it('refuses a broadcast id a read skipped (include_broadcast false) although it lies inside the returned range', async () => {
    const a = toRep('a');
    const broadcast = cube.post(COORD_ID, 'to everyone', 'broadcast');
    const b = toRep('b');
    const ctx = context();
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([a.id, b.id]);
    expect(await codeOf(deliverRepresentativeReplies(ctx, { through: broadcast.id }))).toBe('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY');
    expect((await readRepresentativeReplies(ctx, {})).checkpoint).toEqual({ entry_id: null, created_at: null });
    expect(await deliverRepresentativeReplies(ctx, { through: b.id })).toMatchObject({ advanced: true });
  });

  it('refuses a planted returned record whose timestamp differs from the entry, keeping checkpoint <= readThrough', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    const ctx = context();
    await readRepresentativeReplies(ctx, {}); // returned a, b; readThrough b
    const e = toRep('never returned');
    // e's id inside the window, with a forged earlier time
    withStateDb((db) => db.prepare('INSERT INTO returned (generation, entry_id, created_at) VALUES (?, ?, ?)')
      .run(bindingFingerprint(ctx.binding), e.id, a.created_at));
    expect(await codeOf(deliverRepresentativeReplies(ctx, { through: e.id }))).toBe('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY');
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: null, read_through_id: b.id, read_through_at: b.created_at });
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

  it('never advances the server ack, the checkpoint or any server state on read', async () => {
    toRep('a');
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await readRepresentativeReplies(ctx, {});
    expect(cube.acks).toEqual([]);
    expect(cube.calls.filter((call) => !['whoami', 'roster', 'readAfter'].includes(call))).toEqual([]);
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: null });
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

  it('stores delivery state privately in the state database, without message text', async () => {
    const entry = toRep('PRIVATE_MESSAGE_SENTINEL');
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: entry.id, start_kind: 'binding' });
    const stateRoot = representativeStateRoot();
    const generations = readdirSync(stateRoot).filter((name) => name.startsWith('g'));
    expect(generations).toHaveLength(1);
    for (const directory of [stateRoot, join(stateRoot, generations[0])]) expect(statMode(directory)).toBe(0o700);
    const files = [join(stateRoot, 'CURRENT'), join(stateRoot, 'publish.sqlite'),
      ...readdirSync(join(stateRoot, generations[0])).map((name) => join(stateRoot, generations[0], name))];
    for (const file of files) {
      expect(statMode(file)).toBe(0o600);
      expect(readFileSync(file).includes('PRIVATE_MESSAGE_SENTINEL')).toBe(false);
    }
    // No 5.x delivery files are ever written.
    expect(() => readdirSync(legacyDeliveryRoot(root))).toThrow();
  });

  it('refuses deliver for a generation the operator rebound, changing nothing', async () => {
    const entry = toRep('a');
    const ctx = context();
    await readRepresentativeReplies(ctx, {});
    const rebound = bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' });
    await prepare(rebound, true);
    expect(await codeOf(deliverRepresentativeReplies(ctx, { through: entry.id }))).toBe('BINDING_MISMATCH');
    expect(await codeOf(readRepresentativeReplies(ctx, {}))).toBe('BINDING_MISMATCH');
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: null });
    expect(deliveryRow(rebound)).toBeUndefined();
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

  const withCitations = (count: number, message = 'z'.repeat(4000)) => {
    const entry = toRep(message) as ReturnType<typeof toRep> & { documents?: unknown[] };
    entry.documents = Array.from({ length: count }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`, title: `Document ${i} `.padEnd(80, 't'), state: 'active',
    }));
    return entry;
  };

  it('bounds an oversize entry with many citations by max(max_bytes, 16384), reducing citations to ids', async () => {
    const entry = withCitations(100);
    const result = await readRepresentativeReplies(context(), { max_bytes: 4096 });
    expect(ids(result)).toEqual([entry.id]);
    expect(result.replies[0]).toMatchObject({ oversize: true, documents_reduced: true, message: entry.message });
    expect(result.replies[0].documents).toHaveLength(100);
    for (const citation of result.replies[0].documents!) expect(Object.keys(citation)).toEqual(['id']);
    expect(Buffer.byteLength(serializeRepresentativeResult(result))).toBeLessThanOrEqual(16384);
  });

  it('keeps full citations when they fit max_bytes', async () => {
    const entry = withCitations(100);
    const result = await readRepresentativeReplies(context(), { max_bytes: 60000 });
    expect(ids(result)).toEqual([entry.id]);
    expect(result.replies[0].documents).toEqual(entry.documents);
    expect(result.replies[0].documents_reduced).toBeUndefined();
    expect(Buffer.byteLength(serializeRepresentativeResult(result))).toBeLessThanOrEqual(60000);
  });

  it('refuses an entry that cannot fit even reduced, without advancing anything, and returns it at max_bytes 60000', async () => {
    const huge = toRep('h'.repeat(20000)); // a server configured above the default post limit
    const ctx = context();
    const error = await readRepresentativeReplies(ctx, { max_bytes: 4096 }).then(() => null, (e) => e);
    expect(error?.code).toBe('REPRESENTATIVE_READ_OVERSIZE');
    expect(error.details).toMatchObject({ entry_id: huge.id, bound: 16384 });
    expect(error.details.measured_bytes).toBeGreaterThan(16384);
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: null, read_through_id: null }); // nothing advanced
    expect(returnedRows(ctx.binding)).toEqual([]);
    expect(await codeOf(deliverRepresentativeReplies(ctx, { through: huge.id }))).toBe('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY');
    const result = await readRepresentativeReplies(ctx, { max_bytes: 60000 });
    expect(ids(result)).toEqual([huge.id]);
    expect(Buffer.byteLength(serializeRepresentativeResult(result))).toBeLessThanOrEqual(60000);
  });

  it('widens no read fence before an oversize refusal on the first call', async () => {
    const huge = toRep('h'.repeat(20000)); // the first reply after the binding start
    const ctx = context();
    const error = await readRepresentativeReplies(ctx, { max_bytes: 4096 }).then(() => null, (e) => e);
    expect(error?.code).toBe('REPRESENTATIVE_READ_OVERSIZE');
    expect(error.details.entry_id).toBe(huge.id);
    expect(deliveryRow(ctx.binding)).toMatchObject({ start_kind: 'binding', checkpoint_id: null, read_through_id: null });
    expect(returnedRows(ctx.binding)).toEqual([]);
  });

  it('reports the envelope floor in status', async () => {
    expect((await representativeStatus(context())).envelope_floor).toBe(16384);
  });

  it('scans past 200 ignored entries to the next addressed one, never an empty page with has_more', async () => {
    Array.from({ length: 200 }, (_, i) => cube.post(BUILDER_ID, `worker ${i}`, [REP_ID]));
    const addressed = toRep('after the noise');
    const result = await readRepresentativeReplies(context(), {});
    expect(ids(result)).toEqual([addressed.id]);
    expect(result.has_more).toBe(false);
    expect(result.ignored_entries).toBe(200);
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
    // A rebind starts a new generation at its binding start: replies before it
    // belong to the old generation, whose checkpoint is kept apart.
    const rebound = await prepare(bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' }), true);
    const later = cube.post(COORD_ID, 'after the rebind', [REP_ID], '2026-07-01T00:00:00.000Z');
    expect(ids(await readRepresentativeReplies(rebound, {}))).toEqual([later.id]);
    expect(deliveryRow(ctx.binding)).toMatchObject({ checkpoint_id: entry.id });
    expect(deliveryRow(rebound.binding)).toMatchObject({ start_kind: 'binding', checkpoint_id: null });
  });
});

describe('the 6.0 start rule for a binding 5.x prepared', () => {
  // No 6.x state at all: the worktree's binding comes from 5.x. The state's
  // creation imports it with its start decided from the 5.x delivery files
  // (a head start is resolved at first use, against this database).
  let legacy: RepresentativeBinding;
  beforeEach(() => {
    // No 6.x state yet: the 5.x binding file is imported when the state is created.
    rmSync(representativeStateRoot(), { recursive: true, force: true });
    legacy = bindingFor(WORKTREE);
    plantLegacyBindings(root, [legacy]);
  });
  const valid = (checkpoint: { id: string; created_at: string } | null, readThrough = checkpoint) =>
    ({ version: 1, seat: seatHash(legacy), checkpoint, readThrough, returned: [] });

  it('starts at the server head when 5.x left no delivery history and the database has none for the seat', async () => {
    toRep('before the upgrade 1'); toRep('before the upgrade 2');
    const ctx = context(legacy);
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([]);
    const after = toRep('after the upgrade');
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([after.id]);
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'head' });
    expect(withStateDb((db) => db.prepare('SELECT origin FROM bindings WHERE worktree = ?').get(WORKTREE))).toEqual({ origin: 'legacy' });
  });

  it('starts at the binding start when the head cannot be reached in a bounded read (a very long log)', async () => {
    const { SERVER_HEAD_MAX_PAGES } = await import('../src/representative-core.js');
    const early = toRep('before the upgrade');
    for (let i = 0; i < SERVER_HEAD_MAX_PAGES * 500; i += 1) cube.post(BUILDER_ID, `noise ${i}`, [REP_ID]);
    const ctx = context(legacy);
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([early.id]); // replayed, never skipped
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('starts at the binding start on an empty log', async () => {
    const ctx = context(legacy);
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([]);
    const first = toRep('first ever');
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([first.id]);
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('imports a valid non-null 5.x checkpoint and replays exactly the replies after it', async () => {
    const delivered = [toRep('d1'), toRep('d2')];
    const undelivered = [toRep('u1'), toRep('u2')];
    plantLegacyCheckpoint(root, legacy, valid(point(delivered[1]), point(undelivered[0])));
    const result = await readRepresentativeReplies(context(legacy), {});
    expect(ids(result)).toEqual(undelivered.map((entry) => entry.id));
    expect(result.checkpoint).toEqual({ entry_id: delivered[1].id, created_at: delivered[1].created_at });
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'checkpoint', checkpoint_id: delivered[1].id });
  });

  it('starts at the binding start for a valid null 5.x checkpoint', async () => {
    const entries = [toRep('a'), toRep('b')];
    plantLegacyCheckpoint(root, legacy, valid(null));
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('starts at the binding start when the 5.x seat tombstone exists', async () => {
    const entries = [toRep('a'), toRep('b')];
    plantLegacyTombstone(root, legacy);
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('starts at the binding start when a sibling 5.x generation names this seat', async () => {
    const entries = [toRep('a'), toRep('b')];
    const sibling = bindingFor(WORKTREE, { boundAt: '2025-12-01T00:00:00.000Z' });
    plantLegacyCheckpoint(root, legacy, valid(null), bindingFingerprint(sibling));
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
  });

  it('still starts at the head when the only sibling 5.x generation belongs to another seat', async () => {
    toRep('old');
    const other = bindingFor(WORKTREE, { trustIdentity: 'sha256:another-authority' });
    plantLegacyCheckpoint(root, other, { ...valid(null), seat: seatHash(other) }, bindingFingerprint(other));
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual([]);
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'head' });
  });

  it.each([
    ['an unreadable sibling checkpoint', () => plantLegacyCheckpoint(root, legacy, '{not json', 'f'.repeat(64))],
    ['a delivery root that is not private', () => { privateTree(root, legacyDeliveryRoot(root)); chmodSync(legacyDeliveryRoot(root), 0o755); }],
    ['a delivery root that is a file', () => { privateTree(root, configRoot(root)); writeFileSync(legacyDeliveryRoot(root), 'x', { mode: 0o600 }); }],
  ])('treats history it cannot enumerate (%s) as present: the binding start, never the head', async (_label, plant) => {
    const entries = [toRep('a'), toRep('b')];
    plant();
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('starts at the binding start when the database already holds history for the seat', async () => {
    const entries = [toRep('a'), toRep('b')];
    const other = await prepare(bindingFor('/work/other-worktree', { boundAt: '2025-12-01T00:00:00.000Z' }));
    await readRepresentativeReplies(other, {}); // the seat's history now exists in this database
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('falls back from the head to the binding start when seat history appears while the head is read', async () => {
    const entries = [toRep('a'), toRep('b')];
    const ctx = context(legacy);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = ctx.backend.readAfter;
    let held = false;
    ctx.backend = { ...ctx.backend, readAfter: async (...args) => {
      if (!held) { held = true; entered(); await gate; } // the head scan, outside any transaction
      return inner(...args);
    } };
    const pending = readRepresentativeReplies(ctx, {});
    await reached;
    const other = await prepare(bindingFor('/work/other-worktree', { boundAt: '2025-12-01T00:00:00.000Z' }));
    await readRepresentativeReplies(other, {});
    release();
    expect(ids(await pending)).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding' });
  });

  it('decides the start once: 5.x files that appear later change nothing', async () => {
    toRep('old');
    const ctx = context(legacy);
    await readRepresentativeReplies(ctx, {});
    plantLegacyTombstone(root, legacy);
    const after = toRep('new');
    expect(ids(await readRepresentativeReplies(ctx, {}))).toEqual([after.id]);
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'head' });
  });

  it('creates one delivery row when two first uses overlap', async () => {
    const entry = toRep('a');
    plantLegacyCheckpoint(root, legacy, valid(null));
    const [first, second] = await Promise.all([readRepresentativeReplies(context(legacy), {}), readRepresentativeReplies(context(legacy), {})]);
    expect(ids(first)).toEqual([entry.id]);
    expect(ids(second)).toEqual([entry.id]);
    expect(withStateDb((db) => db.prepare('SELECT COUNT(*) AS n FROM delivery').get())).toEqual({ n: 1 });
  });

  it('never writes a 5.x file', async () => {
    const file = plantLegacyCheckpoint(root, legacy, valid(null));
    const before = readFileSync(file, 'utf8');
    const entry = toRep('a');
    const ctx = context(legacy);
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(legacyDeliveryRoot(root))).toEqual([bindingFingerprint(legacy)]);
  });
});

describe('hostile 5.x checkpoint input (C4)', () => {
  let legacy: RepresentativeBinding;
  beforeEach(() => {
    // No 6.x state yet: the 5.x binding file is imported when the state is created.
    rmSync(representativeStateRoot(), { recursive: true, force: true });
    legacy = bindingFor(WORKTREE);
    plantLegacyBindings(root, [legacy]);
  });
  // A forged checkpoint past every reply would skip them all if it were imported.
  const forged = (entry: { id: string; created_at: string }) =>
    ({ version: 1, seat: seatHash(legacy), checkpoint: point(entry), readThrough: point(entry), returned: [] });

  it.each([
    ['a symlink to an outside 0600 file', (entry: any) => {
      const outside = join(root, 'outside-checkpoint.json');
      writeFileSync(outside, JSON.stringify(forged(entry)), { mode: 0o600 });
      const file = plantLegacyCheckpoint(root, legacy, '{}');
      rmSync(file); symlinkSync(outside, file);
    }],
    ['a world-writable file', (entry: any) => chmodSync(plantLegacyCheckpoint(root, legacy, forged(entry)), 0o666)],
    ['a group-writable file', (entry: any) => chmodSync(plantLegacyCheckpoint(root, legacy, forged(entry)), 0o620)],
    ['another seat', (entry: any) => plantLegacyCheckpoint(root, legacy, { ...forged(entry), seat: 'f'.repeat(64) })],
    ['a checkpoint beyond its read fence', (entry: any) => plantLegacyCheckpoint(root, legacy, { ...forged(entry), readThrough: null })],
    ['a missing seat key', (entry: any) => { const { seat: _seat, ...rest } = forged(entry); plantLegacyCheckpoint(root, legacy, rest); }],
    ['malformed JSON', () => plantLegacyCheckpoint(root, legacy, '{"version":1,')],
    ['an oversized file', (entry: any) => plantLegacyCheckpoint(root, legacy, JSON.stringify(forged(entry)).padEnd(1024 * 1024 + 1, ' '))],
  ])('never imports a checkpoint from %s: every reply replays from the binding start', async (_label, plant) => {
    const entries = [toRep('a'), toRep('b'), toRep('c')];
    plant(entries[2]);
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual(entries.map((entry) => entry.id));
    expect(deliveryRow(legacy)).toMatchObject({ start_kind: 'binding', checkpoint_id: null });
  });

  it('imports a genuine 0600 checkpoint file', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    plantLegacyCheckpoint(root, legacy, forged(a));
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual([b.id]);
  });

  it('never imports a 0644 checkpoint file (5.x wrote 0600): every reply replays', async () => {
    const [a, b] = [toRep('a'), toRep('b')];
    chmodSync(plantLegacyCheckpoint(root, legacy, forged(a)), 0o644);
    expect(ids(await readRepresentativeReplies(context(legacy), {}))).toEqual([a.id, b.id]);
  });
});
