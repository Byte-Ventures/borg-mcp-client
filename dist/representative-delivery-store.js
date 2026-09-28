import { bindingFingerprint, currentBindingRow, RepresentativeGenerationError, } from './representative-store.js';
import { seatKey } from './representative-legacy.js';
/** Two windows of at most 50 replies (with and without broadcasts). */
const RETURNED_CAP = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** (created_at, id) order, the server log order. */
export function comparePoints(a, b) {
    if (b === null)
        return 1;
    if (a.created_at !== b.created_at)
        return a.created_at < b.created_at ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}
const later = (a, b) => a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;
const point = (id, at) => id === null || at === null ? null : { id, created_at: at };
export function loadDelivery(db, generation) {
    const row = db.prepare(`SELECT start_id, start_at, start_kind, checkpoint_id, checkpoint_at, read_through_id, read_through_at
    FROM delivery WHERE generation = ?`).get(generation);
    if (!row)
        return null;
    const returned = db.prepare('SELECT entry_id, created_at FROM returned WHERE generation = ?').all(generation)
        .map((entry) => ({ id: entry.entry_id, created_at: entry.created_at }))
        .sort((a, b) => comparePoints(a, b));
    return {
        start: { id: row.start_id, created_at: row.start_at },
        startKind: row.start_kind,
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
export function scanStart(state) {
    if (state.startKind === 'head-pending')
        throw new Error('The delivery start is not resolved yet');
    const floor = later(state.start, state.checkpoint);
    if (state.checkpoint)
        return { cursor: state.checkpoint, floor };
    return { cursor: state.startKind === 'binding' ? null : state.start, floor };
}
function write(db, generation, next) {
    if (next.checkpoint && (next.readThrough === null || comparePoints(next.checkpoint, next.readThrough) > 0)) {
        throw new Error('A representative state write would move the checkpoint beyond the read fence');
    }
    db.prepare(`UPDATE delivery SET checkpoint_id = ?, checkpoint_at = ?, read_through_id = ?, read_through_at = ?
    WHERE generation = ?`).run(next.checkpoint?.id ?? null, next.checkpoint?.created_at ?? null, next.readThrough?.id ?? null, next.readThrough?.created_at ?? null, generation);
    db.prepare('DELETE FROM returned WHERE generation = ?').run(generation);
    const insert = db.prepare('INSERT INTO returned (generation, entry_id, created_at) VALUES (?, ?, ?)');
    for (const entry of next.returned)
        insert.run(generation, entry.id, entry.created_at);
    db.prepare('DELETE FROM wake_replies WHERE generation = ? AND (created_at < ? OR (created_at = ? AND entry_id <= ?))')
        .run(generation, next.checkpoint?.created_at ?? '', next.checkpoint?.created_at ?? '', next.checkpoint?.id ?? '');
}
/** Widen the read fence and the returned set (monotonic; pruned to entries after the checkpoint). */
export function widenReadWindow(db, generation, window) {
    const before = loadDelivery(db, generation);
    if (!before || window.length === 0)
        return;
    const returned = [...before.returned, ...window]
        .filter((entry, index, all) => all.findIndex((other) => other.id === entry.id) === index)
        .filter((entry) => comparePoints(entry, before.checkpoint) > 0)
        .sort((a, b) => comparePoints(a, b))
        .slice(-RETURNED_CAP);
    write(db, generation, { ...before, readThrough: later(before.readThrough, window.at(-1)), returned });
}
/** Move the delivered checkpoint forward (never back); prunes the returned set and wake records. */
export function advanceCheckpoint(db, generation, to) {
    const before = loadDelivery(db, generation);
    if (!before)
        throw new Error('No representative delivery state for this generation');
    const checkpoint = later(before.checkpoint, to);
    const after = { ...before, checkpoint, returned: before.returned.filter((entry) => comparePoints(entry, checkpoint) > 0) };
    write(db, generation, after);
    return { before, after };
}
/**
 * Make sure the binding's generation has a resolved delivery row. The binding
 * row must already exist (prepare, or the one-time 5.x import when the state was
 * created); this never reads 5.x files.
 * - A prepared generation without a row starts at its binding start.
 * - An imported 5.x generation left 'head-pending' (no 5.x history for its
 *   seat) starts at the server head, read outside any transaction; if another
 *   generation of the seat has delivery state by the time it is written, or
 *   the head cannot be reached in a bounded read (a very long or fast-growing
 *   log), it starts at the binding start instead (replays, never skips).
 */
export async function ensureDeliveryState(ctx) {
    const generation = bindingFingerprint(ctx.binding);
    const seat = seatKey(ctx.binding);
    const bindingStart = { id: NIL_UUID, created_at: ctx.binding.boundAt };
    const current = (db) => {
        const row = currentBindingRow(db, ctx.binding.worktree);
        if (!row || row.generation !== generation)
            throw new RepresentativeGenerationError();
        return row;
    };
    const insert = (db, kind, start) => db.prepare(`INSERT INTO delivery
    (generation, seat, start_id, start_at, start_kind, checkpoint_id, checkpoint_at, read_through_id, read_through_at)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`).run(generation, seat, start.id, start.created_at, kind);
    const pending = await ctx.store.state.transact((db) => {
        current(db);
        const kind = startKindOf(db, generation);
        if (kind === null) {
            insert(db, 'binding', bindingStart);
            return false;
        }
        return kind === 'head-pending';
    });
    if (!pending)
        return;
    const head = await ctx.serverHead();
    ctx.signal?.throwIfAborted();
    await ctx.store.state.transact((db) => {
        current(db);
        if (startKindOf(db, generation) !== 'head-pending')
            return;
        const seatHistory = db.prepare('SELECT 1 AS present FROM delivery WHERE seat = ? AND generation != ? LIMIT 1')
            .get(seat, generation) !== undefined;
        const [kind, start] = head && head !== 'unbounded' && !seatHistory ? ['head', head] : ['binding', bindingStart];
        db.prepare('UPDATE delivery SET start_kind = ?, start_id = ?, start_at = ? WHERE generation = ?')
            .run(kind, start.id, start.created_at, generation);
    });
}
function startKindOf(db, generation) {
    const row = db.prepare('SELECT start_kind FROM delivery WHERE generation = ?').get(generation);
    return (row?.start_kind ?? null);
}
//# sourceMappingURL=representative-delivery-store.js.map