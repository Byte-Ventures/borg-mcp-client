/**
 * The push engine: which direct Coordinator replies wake the host, and when.
 *
 * All wake state lives in the representative state database, per binding
 * generation: the replies discovery found (wake_replies: attempts, next_at)
 * and one document (wake_state.state) holding the discovery frontier, the one
 * outstanding batch, refusal backoff, the startup cohort and the debounce.
 * Every transition is one transaction that first checks the binding
 * generation is still current, and every wake is written before it is
 * emitted. Network reads (discovery pages, the server head) run outside
 * transactions.
 *
 * Rules (design rev 2 §3.4, rev 3 §2, rev 5 §2):
 * - EMIT: only when no batch is outstanding, refusal backoff is over, the
 *   startup cohort is closed and the debounce deadline has passed. Every due
 *   reply joins one batch: attempts += 1, next_at = now + backoff(attempts).
 *   The batch is outstanding until a matching ack or its 60 s deadline.
 * - ACK accepted (matching batch): clears it and resets refusals.
 * - ACK refused (matching batch): members still present get attempts -= 1 and
 *   next_at = the refusal retry time; refusals.count += 1 and the retry is
 *   min(30 s * 2^(count-1), 30 min) away.
 * - ACK anything else (late, duplicate, unknown, malformed): no change.
 * - Timeout: the batch clears and its attempts stay counted.
 * - Discovery: one scan at a time (a trigger during a scan runs one more
 *   scan), one transaction per 200-entry page, insert-if-absent, frontier only
 *   moves forward, the scheduler runs between pages.
 * - Cohort: each start captures, with one bounded request, how many log
 *   entries lie beyond the scan position (the server's behind_by); EMIT waits
 *   until discovery has scanned that many, then one 'startup' batch carries
 *   every due reply. A restart mid-cohort keeps the remaining count, so the
 *   target never moves forward, and a growing log cannot extend it.
 * - Stop: after stop() no transition, page merge or network request starts,
 *   and a request in flight is abandoned.
 * - Clock: a persisted instant more than 24 h ahead is clamped to now + 24 h.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from './representative-db.js';
import { comparePoints, loadDelivery, scanStart } from './representative-delivery-store.js';
import {
  isRepresentativeUuid, requireCurrentGeneration, type RepresentativeBinding, type RepresentativeStore,
} from './representative-store.js';
import { isAddressedCoordinatorEntry, type LogEntry, type RepresentativeBackend } from './representative-core.js';
import type { LocalServerCursor } from './local-server-cursor.js';

export const WAKE_ACK_DEADLINE_MS = 60_000;
export const WAKE_DEBOUNCE_MS = 2_000;
export const DISCOVERY_PAGE = 200;
export const WAKE_ACK_LINE_MAX_BYTES = 1024;
const REWAKE_BACKOFF_MS = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const REFUSAL_BACKOFF_BASE_MS = 30_000;
const REFUSAL_BACKOFF_MAX_MS = 30 * 60_000;
const MAX_FUTURE_MS = 24 * 60 * 60_000;

export type WakeReason = 'startup' | 'new-reply' | 'rewake';

export interface WakeDocument {
  version: 1;
  frontier: LocalServerCursor | null;
  outstanding: { batch: string; replies: string[]; deadline: string; reason: WakeReason } | null;
  refusals: { count: number; retry_at: string | null };
  /** Entries still to scan before the startup batch; null until the first capture. */
  cohort: { remaining: number; open: boolean } | null;
  /** The cohort closed and its one startup batch has not been emitted yet. */
  startup_pending: boolean;
  debounce_at: string | null;
}

export const rewakeBackoffMs = (attempts: number) => REWAKE_BACKOFF_MS[Math.min(Math.max(attempts, 1), REWAKE_BACKOFF_MS.length) - 1];
export const refusalBackoffMs = (count: number) => Math.min(REFUSAL_BACKOFF_BASE_MS * 2 ** Math.max(count - 1, 0), REFUSAL_BACKOFF_MAX_MS);

const emptyDocument = (): WakeDocument => ({
  version: 1, frontier: null, outstanding: null, refusals: { count: 0, retry_at: null },
  cohort: null, startup_pending: false, debounce_at: null,
});

