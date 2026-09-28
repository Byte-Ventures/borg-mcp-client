/**
 * Push engine transitions (design rev 2 §3.4 transition and crash matrices,
 * rev 3 §2 scheduler, acks and discovery, rev 5 §2 startup cohort, rev 4 §2
 * active generation). The engine runs in process over the real state
 * database, the controlled mock cube and a fake clock; every transition is
 * driven explicitly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUILDER_ID, COORD_ID, MockCube, REP_ID, bindingFor } from './fixtures/representative-mock-backend.js';
import { createRepresentativeStore, bindingFingerprint, RepresentativeGenerationError, type RepresentativeBinding } from '../src/representative-store.js';
import { deliverRepresentativeReplies, ensureRepresentativeState, readRepresentativeReplies, type RepresentativeContext } from '../src/representative-core.js';
import {
  DISCOVERY_PAGE, PushEngine, WAKE_ACK_DEADLINE_MS, WAKE_DEBOUNCE_MS, parseAck, readWakeSummary, refusalBackoffMs, rewakeBackoffMs,
  type PushEngineDeps, type WakeEmission,
} from '../src/representative-push.js';
import { withStateDb } from './fixtures/representative-state.js';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;
const WORKTREE = '/work/hermes-representative';
const T0 = Date.parse('2026-05-01T00:00:00.000Z');
let root: string;
let cube: MockCube;
let clock: number;
let binding: RepresentativeBinding;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-representative-push-')));
  process.env.HOME = root;
  process.env.BORG_STATE_ROOT = root;
  cube = new MockCube();
  clock = T0;
  binding = bindingFor(WORKTREE);
  const store = createRepresentativeStore();
  await store.saveBinding(binding, { rebind: false });
  store.state.close();
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT; else process.env.BORG_STATE_ROOT = originalStateRoot;
  rmSync(root, { recursive: true, force: true });
});

const now = () => new Date(clock);
const advance = (ms: number) => { clock += ms; };
/** A Coordinator reply stamped at the fake clock (after the binding start). */
let seq = 0;
const reply = (text = 'reply') => cube.post(COORD_ID, text, [REP_ID], new Date(clock + (seq++)).toISOString());
const context = (): RepresentativeContext => ({ binding, backend: cube.backend(), store: createRepresentativeStore(), now });

interface Harness { engine: PushEngine; wakes: WakeEmission[]; ctx: RepresentativeContext }
async function engineFor(extra: Partial<PushEngineDeps> = {}, capture = true): Promise<Harness> {
  const ctx = context();
  await ensureRepresentativeState(ctx);
  const wakes: WakeEmission[] = [];
  const engine = new PushEngine({ binding, store: ctx.store, backend: ctx.backend, now, emit: async (wake) => { wakes.push(wake); }, ...extra });
  if (capture) await engine.captureCohort();
  return { engine, wakes, ctx };
}
const rowsOf = () => withStateDb((db) => db.prepare('SELECT entry_id, attempts, next_at FROM wake_replies WHERE generation = ? ORDER BY created_at, entry_id')
  .all(bindingFingerprint(binding)) as Array<{ entry_id: string; attempts: number; next_at: string }>);
const docOf = () => withStateDb((db) => JSON.parse((db.prepare('SELECT state FROM wake_state WHERE generation = ?')
  .get(bindingFingerprint(binding)) as { state: string }).state));
const iso = (ms: number) => new Date(ms).toISOString();
const ack = (engine: PushEngine, wake: WakeEmission, accepted: boolean) => engine.ack(JSON.stringify({ wake_id: wake.wake_id, accepted }));

