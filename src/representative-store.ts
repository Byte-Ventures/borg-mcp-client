/**
 * The human representative's bindings and request ledger, stored in the
 * representative state database (representative-db.ts).
 *
 * - The BINDING: the one explicit cube + Coordinator drone a worktree's
 *   dedicated seat may talk to. Changing it requires an explicit operator
 *   rebind, which starts a new generation (binding_fingerprint).
 * - The REQUEST LEDGER, per generation: one record per sent request id, so a
 *   retry never becomes a second message and an ambiguous send survives a
 *   reconnect.
 *
 * Nothing here holds a bearer or message text (only a payload digest). The
 * only 5.x input is a worktree's binding, read once by representative-legacy.ts
 * while no 6.x row exists (decision clean-slate-no-backwards-compat).
 */

import { decodeUuid } from 'borgmcp-shared/protocol';
import { createHash } from 'node:crypto';
import { shellEscape } from './shell-escape.js';
import { createRepresentativeState, type RepresentativeState, type Transaction } from './representative-db.js';
import { legacySeed, seatKey } from './representative-legacy.js';

export function isRepresentativeUuid(value: unknown): value is string {
  try { decodeUuid(value); return true; } catch { return false; }
}
const SETTLED_REQUEST_LIMIT = 200;

/**
 * Host fence for one binding generation: hex SHA-256 of the canonical JSON array
 * [origin, trustIdentity, cubeId, representativeDroneId, coordinatorDroneId,
 * boundAt]. It changes on every rebind (boundAt) and trust change, and carries
 * no path or credential.
 */
export function bindingFingerprint(binding: RepresentativeBinding): string {
  return createHash('sha256').update(JSON.stringify([
    binding.origin, binding.trustIdentity, binding.cubeId,
    binding.representativeDroneId, binding.coordinatorDroneId, binding.boundAt,
  ])).digest('hex');
}

export interface RepresentativeBinding {
  /** Canonical worktree holding the dedicated representative seat. */
  worktree: string;
  origin: string;
  trustIdentity: string;
  cubeId: string;
  cubeName: string;
  representativeDroneId: string;
  representativeLabel: string;
  representativeRoleName: string;
  coordinatorDroneId: string;
  coordinatorLabel: string;
  coordinatorRoleName: string;
  repositoryOrigin?: string;
  boundAt: string;
}

export function representativeRecoveryCommand(binding: RepresentativeBinding): string {
  return `cd ${shellEscape(binding.worktree)} && borg representative prepare --coordinator ${shellEscape(binding.coordinatorLabel)} --role ${shellEscape(binding.representativeRoleName)} --rebind`;
}

export type RepresentativeRequestState = 'pending' | 'ambiguous' | 'sent' | 'rejected';

export interface RepresentativeRequestRecord {
  /** Stable request identity; also the protocol `post_id` idempotency key. */
  requestId: string;
  /** sha256 of kind, authorization, message, cube and Coordinator — never the text. */
  payloadDigest: string;
  kind: string;
  authorization: string;
  state: RepresentativeRequestState;
  entryId?: string;
  /** An attempt under this id may have reached the log; a later refusal must not clear that. */
  maybeStored?: boolean;
  createdAt: string;
  updatedAt: string;
}

export class RepresentativeStoreError extends Error {
  constructor(readonly code: 'BINDING_CONFLICT', message: string) {
    super(message);
    this.name = 'RepresentativeStoreError';
  }
}

export interface RepresentativeStore {
  readonly state: RepresentativeState;
  /**
   * Create the state if none exists (the first generation imports 5.x
   * bindings, once). Status never calls this: it creates nothing.
   */
  initialize(): Promise<void>;
  /** Whether a generation is published. Read-only. */
  initialized(): Promise<boolean>;
  /** The worktree's binding row, or null. Read-only; never creates anything and never reads 5.x files. */
  getBinding(worktree: string): Promise<RepresentativeBinding | null>;
  /** Every binding row. Read-only. */
  listBindings(): Promise<RepresentativeBinding[]>;
  /** The current generation's ledger for a worktree. Read-only. */
  readRequests(worktree: string): Promise<RepresentativeRequestRecord[]>;
  saveBinding(
    binding: RepresentativeBinding,
    options: { rebind: boolean },
  ): Promise<'created' | 'unchanged' | 'rebound'>;
  /**
   * Read-compare-write over the ledger of `binding`'s generation in one
   * transaction, after checking that the generation is still the worktree's
   * CURRENT one. A stale generation refuses (BINDING_MISMATCH), or with
   * `onStale: 'skip'` changes nothing and returns undefined.
   */
  transactRequests<T>(
    binding: RepresentativeBinding,
    op: (records: RepresentativeRequestRecord[]) => T,
    options?: { onStale?: 'refuse' | 'skip' },
  ): Promise<T | undefined>;
}

export class RepresentativeGenerationError extends Error {
  readonly code = 'BINDING_MISMATCH';
  constructor(message = 'The operator rebound this representative connection while this operation ran. Nothing was changed; restart the host connection to use the new binding.') {
    super(message);
    this.name = 'RepresentativeGenerationError';
  }
}