const isInstant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isPoint = (value: unknown): value is LocalServerCursor =>
  value !== null && typeof value === 'object' && isRepresentativeUuid((value as LocalServerCursor).id) &&
  isInstant((value as LocalServerCursor).created_at);

function parseDocument(raw: string): WakeDocument {
  const value = JSON.parse(raw) as Partial<WakeDocument>;
  const outstanding = value.outstanding;
  const valid = value.version === 1 &&
    (value.frontier === null || isPoint(value.frontier)) &&
    (outstanding === null || (outstanding !== undefined && isRepresentativeUuid(outstanding.batch) &&
      Array.isArray(outstanding.replies) && outstanding.replies.every(isRepresentativeUuid) && isInstant(outstanding.deadline) &&
      ['startup', 'new-reply', 'rewake'].includes(outstanding.reason))) &&
    value.refusals !== undefined && Number.isInteger(value.refusals.count) && value.refusals.count >= 0 &&
    (value.refusals.retry_at === null || isInstant(value.refusals.retry_at)) &&
    (value.cohort === null || (value.cohort !== undefined && typeof value.cohort.open === 'boolean' &&
      Number.isInteger(value.cohort.remaining) && value.cohort.remaining >= 0)) &&
    typeof value.startup_pending === 'boolean' &&
    (value.debounce_at === null || isInstant(value.debounce_at));
  if (!valid) throw new Error('The representative state holds an invalid wake record');
  return value as WakeDocument;
}

function loadDocument(db: Transaction, generation: string): WakeDocument {
  const row = db.prepare('SELECT state FROM wake_state WHERE generation = ?').get(generation) as { state: string } | undefined;
  return row ? parseDocument(row.state) : emptyDocument();
}

function saveDocument(db: Transaction, generation: string, doc: WakeDocument): void {
  db.prepare(`INSERT INTO wake_state (generation, state) VALUES (?, ?)
    ON CONFLICT (generation) DO UPDATE SET state = excluded.state`).run(generation, JSON.stringify(doc));
}

interface WakeRow { entry_id: string; created_at: string; attempts: number; next_at: string }

function rows(db: Transaction, generation: string): WakeRow[] {
  return db.prepare('SELECT entry_id, created_at, attempts, next_at FROM wake_replies WHERE generation = ? ORDER BY created_at, entry_id')
    .all(generation) as unknown as WakeRow[];
}

const later = (a: LocalServerCursor | null, b: LocalServerCursor | null) =>
  a === null ? b : b === null ? a : comparePoints(a, b) >= 0 ? a : b;

export interface WakeEmission { wake_id: string; reason: WakeReason; count: number }
export type AckOutcome = 'accepted' | 'refused' | 'ignored';

export interface PushEngineDeps {
  binding: RepresentativeBinding;
  store: RepresentativeStore;
  backend: RepresentativeBackend;
  now(): Date;
  /** Writes one wake event to the host. Called only after the wake is persisted. */
  emit(wake: WakeEmission): Promise<void>;
  /** Test seams (crash and pause controls). */
  hooks?: {
    /** After an EMIT transaction committed, before its event is written. */
    afterWakePersisted?(wake: WakeEmission): void | Promise<void>;
    /** After a discovery page was merged, before the next page is read. */
    betweenPages?(page: number): void | Promise<void>;
  };
}

export interface WakeSummary {
  undelivered: number;
  outstanding: { wake_id: string; count: number; deadline: string } | null;
  refusals: { count: number; retry_at: string | null };
  cohort_open: boolean;
  frontier: LocalServerCursor | null;
}

export class EngineStoppedError extends Error {
  constructor() { super('The push engine stopped'); this.name = 'EngineStoppedError'; }
}

export class PushEngine {
  private chain: Promise<unknown> = Promise.resolve();
  private scanning: Promise<void> | null = null;
  private rescan = false;
  private readonly halt = new AbortController();
  private readonly halted: Promise<never>;

  constructor(private readonly deps: PushEngineDeps) {
    this.halted = new Promise<never>((_, reject) => {
      this.halt.signal.addEventListener('abort', () => reject(new EngineStoppedError()), { once: true });
    });
    this.halted.catch(() => {});
  }