describe('EMIT: one batch, written before it is emitted', () => {
  it('waits for the 2 s debounce, then wakes once for every due reply and schedules the first re-wake', async () => {
    const { engine, wakes } = await engineFor();
    const [a, b] = [reply('a'), reply('b')];
    await engine.discover();
    expect(wakes).toEqual([]); // debounce pending
    advance(WAKE_DEBOUNCE_MS - 1);
    expect(await engine.tick()).toBeNull();
    advance(1);
    const wake = await engine.tick();
    expect(wake).toMatchObject({ reason: 'new-reply', count: 2 });
    expect(wakes).toEqual([wake]);
    expect(rowsOf()).toEqual([a, b].map((entry) => ({ entry_id: entry.id, attempts: 1, next_at: iso(clock + rewakeBackoffMs(1)) })));
    expect(docOf().outstanding).toMatchObject({ batch: wake!.wake_id, replies: [a.id, b.id], deadline: iso(clock + WAKE_ACK_DEADLINE_MS) });
  });

  it('commits the wake before the host sees it', async () => {
    let committed: unknown;
    const { engine, wakes } = await engineFor({ hooks: { afterWakePersisted: () => { committed = docOf().outstanding; } } });
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = await engine.tick();
    expect(committed).toMatchObject({ batch: wake!.wake_id });
    expect(wakes).toHaveLength(1);
  });

  it('keeps exactly one batch outstanding: a reply arriving meanwhile waits for its ack or deadline', async () => {
    const { engine, wakes } = await engineFor();
    reply('first');
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const first = (await engine.tick())!;
    const second = reply('second');
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS * 5);
    expect(await engine.tick()).toBeNull();
    expect(await engine.nextDueAt()).toBe(Date.parse(docOf().outstanding.deadline));
    expect(await ack(engine, first, true)).toBe('accepted');
    const next = await engine.tick();
    expect(next).toMatchObject({ reason: 'new-reply', count: 1 });
    expect(docOf().outstanding.replies).toEqual([second.id]);
    expect(wakes).toHaveLength(2);
  });

  it('re-wakes an undelivered reply at 10 min, 1 h, 6 h, then every 24 h, never going silent', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const reasons: string[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const wake = (await engine.tick())!;
      reasons.push(wake.reason);
      expect(rowsOf()[0]).toMatchObject({ attempts: attempt, next_at: iso(clock + rewakeBackoffMs(attempt)) });
      await ack(engine, wake, true);
      advance(rewakeBackoffMs(attempt) - 1);
      expect(await engine.tick()).toBeNull();
      advance(1);
    }
    expect(reasons).toEqual(['new-reply', 'rewake', 'rewake', 'rewake', 'rewake', 'rewake']);
    expect([1, 2, 3, 4, 5].map(rewakeBackoffMs)).toEqual([600_000, 3_600_000, 21_600_000, 86_400_000, 86_400_000]);
  });
});

