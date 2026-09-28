/**
 * The representative's DELIVERED checkpoint and read window, per binding
 * generation, in the representative state database.
 *
 * - `start`: where this generation's history begins (the imported 5.x
 *   checkpoint, the server head, or the binding start). Scans never consider
 *   entries at or before it.
 * - `checkpoint`: the host's durable delivery point; only `deliver` moves it.
 * - `readThrough`: the highest entry any `read` returned; `deliver` may not pass it.
 * - `returned`: entries a read returned since the checkpoint last moved;
 *   `deliver` checks membership of the full (id, created_at) tuple here.
 *
 * Every function taking a `Transaction` runs inside one representative state
 * transaction; callers check the binding generation in that same transaction.
 */
import type { Transaction } from './representative-db.js';
import type { LocalServerCursor } from './local-server-cursor.js';
import {
  bindingFingerprint, currentBindingRow, insertBindingRow, RepresentativeGenerationError,
  type RepresentativeBinding, type RepresentativeStore,
} from './representative-store.js';
import { readLegacyDelivery, seatKey } from './representative-legacy.js';

export type StartKind = 'checkpoint' | 'head' | 'binding';

export interface DeliveryState {
  start: LocalServerCursor;
  startKind: StartKind;
  checkpoint: LocalServerCursor | null;
  readThrough: LocalServerCursor | null;
  returned: LocalServerCursor[];
}

/** Two windows of at most 50 replies (with and without broadcasts). */
const RETURNED_CAP = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** (created_at, id) order, the server log order. */
export function comparePoints(a: LocalServerCursor, b: LocalServerCursor | null): number {
  if (b === null) return 1;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

const later = (a: LocalServerCursor | null, b: LocalServerCursor | null) =>
  a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;

const point = (id: string | null, at: string | null): LocalServerCursor | null =>
  id === null || at === null ? null : { id, created_at: at };

export function loadDelivery(db: Transaction, generation: string): DeliveryState | null {
  const row = db.prepare(`SELECT start_id, start_at, start_kind, checkpoint_id, checkpoint_at, read_through_id, read_through_at
    FROM delivery WHERE generation = ?`).get(generation) as Record<string, string | null> | undefined;
  if (!row) return null;
  const returned = (db.prepare('SELECT entry_id, created_at FROM returned WHERE generation = ?').all(generation) as
    Array<{ entry_id: string; created_at: string }>)
    .map((entry) => ({ id: entry.entry_id, created_at: entry.created_at }))
    .sort((a, b) => comparePoints(a, b));
  return {
    start: { id: row.start_id!, created_at: row.start_at! },
    startKind: row.start_kind as StartKind,
    checkpoint: point(row.checkpoint_id, row.checkpoint_at),
    readThrough: point(row.read_through_id, row.read_through_at),
    returned,
  };
}

/**
 * Where a scan starts: the server cursor (null = the log start) and the floor
 * every entry must exceed. A binding start is a synthetic lower bound that is
 * never sent to the server as a cursor.
 */
export function scanStart(state: DeliveryState): { cursor: LocalServerCursor | null; floor: LocalServerCursor } {
  const floor = later(state.start, state.checkpoint)!;
  if (state.checkpoint) return { cursor: state.checkpoint, floor };
  return { cursor: state.startKind === 'binding' ? null : state.start, floor };
}

function write(db: Transaction, generation: string, next: DeliveryState): void {
  if (next.checkpoint && (next.readThrough === null || comparePoints(next.checkpoint, next.readThrough) > 0)) {
    throw new Error('A representative state write would move the checkpoint beyond the read fence');
  }
  db.prepare(`UPDATE delivery SET checkpoint_id = ?, checkpoint_at = ?, read_through_id = ?, read_through_at = ?
    WHERE generation = ?`).run(
    next.checkpoint?.id ?? null, next.checkpoint?.created_at ?? null,
    next.readThrough?.id ?? null, next.readThrough?.created_at ?? null, generation);
  db.prepare('DELETE FROM returned WHERE generation = ?').run(generation);
  const insert = db.prepare('INSERT INTO returned (generation, entry_id, created_at) VALUES (?, ?, ?)');
  for (const entry of next.returned) insert.run(generation, entry.id, entry.created_at);
  db.prepare('DELETE FROM wake_replies WHERE generation = ? AND (created_at < ? OR (created_at = ? AND entry_id <= ?))')
    .run(generation, next.checkpoint?.created_at ?? '', next.checkpoint?.created_at ?? '', next.checkpoint?.id ?? '');
}

/** Widen the read fence and the returned set (monotonic; pruned to entries after the checkpoint). */
export function widenReadWindow(db: Transaction, generation: string, window: LocalServerCursor[]): void {
  const before = loadDelivery(db, generation);
  if (!before || window.length === 0) return;
  const returned = [...before.returned, ...window]
    .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index)
    .filter((entry) => comparePoints(entry, before.checkpoint) > 0)
    .sort((a, b) => comparePoints(a, b))
    .slice(-RETURNED_CAP);
  write(db, generation, { ...before, readThrough: later(before.readThrough, window.at(-1)!), returned });
}