  get stopped(): boolean { return this.halt.signal.aborted; }

  /** One cancellation for everything: no later transition, merge or request, and a request in flight is abandoned. */
  stop(): void { this.halt.abort(); }

  /** A network read that stop() abandons at once. */
  private network<T>(request: Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new EngineStoppedError());
    request.catch(() => {}); // an abandoned request may still fail later
    return Promise.race([request, this.halted]);
  }

  /** Transitions and their emits run one at a time, in order; none starts after stop(). */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const result = this.chain.then(() => {
      if (this.stopped) throw new EngineStoppedError();
      return step();
    });
    this.chain = result.catch(() => {});
    return result;
  }

  private transact<T>(body: (db: Transaction, generation: string, now: Date) => T): Promise<T> {
    return this.deps.store.state.transact((db) => {
      const generation = requireCurrentGeneration(db, this.deps.binding);
      return body(db, generation, this.deps.now());
    });
  }

  /** Clamp instants a clock jump left more than 24 h ahead. */
  private clamp(db: Transaction, generation: string, doc: WakeDocument, now: Date): void {
    const limit = new Date(now.getTime() + MAX_FUTURE_MS).toISOString();
    db.prepare('UPDATE wake_replies SET next_at = ? WHERE generation = ? AND next_at > ?').run(limit, generation, limit);
    if (doc.outstanding && doc.outstanding.deadline > limit) doc.outstanding.deadline = limit;
    if (doc.refusals.retry_at && doc.refusals.retry_at > limit) doc.refusals.retry_at = limit;
    if (doc.debounce_at && doc.debounce_at > limit) doc.debounce_at = limit;
  }

  /**
   * Start of a run: capture the startup cohort with one bounded request (the
   * number of entries beyond the scan position). An open cohort from an
   * interrupted run keeps its remaining count, so the target never moves
   * forward. Must run before the first discovery.
   */
  async captureCohort(): Promise<WakeSummary> {
    const cursor = await this.serial(() => this.transact((db, generation) => {
      const doc = loadDocument(db, generation);
      if (doc.cohort?.open) return undefined; // resume the stored target: no request
      const delivery = loadDelivery(db, generation);
      if (!delivery) throw new Error('Representative delivery state is missing for the current generation');
      return later(doc.frontier, scanStart(delivery).cursor);
    }));
    if (cursor !== undefined) {
      const probe = await this.network(this.deps.backend.readAfter(cursor, 1));
      // Without behind_by the size is unknown: no gate, normal fairness only.
      const count = probe.behind_by === undefined ? 0 : probe.entries.length + probe.behind_by;
      await this.serial(() => this.transact((db, generation) => {
        const doc = loadDocument(db, generation);
        if (doc.cohort?.open) return;
        doc.cohort = { remaining: count, open: count > 0 };
        doc.startup_pending = false;
        saveDocument(db, generation, doc);
      }));
    }
    return this.summary();
  }

  async summary(): Promise<WakeSummary> {
    return this.transact((db, generation) => summarize(db, generation));
  }

  /**
   * Discovery: single-flight. A trigger while a scan runs makes that scan run
   * once more when it ends. Resolves when no scan is pending.
   */
  discover(): Promise<void> {
    if (this.scanning) { this.rescan = true; return this.scanning; }
    this.scanning = (async () => {
      try {
        do { this.rescan = false; await this.scanOnce(); } while (this.rescan);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    let cursor = await this.serial(() => this.transact((db, generation) => {
      const delivery = loadDelivery(db, generation);
      if (!delivery) throw new Error('Representative delivery state is missing for the current generation');
      // From the frontier, or the delivered position if the host has read further.
      return later(loadDocument(db, generation).frontier, scanStart(delivery).cursor);
    }));
    for (let page = 1; ; page += 1) {
      const result = await this.network(this.deps.backend.readAfter(cursor, DISCOVERY_PAGE));
      const tail = result.entries.at(-1);
      const tailPoint = tail ? { id: tail.id, created_at: tail.created_at } : null;
      await this.serial(() => this.transact((db, generation, now) =>
        this.merge(db, generation, now, result.entries, tailPoint, result.has_more === true)));
      await this.deps.hooks?.betweenPages?.(page);
      await this.tick(); // fairness: a due wake fires between pages
      if (!result.has_more || !tailPoint) return;
      cursor = tailPoint;
    }
  }

  private merge(db: Transaction, generation: string, now: Date, entries: LogEntry[], tail: LocalServerCursor | null, more: boolean): number {
    const delivery = loadDelivery(db, generation);
    if (!delivery) throw new Error('Representative delivery state is missing for the current generation');
    const doc = loadDocument(db, generation);
    const floor = scanStart(delivery).floor;
    const insert = db.prepare(`INSERT OR IGNORE INTO wake_replies (generation, entry_id, created_at, attempts, next_at)
      VALUES (?, ?, ?, 0, ?)`);
    let inserted = 0;
    for (const entry of entries) {
      if (isAddressedCoordinatorEntry(this.deps.binding, entry) !== 'direct') continue;
      if (comparePoints({ id: entry.id, created_at: entry.created_at }, floor) <= 0) continue;
      inserted += Number(insert.run(generation, entry.id, entry.created_at, now.toISOString()).changes);
    }
    db.prepare(`DELETE FROM wake_replies WHERE generation = ? AND (created_at < ? OR (created_at = ? AND entry_id <= ?))`)
      .run(generation, floor.created_at, floor.created_at, floor.id);
    doc.frontier = later(doc.frontier, tail);
    if (doc.cohort?.open) doc.cohort.remaining = Math.max(doc.cohort.remaining - entries.length, 0);
    if (doc.cohort?.open && (doc.cohort.remaining === 0 || !more)) {
      // The startup scan covered the log as it was at capture: one startup batch, now.
      doc.cohort.open = false;
      doc.startup_pending = rows(db, generation).length > 0;
      doc.debounce_at = null;
    } else if (inserted > 0 && !doc.cohort?.open && !doc.debounce_at) {
      doc.debounce_at = new Date(now.getTime() + WAKE_DEBOUNCE_MS).toISOString(); // never extended
    }
    saveDocument(db, generation, doc);
    return inserted;
  }

  /**
   * One scheduler step: expire an outstanding batch whose deadline passed,
   * then EMIT if a wake is eligible. The wake is committed before it is
   * written to the host.
   */
  tick(): Promise<WakeEmission | null> {
    if (this.stopped) return Promise.resolve(null);
    return this.serial(async () => {
      const wake = await this.transact((db, generation, now) => {
        const doc = loadDocument(db, generation);
        this.clamp(db, generation, doc, now);
        const at = now.toISOString();
        if (doc.outstanding && doc.outstanding.deadline <= at) doc.outstanding = null; // timeout: attempts stay counted
        const blocked = doc.outstanding !== null || (doc.refusals.retry_at !== null && doc.refusals.retry_at > at) ||
          doc.cohort?.open === true || (doc.debounce_at !== null && doc.debounce_at > at);
        const due = blocked ? [] : rows(db, generation).filter((row) => row.next_at <= at);
        if (due.length === 0) { saveDocument(db, generation, doc); return null; }
        const reason: WakeReason = doc.startup_pending ? 'startup' : due.some((row) => row.attempts === 0) ? 'new-reply' : 'rewake';
        const update = db.prepare('UPDATE wake_replies SET attempts = ?, next_at = ? WHERE generation = ? AND entry_id = ?');
        for (const row of due) {
          const attempts = row.attempts + 1;
          update.run(attempts, new Date(now.getTime() + rewakeBackoffMs(attempts)).toISOString(), generation, row.entry_id);
        }
        const batch = randomUUID();
        doc.outstanding = { batch, replies: due.map((row) => row.entry_id), deadline: new Date(now.getTime() + WAKE_ACK_DEADLINE_MS).toISOString(), reason };
        doc.startup_pending = false;
        doc.debounce_at = null;
        if (doc.refusals.retry_at !== null && doc.refusals.retry_at <= at) doc.refusals.retry_at = null;
        saveDocument(db, generation, doc);
        return { wake_id: batch, reason, count: due.length };
      });
      if (wake) {
        await this.deps.hooks?.afterWakePersisted?.(wake);
        await this.deps.emit(wake);
      }
      return wake;
    });
  }

  /** The next instant (ms) at which tick() can change something; null when only discovery can. */
  nextDueAt(): Promise<number | null> {
    return this.transact((db, generation, now) => {
      const doc = loadDocument(db, generation);
      const limit = now.getTime() + MAX_FUTURE_MS;
      const ms = (iso: string) => Math.min(Date.parse(iso), limit);
      if (doc.outstanding) return ms(doc.outstanding.deadline);
      if (doc.refusals.retry_at && Date.parse(doc.refusals.retry_at) > now.getTime()) return ms(doc.refusals.retry_at);
      if (doc.cohort?.open) return null;
      const pending = rows(db, generation);
      if (pending.length === 0) return null;
      const earliest = Math.min(...pending.map((row) => ms(row.next_at)));
      return doc.debounce_at ? Math.max(earliest, ms(doc.debounce_at)) : earliest;
    });
  }

  /**
   * One stdin line from the host. Only a well-formed ack for the outstanding
   * batch changes anything, and only wake fields: never delivery, returned
   * entries, the request ledger or the frontier.
   */
  ack(line: string): Promise<AckOutcome> {
    const parsed = parseAck(line);
    if (!parsed || this.stopped) return Promise.resolve('ignored');
    return this.serial(() => this.transact((db, generation, now): AckOutcome => {
      const doc = loadDocument(db, generation);
      if (doc.outstanding && doc.outstanding.deadline <= now.toISOString()) {
        // The deadline is absolute: an ack after it is late, whenever the
        // timer runs. The batch times out and its attempt stays counted.
        doc.outstanding = null;
        saveDocument(db, generation, doc);
        return 'ignored';
      }
      if (!doc.outstanding || doc.outstanding.batch !== parsed.wake_id) return 'ignored';
      if (parsed.accepted) {
        doc.outstanding = null;
        doc.refusals = { count: 0, retry_at: null };
        saveDocument(db, generation, doc);
        return 'accepted';
      }
      const count = doc.refusals.count + 1;
      const retry = new Date(now.getTime() + refusalBackoffMs(count)).toISOString();
      const rollback = db.prepare(`UPDATE wake_replies SET attempts = MAX(attempts - 1, 0), next_at = ?
        WHERE generation = ? AND entry_id = ?`);
      for (const entryId of doc.outstanding.replies) rollback.run(retry, generation, entryId); // pruned replies stay pruned
      doc.outstanding = null;
      doc.refusals = { count, retry_at: retry };
      saveDocument(db, generation, doc);
      return 'refused';
    }));
  }
}

/** A stdin ack: at most 1 KiB, exactly {wake_id: uuid, accepted: boolean}. Anything else is null (ignored). */
export function parseAck(line: string): { wake_id: string; accepted: boolean } | null {
  if (Buffer.byteLength(line) > WAKE_ACK_LINE_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  const { wake_id: wakeId, accepted } = value as { wake_id?: unknown; accepted?: unknown };
  if (keys.length !== 2 || !isRepresentativeUuid(wakeId) || typeof accepted !== 'boolean') return null;
  return { wake_id: wakeId, accepted };
}

function summarize(db: Transaction, generation: string): WakeSummary {
  const doc = loadDocument(db, generation);
  return {
    undelivered: rows(db, generation).length,
    outstanding: doc.outstanding
      ? { wake_id: doc.outstanding.batch, count: doc.outstanding.replies.length, deadline: doc.outstanding.deadline } : null,
    refusals: doc.refusals,
    cohort_open: doc.cohort?.open === true,
    frontier: doc.frontier,
  };
}

/** Read-only wake summary for status; null when the state or the generation has none. Never creates anything. */
export async function readWakeSummary(store: RepresentativeStore, binding: RepresentativeBinding): Promise<WakeSummary | null> {
  return store.state.readOnly((db) => {
    const row = db.prepare('SELECT generation FROM bindings WHERE worktree = ?').get(binding.worktree) as { generation: string } | undefined;
    if (!row) return null;
    return summarize(db, row.generation);
  }).then((value) => value ?? null);
}