describe('acks', () => {
  async function outstanding() {
    const harness = await engineFor();
    const entry = reply();
    await harness.engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await harness.engine.tick())!;
    return { ...harness, entry, wake };
  }

  it('accepted (matching batch): clears the batch and resets refusals; attempts stay', async () => {
    const { engine, wake } = await outstanding();
    expect(await ack(engine, wake, true)).toBe('accepted');
    expect(docOf()).toMatchObject({ outstanding: null, refusals: { count: 0, retry_at: null } });
    expect(rowsOf()[0].attempts).toBe(1);
  });

  it('refused (matching batch): rolls attempts back, backs off 30 s doubling to 30 min, then wakes again', async () => {
    const { engine, wake } = await outstanding();
    let current = wake;
    for (let count = 1; count <= 8; count += 1) {
      expect(await ack(engine, current, false)).toBe('refused');
      const retryAt = clock + refusalBackoffMs(count);
      expect(docOf()).toMatchObject({ outstanding: null, refusals: { count, retry_at: iso(retryAt) } });
      expect(rowsOf()[0]).toMatchObject({ attempts: 0, next_at: iso(retryAt) });
      expect(await engine.nextDueAt()).toBe(retryAt);
      advance(refusalBackoffMs(count) - 1);
      expect(await engine.tick()).toBeNull(); // blocked, no spin
      advance(1);
      current = (await engine.tick())!;
      expect(current).toMatchObject({ reason: 'new-reply', count: 1 });
    }
    expect([1, 2, 3, 7, 8, 20].map(refusalBackoffMs)).toEqual([30_000, 60_000, 120_000, 1_800_000, 1_800_000, 1_800_000]);
    await ack(engine, current, true);
    expect(docOf().refusals).toEqual({ count: 0, retry_at: null });
  });

  it.each([
    ['a late ack for an older batch', (wake: WakeEmission) => JSON.stringify({ wake_id: randomUUID(), accepted: false })],
    ['a malformed line', () => '{"wake_id": nope'],
    ['a non-object', () => '[1,2]'],
    ['an extra key', (wake: WakeEmission) => JSON.stringify({ wake_id: wake.wake_id, accepted: false, count: 1 })],
    ['a non-boolean', (wake: WakeEmission) => JSON.stringify({ wake_id: wake.wake_id, accepted: 'no' })],
    ['a non-uuid id', () => JSON.stringify({ wake_id: 'batch-1', accepted: false })],
    ['an oversized line', (wake: WakeEmission) => JSON.stringify({ wake_id: wake.wake_id, accepted: false }).padEnd(1025, ' ')],
  ])('ignores %s: nothing changes', async (_label, line) => {
    const { engine, wake } = await outstanding();
    const before = { doc: docOf(), rows: rowsOf() };
    expect(await engine.ack(line(wake))).toBe('ignored');
    expect({ doc: docOf(), rows: rowsOf() }).toEqual(before);
  });

  it('ignores a duplicate ack after the batch resolved', async () => {
    const { engine, wake } = await outstanding();
    await ack(engine, wake, true);
    const before = { doc: docOf(), rows: rowsOf() };
    expect(await ack(engine, wake, false)).toBe('ignored');
    expect({ doc: docOf(), rows: rowsOf() }).toEqual(before);
  });

  it('never touches delivery, returned entries, the request ledger or the frontier', async () => {
    const { engine, wake, ctx } = await outstanding();
    await readRepresentativeReplies(ctx, {});
    const snapshot = () => withStateDb((db) => [
      db.prepare('SELECT * FROM delivery').all(), db.prepare('SELECT * FROM returned').all(), db.prepare('SELECT * FROM requests').all(),
    ]);
    const before = { tables: snapshot(), frontier: docOf().frontier };
    await ack(engine, wake, false);
    expect({ tables: snapshot(), frontier: docOf().frontier }).toEqual(before);
  });

  it('parses only {wake_id, accepted} within 1 KiB', () => {
    const id = randomUUID();
    expect(parseAck(JSON.stringify({ wake_id: id, accepted: true }))).toEqual({ wake_id: id, accepted: true });
    expect(parseAck(JSON.stringify({ accepted: true, wake_id: id }))).toEqual({ wake_id: id, accepted: true });
    expect(parseAck('')).toBeNull();
  });
});

describe('timeouts and the crash matrix', () => {
  it('a missing ack times out at the deadline: the batch clears and its attempt stays counted', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    await engine.tick();
    advance(WAKE_ACK_DEADLINE_MS);
    expect(await engine.tick()).toBeNull(); // cleared, and nothing is due before the re-wake
    expect(docOf().outstanding).toBeNull();
    expect(rowsOf()[0].attempts).toBe(1);
    expect(await engine.nextDueAt()).toBe(Date.parse(rowsOf()[0].next_at));
  });

  it('a crash after the wake was persisted and before it was emitted loses one attempt, never adds one', async () => {
    const crashed = await engineFor({ hooks: { afterWakePersisted: () => { throw new Error('killed between persist and emit'); } } });
    reply();
    await crashed.engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    await expect(crashed.engine.tick()).rejects.toThrow(/killed/);
    expect(crashed.wakes).toEqual([]);
    const persisted = docOf().outstanding;
    expect(persisted).not.toBeNull();
    // Restart: the persisted batch stays outstanding until its deadline, then its count stays.
    const restarted = await engineFor();
    await restarted.engine.discover();
    expect(await restarted.engine.tick()).toBeNull();
    advance(WAKE_ACK_DEADLINE_MS);
    expect(await restarted.engine.tick()).toBeNull();
    expect(rowsOf()[0].attempts).toBe(1);
    advance(rewakeBackoffMs(1) - WAKE_ACK_DEADLINE_MS);
    expect(await restarted.engine.tick()).toMatchObject({ count: 1 });
  });

  it('a refused ack whose rollback never committed leaves the batch counted; it times out', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    await engine.tick();
    // The host refused, but the listener died before its transaction: nothing changed.
    advance(WAKE_ACK_DEADLINE_MS);
    await engine.tick();
    expect(docOf()).toMatchObject({ outstanding: null, refusals: { count: 0 } });
    expect(rowsOf()[0].attempts).toBe(1);
  });

  it('repeated restarts never reset counts or storm the host', async () => {
    reply();
    let emitted = 0;
    for (let restart = 0; restart < 5; restart += 1) {
      const { engine, wakes } = await engineFor();
      await engine.discover();
      advance(WAKE_DEBOUNCE_MS);
      await engine.tick();
      emitted += wakes.length;
      advance(1_000);
    }
    expect(emitted).toBe(1);
    expect(rowsOf()[0].attempts).toBe(1);
  });
});