const BINDING_STRING_FIELDS = [
  'worktree', 'origin', 'trustIdentity', 'cubeId', 'cubeName',
  'representativeDroneId', 'representativeLabel', 'representativeRoleName',
  'coordinatorDroneId', 'coordinatorLabel', 'coordinatorRoleName', 'boundAt',
] as const;

function validBinding(value: unknown, key: string): value is RepresentativeBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return BINDING_STRING_FIELDS.every((field) => typeof binding[field] === 'string' && binding[field] !== '') &&
    binding.worktree === key &&
    isRepresentativeUuid(binding.cubeId as string) &&
    isRepresentativeUuid(binding.representativeDroneId as string) &&
    isRepresentativeUuid(binding.coordinatorDroneId as string) &&
    binding.representativeDroneId !== binding.coordinatorDroneId &&
    (binding.repositoryOrigin === undefined || typeof binding.repositoryOrigin === 'string');
}

/** A binding read from any untrusted source: validated exactly as `prepare` saves one, or null. */
export function parseBinding(value: unknown, worktree: string): RepresentativeBinding | null {
  if (!validBinding(value, worktree)) return null;
  const binding = value as RepresentativeBinding;
  return {
    worktree: binding.worktree, origin: binding.origin, trustIdentity: binding.trustIdentity,
    cubeId: binding.cubeId, cubeName: binding.cubeName,
    representativeDroneId: binding.representativeDroneId, representativeLabel: binding.representativeLabel,
    representativeRoleName: binding.representativeRoleName,
    coordinatorDroneId: binding.coordinatorDroneId, coordinatorLabel: binding.coordinatorLabel,
    coordinatorRoleName: binding.coordinatorRoleName,
    ...(binding.repositoryOrigin !== undefined ? { repositoryOrigin: binding.repositoryOrigin } : {}),
    boundAt: binding.boundAt,
  };
}

function validRequest(value: unknown): value is RepresentativeRequestRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isRepresentativeUuid(String(record.requestId ?? '')) &&
    typeof record.payloadDigest === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.authorization === 'string' &&
    ['pending', 'ambiguous', 'sent', 'rejected'].includes(record.state as string) &&
    (record.entryId === undefined || typeof record.entryId === 'string') &&
    (record.maybeStored === undefined || typeof record.maybeStored === 'boolean') &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string';
}

function sameSelection(a: RepresentativeBinding, b: RepresentativeBinding): boolean {
  return a.origin === b.origin &&
    a.trustIdentity === b.trustIdentity &&
    a.cubeId === b.cubeId &&
    a.representativeDroneId === b.representativeDroneId &&
    a.coordinatorDroneId === b.coordinatorDroneId;
}

/** Settled history is bounded; unresolved (pending/ambiguous) records are never dropped. */
function pruneSettled(records: RepresentativeRequestRecord[]): RepresentativeRequestRecord[] {
  const settled = records.filter((record) => record.state === 'sent' || record.state === 'rejected');
  if (settled.length <= SETTLED_REQUEST_LIMIT) return records;
  const drop = new Set(settled.slice(0, settled.length - SETTLED_REQUEST_LIMIT).map((record) => record.requestId));
  return records.filter((record) => !drop.has(record.requestId));
}

/** The worktree's CURRENT binding row inside a transaction, or null. */
export function currentBindingRow(db: Transaction, worktree: string): {
  binding: RepresentativeBinding; generation: string; origin: 'prepared' | 'legacy';
} | null {
  const row = db.prepare('SELECT binding, generation, origin FROM bindings WHERE worktree = ?').get(worktree) as
    { binding: string; generation: string; origin: 'prepared' | 'legacy' } | undefined;
  if (!row) return null;
  const binding = parseBinding(JSON.parse(row.binding), worktree);
  if (!binding || bindingFingerprint(binding) !== row.generation) {
    throw new Error(`The representative state holds an invalid binding row for ${worktree}`);
  }
  return { binding, generation: row.generation, origin: row.origin };
}

/** Refuse unless `binding`'s generation is the worktree's CURRENT one (inside the same transaction). */
export function requireCurrentGeneration(db: Transaction, binding: RepresentativeBinding): string {
  const generation = bindingFingerprint(binding);
  const current = currentBindingRow(db, binding.worktree);
  if (!current || current.generation !== generation) throw new RepresentativeGenerationError();
  return generation;
}

/**
 * `origin`: 'prepared' for a binding created by this version's `prepare`
 * (its delivery starts at the binding start), 'legacy' for a 5.x binding
 * imported on first use (its start follows the 5.x delivery evidence).
 */
/**
 * A binding generation belongs to exactly one worktree: its fingerprint names
 * no worktree, so two rows with one generation would share delivery and ledger
 * state. A second worktree claiming it refuses (the schema enforces it too).
 */
