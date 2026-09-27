/**
 * Private on-disk state for the human representative connection.
 *
 * One 0600 file under the Borg config root holds, per representative worktree:
 * - the BINDING: the one explicit cube + Coordinator drone this worktree's
 *   dedicated seat may talk to. Changing it requires an explicit operator rebind.
 * - the REQUEST LEDGER: one record per sent request id, so a retry never becomes
 *   a second message and an ambiguous send survives a reconnect.
 *
 * The file never holds a bearer (the seat store owns credentials) and never
 * holds message text (only a payload digest).
 */

import { decodeUuid } from 'borgmcp-shared/protocol';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { shellEscape } from './shell-escape.js';
import { readStoreFile, withStore } from './seat-store.js';

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

interface RepresentativeFile {
  version: 1;
  bindings: Record<string, RepresentativeBinding>;
  requests: Record<string, RepresentativeRequestRecord[]>;
}

export class RepresentativeStoreError extends Error {
  constructor(readonly code: 'BINDING_CONFLICT', message: string) {
    super(message);
    this.name = 'RepresentativeStoreError';
  }
}

export interface RepresentativeStore {
  getBinding(worktree: string): Promise<RepresentativeBinding | null>;
  readRequests(worktree: string): Promise<RepresentativeRequestRecord[]>;
  saveBinding(
    binding: RepresentativeBinding,
    options: { rebind: boolean },
  ): Promise<'created' | 'unchanged' | 'rebound'>;
  /** Read-compare-write over one worktree's ledger under the store lock. */
  transactRequests<T>(
    worktree: string,
    op: (records: RepresentativeRequestRecord[]) => T,
  ): Promise<T>;
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

function parseFile(raw: string): RepresentativeFile | null {
  const parsed = JSON.parse(raw) as Partial<RepresentativeFile> | null;
  if (
    parsed === null || typeof parsed !== 'object' || parsed.version !== 1 ||
    parsed.bindings === null || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings) ||
    parsed.requests === null || typeof parsed.requests !== 'object' || Array.isArray(parsed.requests)
  ) return null;
  for (const [key, binding] of Object.entries(parsed.bindings)) {
    if (!validBinding(binding, key)) return null;
  }
  for (const records of Object.values(parsed.requests)) {
    if (!Array.isArray(records) || !records.every(validRequest)) return null;
  }
  return parsed as RepresentativeFile;
}

const emptyFile = (): RepresentativeFile => ({ version: 1, bindings: {}, requests: {} });

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

export function representativeStorePath(): string {
  return join(borgConfigRoot(), 'representative.json');
}

export function createRepresentativeStore(storePath: string = representativeStorePath()): RepresentativeStore {
  // Atomic writer renames make a single read a complete snapshot, without a
  // store-lock write or pruning settled history during read-only status.
  const read = async () => {
    const raw = await readStoreFile(storePath);
    if (raw === null) return emptyFile();
    let data: RepresentativeFile | null;
    try { data = parseFile(raw); } catch { data = null; }
    if (!data) throw new Error('Borg representative store is malformed or unsupported; refusing to read it');
    return data;
  };
  return {
    getBinding: async (worktree) => (await read()).bindings[worktree] ?? null,
    readRequests: async (worktree) => (await read()).requests[worktree] ?? [],

    saveBinding: (binding, options) => withStore(storePath, emptyFile, parseFile, async (txn) => {
      if (!validBinding(binding, binding.worktree)) {
        throw new Error('Refusing to save an invalid representative binding');
      }
      const existing = txn.data.bindings[binding.worktree];
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
      txn.data.bindings[binding.worktree] = binding;
      // A different selection invalidates the old ledger: its post ids belong to
      // another cube/Coordinator conversation.
      if (existing && !sameSelection(existing, binding)) delete txn.data.requests[binding.worktree];
      await txn.commit();
      return existing ? 'rebound' as const : 'created' as const;
    }),

    transactRequests: (worktree, op) => withStore(storePath, emptyFile, parseFile, async (txn) => {
      const records = txn.data.requests[worktree] ?? [];
      const before = JSON.stringify(records);
      const result = op(records);
      const next = pruneSettled(records);
      if (JSON.stringify(next) !== before) {
        txn.data.requests[worktree] = next;
        await txn.commit();
      }
      return result;
    }),
  };
}