describe('deliver and wakes', () => {
  it('a deliver committed before EMIT suppresses the reply', async () => {
    const { engine, wakes, ctx } = await engineFor();
    const entry = reply();
    await engine.discover();
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    advance(WAKE_DEBOUNCE_MS);
    expect(await engine.tick()).toBeNull();
    expect(wakes).toEqual([]);
    expect(rowsOf()).toEqual([]);
  });

  it('a deliver after reservation cannot stop that wake, the woken read is empty, and a refused ack never recreates the pruned reply', async () => {
    const { engine, ctx } = await engineFor();
    const entry = reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await engine.tick())!;
    await readRepresentativeReplies(ctx, {});
    await deliverRepresentativeReplies(ctx, { through: entry.id });
    expect((await readRepresentativeReplies(ctx, {})).replies).toEqual([]);
    expect(await ack(engine, wake, false)).toBe('refused');
    expect(rowsOf()).toEqual([]);
    await engine.discover();
    expect(rowsOf()).toEqual([]); // at or below the checkpoint: never re-inserted
  });

  it('never wakes for broadcasts, other drones, or replies addressed elsewhere', async () => {
    const { engine, wakes } = await engineFor();
    cube.post(COORD_ID, 'to everyone', 'broadcast');
    cube.post(BUILDER_ID, 'worker note', [REP_ID]);
    cube.post(COORD_ID, 'dispatch', [BUILDER_ID]);
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    expect(await engine.tick()).toBeNull();
    expect(wakes).toEqual([]);
  });
});