export function insertBindingRow(db: Transaction, binding: RepresentativeBinding, seat: string, origin: 'prepared' | 'legacy'): void {
  const generation = bindingFingerprint(binding);
  const holder = db.prepare('SELECT worktree FROM bindings WHERE generation = ?').get(generation) as { worktree: string } | undefined;
  if (holder && holder.worktree !== binding.worktree) {
    throw new RepresentativeStoreError('BINDING_CONFLICT',
      `Representative drone ${binding.representativeLabel} is already bound to Coordinator ${binding.coordinatorLabel} in worktree ` +
        `${holder.worktree} with the same binding generation. Prepare this worktree with its own representative seat.`);
  }
  db.prepare('INSERT INTO bindings (worktree, generation, seat, origin, binding) VALUES (?, ?, ?, ?, ?)')
    .run(binding.worktree, generation, seat, origin, JSON.stringify(binding));
}

function loadRequests(db: Transaction, generation: string): RepresentativeRequestRecord[] {
  const rows = db.prepare('SELECT record FROM requests WHERE generation = ? ORDER BY seq').all(generation) as Array<{ record: string }>;
  return rows.map((row) => {
    const record = JSON.parse(row.record) as unknown;
    if (!validRequest(record)) throw new Error('The representative state holds an invalid request record');
    return record;
  });
}

function storeRequests(db: Transaction, generation: string, records: RepresentativeRequestRecord[]): void {
  db.prepare('DELETE FROM requests WHERE generation = ?').run(generation);
  const insert = db.prepare('INSERT INTO requests (generation, seq, request_id, record) VALUES (?, ?, ?, ?)');
  records.forEach((record, index) => insert.run(generation, index, record.requestId, JSON.stringify(record)));
}

export interface RepresentativeStoreDeps {
  state: RepresentativeState;
  seatKey(binding: RepresentativeBinding): string;
}

/** The production state: its first generation is seeded once from 5.x files. */
export function createDefaultRepresentativeState(): RepresentativeState {
  return createRepresentativeState({ seed: legacySeed });
}

export function createRepresentativeStore(overrides: Partial<RepresentativeStoreDeps> = {}): RepresentativeStore {
  const deps: RepresentativeStoreDeps = {
    state: overrides.state ?? createDefaultRepresentativeState(),
    seatKey: overrides.seatKey ?? seatKey,
  };
  const readRow = async (worktree: string) =>
    deps.state.readOnly((db) => currentBindingRow(db, worktree)?.binding ?? null);

  return {
    state: deps.state,

    initialize: async () => { await deps.state.transact(() => undefined); },

    initialized: async () => (await deps.state.readOnly(() => true)) ?? false,

    getBinding: readRow,

    listBindings: async () => (await deps.state.readOnly((db) =>
      (db.prepare('SELECT worktree FROM bindings ORDER BY worktree').all() as Array<{ worktree: string }>)
        .map((row) => currentBindingRow(db, row.worktree)!.binding))) ?? [],

    readRequests: async (worktree) => (await deps.state.readOnly((db) => {
      const current = currentBindingRow(db, worktree);
      return current ? loadRequests(db, current.generation) : [];
    })) ?? [],

    saveBinding: async (binding, options) => {
      if (!validBinding(binding, binding.worktree)) {
        throw new Error('Refusing to save an invalid representative binding');
      }
      return deps.state.transact((db) => {
        const row = currentBindingRow(db, binding.worktree);
        const existing = row?.binding;
        // An explicit rebind always starts a new generation (new boundAt, so a new
        // binding_fingerprint), even for the same selection.
        if (existing && sameSelection(existing, binding) && !options.rebind) return 'unchanged' as const;
        if (existing && !options.rebind) {
          throw new RepresentativeStoreError(
            'BINDING_CONFLICT',
            `This worktree is already bound to Coordinator ${existing.coordinatorLabel} in cube ${existing.cubeName}. ` +
              `To confirm the new selection, run \`${representativeRecoveryCommand(binding)}\`.`,
          );
        }
        const carried = row && sameSelection(row.binding, binding) ? loadRequests(db, row.generation) : [];
        db.prepare('DELETE FROM bindings WHERE worktree = ?').run(binding.worktree);
        insertBindingRow(db, binding, deps.seatKey(binding), 'prepared');
        // The same selection keeps its ledger (so unresolved sends keep blocking
        // identical content); a different selection starts with none.
        if (carried.length > 0) storeRequests(db, bindingFingerprint(binding), carried);
        return existing ? 'rebound' as const : 'created' as const;
      });
    },

    transactRequests: (binding, op, options = {}) => deps.state.transact((db) => {
      let generation: string;
      try {
        generation = requireCurrentGeneration(db, binding);
      } catch (error) {
        if (options.onStale === 'skip' && error instanceof RepresentativeGenerationError) return undefined;
        throw error;
      }
      const records = loadRequests(db, generation);
      const before = JSON.stringify(records);
      const result = op(records);
      const next = pruneSettled(records);
      if (JSON.stringify(next) !== before) storeRequests(db, generation, next);
      return result;
    }),
  };
}