/** Move the delivered checkpoint forward (never back); prunes the returned set and wake records. */
export function advanceCheckpoint(db: Transaction, generation: string, to: LocalServerCursor): {
  before: DeliveryState; after: DeliveryState;
} {
  const before = loadDelivery(db, generation);
  if (!before) throw new Error('No representative delivery state for this generation');
  const checkpoint = later(before.checkpoint, to);
  const after = { ...before, checkpoint, returned: before.returned.filter((entry) => comparePoints(entry, checkpoint) > 0) };
  write(db, generation, after);
  return { before, after };
}

export interface EnsureStateContext {
  binding: RepresentativeBinding;
  store: RepresentativeStore;
  /** The newest log position on the bound server, or null for an empty log. Called outside any transaction. */
  serverHead(): Promise<LocalServerCursor | null>;
}

/**
 * Make sure the binding's generation has its binding row and delivery row,
 * creating them on first use with the start rule:
 *   1. a valid 5.x checkpoint for this generation, non-null → that checkpoint;
 *   2. a valid 5.x checkpoint that is null → the binding start;
 *   3. history enumerable and empty (no tombstone, no checkpoint for any
 *      generation of the seat in 5.x files or in this database) → the server
 *      head (the binding start for an empty log);
 *   4. anything else → the binding start (replays; never skips).
 * Network and file reads run before the creating transaction, which re-checks
 * only local facts.
 */
export async function ensureDeliveryState(ctx: EnsureStateContext): Promise<void> {
  const generation = bindingFingerprint(ctx.binding);
  const seat = seatKey(ctx.binding);
  const probe = await ctx.store.state.transact((db) => {
    const row = currentBindingRow(db, ctx.binding.worktree);
    if (row && row.generation !== generation) throw new RepresentativeGenerationError();
    if (row && loadDelivery(db, generation)) return 'ready' as const;
    // A binding this version prepared always starts at its binding start: every
    // reply after it was bound is delivered, and nothing older was ever tracked.
    if (row?.origin === 'prepared') return 'prepared' as const;
    const seatHistory = db.prepare('SELECT 1 AS present FROM delivery WHERE seat = ? LIMIT 1').get(seat) !== undefined;
    return seatHistory ? 'history' as const : 'none' as const;
  });
  if (probe === 'ready') return;

  const bindingStart = { id: NIL_UUID, created_at: ctx.binding.boundAt };
  let kind: StartKind = 'binding';
  let start: LocalServerCursor = bindingStart;
  let checkpoint: LocalServerCursor | null = null;
  const legacy = probe === 'prepared'
    ? { checkpoint: { kind: 'absent' as const }, history: 'present' as const }
    : await readLegacyDelivery(ctx.binding);
  if (legacy.checkpoint.kind === 'valid' && legacy.checkpoint.checkpoint) {
    kind = 'checkpoint';
    start = legacy.checkpoint.checkpoint;
    checkpoint = legacy.checkpoint.checkpoint;
  } else if (legacy.checkpoint.kind !== 'valid' && legacy.history === 'empty' && probe === 'none') {
    const head = await ctx.serverHead();
    if (head) { kind = 'head'; start = head; }
  }

  await ctx.store.state.transact((db) => {
    const row = currentBindingRow(db, ctx.binding.worktree);
    if (row && row.generation !== generation) throw new RepresentativeGenerationError();
    if (!row) insertBindingRow(db, ctx.binding, seat, 'legacy');
    if (loadDelivery(db, generation)) return;
    // A concurrent first use of another generation of this seat made history
    // appear: never start at the head then.
    const historyNow = db.prepare('SELECT 1 AS present FROM delivery WHERE seat = ? LIMIT 1').get(seat) !== undefined;
    if (kind === 'head' && historyNow) { kind = 'binding'; start = bindingStart; }
    db.prepare(`INSERT INTO delivery (generation, seat, start_id, start_at, start_kind, checkpoint_id, checkpoint_at,
      read_through_id, read_through_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      generation, seat, start.id, start.created_at, kind,
      checkpoint?.id ?? null, checkpoint?.created_at ?? null, checkpoint?.id ?? null, checkpoint?.created_at ?? null);
  });
}