describe('discovery', () => {
  it('finds a reply after 10,000 unrelated entries, then resumes from the persisted frontier', async () => {
    const { engine } = await engineFor();
    for (let i = 0; i < 10_000; i += 1) cube.post(BUILDER_ID, `noise ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString());
    const target = reply('after the noise');
    cube.calls.length = 0;
    await engine.discover();
    expect(rowsOf().map((row) => row.entry_id)).toEqual([target.id]);
    expect(cube.calls.filter((call) => call === 'readAfter').length).toBe(Math.ceil(10_001 / DISCOVERY_PAGE));
    expect(docOf().frontier).toEqual({ id: target.id, created_at: target.created_at });
    cube.calls.length = 0;
    const next = reply('next');
    await engine.discover();
    expect(cube.calls.filter((call) => call === 'readAfter')).toHaveLength(1);
    expect(rowsOf().map((row) => row.entry_id)).toEqual([target.id, next.id]);
  });

  it('inserts if absent: rediscovery never resets attempts or next_at', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    await engine.tick();
    const before = rowsOf();
    withStateDb((db) => db.prepare('UPDATE wake_state SET state = json_set(state, \'$.frontier\', NULL) WHERE generation = ?')
      .run(bindingFingerprint(binding))); // force a full rescan
    await engine.discover();
    expect(rowsOf()).toEqual(before);
  });

  it('runs one scan at a time; a trigger during a scan runs exactly one more', async () => {
    const { engine, ctx } = await engineFor();
    reply();
    let inFlight = 0, peak = 0, calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const readAfter = ctx.backend.readAfter;
    (engine as unknown as { deps: PushEngineDeps }).deps.backend = {
      ...ctx.backend,
      readAfter: async (...args) => { inFlight += 1; calls += 1; peak = Math.max(peak, inFlight); if (calls === 1) await gate; try { return await readAfter(...args); } finally { inFlight -= 1; } },
    };
    const first = engine.discover();
    const second = engine.discover();
    const third = engine.discover();
    release();
    await Promise.all([first, second, third]);
    expect(peak).toBe(1);
    expect(calls).toBe(2); // the scan, plus one rescan for the triggers during it
  });

  it('fires a due wake between pages of a long scan (fairness), and the scan still completes', async () => {
    const { engine, wakes } = await engineFor({
      hooks: { betweenPages: (page) => { if (page === 1) advance(WAKE_DEBOUNCE_MS); } },
    });
    const early = reply('early');
    for (let i = 0; i < DISCOVERY_PAGE * 3; i += 1) cube.post(BUILDER_ID, `noise ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString());
    const late = reply('late');
    // A frontier just before the early reply puts it on the first page.
    await engine.discover();
    expect(wakes.map((wake) => wake.count)).toEqual([1]);
    expect(docOf().outstanding.replies).toEqual([early.id]);
    expect(rowsOf().map((row) => row.entry_id)).toEqual([early.id, late.id]);
  });

  it('terminates on a log that keeps growing during the scan', async () => {
    let added = 0;
    const { engine } = await engineFor({
      hooks: { betweenPages: () => { if (added < 5) { added += 1; for (let i = 0; i < DISCOVERY_PAGE; i += 1) cube.post(BUILDER_ID, `grow ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString()); } } },
    });
    // More than one page, so every page read reports more to come while the log grows.
    for (let i = 0; i < DISCOVERY_PAGE * 2 + 1; i += 1) cube.post(BUILDER_ID, `seed ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString());
    const growing = reply('arrives while the log grows'); // before the growth, so it is found on the way
    await engine.discover();
    expect(added).toBe(5);
    expect(docOf().frontier.id).toBe(cube.entries.at(-1)!.id);
    expect(rowsOf().map((row) => row.entry_id)).toEqual([growing.id]);
  });
});

describe('the eligible-deadline scheduler', () => {
  it('reports only eligible instants: outstanding deadline, refusal retry, EMIT time; nothing while the cohort is open', async () => {
    const { engine } = await engineFor();
    expect(await engine.nextDueAt()).toBeNull();
    reply();
    await engine.discover();
    expect(await engine.nextDueAt()).toBe(clock + WAKE_DEBOUNCE_MS); // debounce later than next_at
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await engine.tick())!;
    expect(await engine.nextDueAt()).toBe(clock + WAKE_ACK_DEADLINE_MS);
    await ack(engine, wake, false);
    expect(await engine.nextDueAt()).toBe(clock + refusalBackoffMs(1));
  });

  it('clamps an instant more than 24 h ahead (a clock set back) and treats past instants as due', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await engine.tick())!;
    await ack(engine, wake, true);
    // The clock jumps back two days: next_at now lies 2 days + 10 min ahead.
    advance(-2 * 24 * 60 * 60_000);
    expect(await engine.nextDueAt()).toBe(clock + 24 * 60 * 60_000);
    expect(await engine.tick()).toBeNull();
    expect(rowsOf()[0].next_at).toBe(iso(clock + 24 * 60 * 60_000));
    // The clock jumps forward past it: due at once.
    advance(30 * 24 * 60 * 60_000);
    expect(await engine.tick()).toMatchObject({ reason: 'rewake' });
  });
});

describe('the startup cohort', () => {
  it('wakes once for 60 undelivered replies, then drains', async () => {
    const entries = Array.from({ length: 60 }, (_, i) => reply(`r${i}`));
    const { engine, wakes, ctx } = await engineFor();
    expect(docOf().cohort).toEqual({ open: true, remaining: entries.length });
    expect(await engine.nextDueAt()).toBeNull(); // no EMIT while the cohort is open
    await engine.discover();
    expect(wakes).toEqual([expect.objectContaining({ reason: 'startup', count: 60 })]);
    for (;;) {
      const page = await readRepresentativeReplies(ctx, { limit: 50 });
      if (page.replies.length === 0) break;
      await deliverRepresentativeReplies(ctx, { through: page.replies.at(-1)!.entry_id });
    }
    await engine.discover();
    expect(rowsOf()).toEqual([]);
  });

  it('closes the cohort once the captured count is scanned even as the log grows; later replies wake under normal fairness', async () => {
    const early = Array.from({ length: 3 }, (_, i) => reply(`early ${i}`));
    let grown = false;
    const { engine, wakes } = await engineFor({
      hooks: { betweenPages: () => { if (!grown) { grown = true; reply('after the head'); } } },
    });
    await engine.discover();
    expect(wakes[0]).toMatchObject({ reason: 'startup' });
    expect(wakes[0].count).toBeGreaterThanOrEqual(early.length);
    expect(docOf().cohort.open).toBe(false);
    await ack(engine, wakes[0], true);
    const later = reply('later');
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    // The reply posted during the scan was beyond the captured head: it wakes
    // under normal fairness with the later one, not in the startup batch.
    expect(await engine.tick()).toMatchObject({ reason: 'new-reply', count: 2 });
    expect(docOf().outstanding.replies).toEqual([cube.entries.find((entry) => entry.message === 'after the head')!.id, later.id]);
  });

  it('reuses the stored count when restarted mid-cohort, and still emits one cohort batch', async () => {
    Array.from({ length: DISCOVERY_PAGE + 10 }, (_, i) => reply(`r${i}`));
    const first = await engineFor({ hooks: { betweenPages: (page) => { if (page === 1) throw new Error('killed mid-cohort'); } } });
    expect(docOf().cohort).toEqual({ remaining: DISCOVERY_PAGE + 10, open: true });
    await expect(first.engine.discover()).rejects.toThrow(/killed/);
    expect(docOf().cohort).toEqual({ remaining: 10, open: true }); // the first page was merged
    reply('after the first capture'); // a newer head must not move the target
    const second = await engineFor();
    expect(docOf().cohort).toEqual({ remaining: 10, open: true });
    await second.engine.discover();
    expect(first.wakes).toEqual([]);
    expect(second.wakes).toHaveLength(1);
    expect(second.wakes[0]).toMatchObject({ reason: 'startup' });
  });

  it('has no cohort gate on an empty log', async () => {
    const { engine } = await engineFor();
    expect(docOf().cohort).toEqual({ remaining: 0, open: false });
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    expect(await engine.tick()).toMatchObject({ reason: 'new-reply' });
  });
});

describe('the active generation', () => {
  it('drops a discovery page merged after a rebind, stops with the generation error, and leaves the new generation untouched', async () => {
    Array.from({ length: DISCOVERY_PAGE + 5 }, (_, i) => cube.post(BUILDER_ID, `noise ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString()));
    reply();
    const rebound = bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' });
    const { engine } = await engineFor({
      hooks: { betweenPages: async (page) => { if (page === 1) await createRepresentativeStore().saveBinding(rebound, { rebind: true }); } },
    });
    const frontierBefore = docOf().frontier;
    await expect(engine.discover()).rejects.toBeInstanceOf(RepresentativeGenerationError);
    expect(docOf().frontier).not.toEqual(null); // the first page merged before the rebind
    expect(frontierBefore).toBeNull();
    const newGeneration = bindingFingerprint(rebound);
    expect(withStateDb((db) => [db.prepare('SELECT * FROM wake_state WHERE generation = ?').all(newGeneration),
      db.prepare('SELECT * FROM wake_replies WHERE generation = ?').all(newGeneration)])).toEqual([[], []]);
  });

  it.each(['tick', 'ack', 'start'])('refuses %s after a rebind', async (step) => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = await engine.tick();
    await createRepresentativeStore().saveBinding(bindingFor(WORKTREE, { boundAt: '2026-06-01T00:00:00.000Z' }), { rebind: true });
    const run = step === 'tick' ? engine.tick() : step === 'ack' ? ack(engine, wake!, true) : engine.captureCohort();
    await expect(run).rejects.toBeInstanceOf(RepresentativeGenerationError);
  });
});

describe('status summary', () => {
  it('reports undelivered, outstanding, refusals and the cohort read-only', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await engine.tick())!;
    const store = createRepresentativeStore();
    expect(await readWakeSummary(store, binding)).toMatchObject({
      undelivered: 1, outstanding: { wake_id: wake.wake_id, count: 1 }, refusals: { count: 0 }, cohort_open: false,
    });
  });
});

describe('review controls (S2 round 1)', () => {
  it('ignores a matching refusal received after the deadline before the timer runs: the attempt stays counted', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const wake = (await engine.tick())!;
    advance(WAKE_ACK_DEADLINE_MS + 1);
    expect(await ack(engine, wake, false)).toBe('ignored');
    expect(rowsOf()[0].attempts).toBe(1);
    expect(docOf()).toMatchObject({ outstanding: null, refusals: { count: 0, retry_at: null } });
    expect(await engine.nextDueAt()).toBe(Date.parse(rowsOf()[0].next_at)); // the 10-minute re-wake, not a 30 s retry
  });

  it('ignores a matching acceptance after the deadline: refusal backoff is not reset', async () => {
    const { engine } = await engineFor();
    reply();
    await engine.discover();
    advance(WAKE_DEBOUNCE_MS);
    const first = (await engine.tick())!;
    await ack(engine, first, false); // refusal 1: retry in 30 s
    advance(refusalBackoffMs(1));
    const second = (await engine.tick())!;
    advance(WAKE_ACK_DEADLINE_MS);
    expect(await ack(engine, second, true)).toBe('ignored');
    expect(docOf().refusals.count).toBe(1);
  });

  it('stops everything on stop(): no later page request, merge or wake, and a page in flight is abandoned', async () => {
    const { engine, ctx, wakes } = await engineFor();
    for (let i = 0; i < DISCOVERY_PAGE * 3; i += 1) cube.post(BUILDER_ID, `noise ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString());
    reply();
    let calls = 0;
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => { release = resolve; });
    const readAfter = ctx.backend.readAfter;
    (engine as unknown as { deps: PushEngineDeps }).deps.backend = {
      ...ctx.backend,
      readAfter: async (...args) => { calls += 1; if (calls === 2) await stuck; return readAfter(...args); },
    };
    const scan = engine.discover();
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    const frontier = docOf().frontier;
    engine.stop();
    await expect(scan).rejects.toThrow(/stopped/);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
    expect(docOf().frontier).toEqual(frontier); // the abandoned page is never merged
    advance(WAKE_DEBOUNCE_MS * 10);
    expect(await engine.tick()).toBeNull();
    expect(await engine.ack(JSON.stringify({ wake_id: randomUUID(), accepted: true }))).toBe('ignored');
    await expect(engine.discover()).rejects.toThrow(/stopped/);
    expect(wakes).toEqual([]);
  });

  it('captures the startup cohort with one bounded request, however long or fast-growing the log', async () => {
    for (let i = 0; i < 5_000; i += 1) cube.post(BUILDER_ID, `noise ${i}`, [REP_ID], new Date(clock + (seq++)).toISOString());
    const { engine, ctx } = await engineFor({}, false);
    const pages: number[] = [];
    const readAfter = ctx.backend.readAfter;
    (engine as unknown as { deps: PushEngineDeps }).deps.backend = {
      ...ctx.backend,
      readAfter: async (cursor, limit) => { pages.push(limit); return readAfter(cursor, limit); },
    };
    await engine.captureCohort();
    expect(pages).toEqual([1]);
    expect(docOf().cohort).toEqual({ remaining: 5_000, open: true });
  });
});
