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
import { createRepresentativeState } from './representative-db.js';
import { readLegacyBinding, readLegacyBindings, seatKey } from './representative-legacy.js';
export function isRepresentativeUuid(value) {
    try {
        decodeUuid(value);
        return true;
    }
    catch {
        return false;
    }
}
const SETTLED_REQUEST_LIMIT = 200;
/**
 * Host fence for one binding generation: hex SHA-256 of the canonical JSON array
 * [origin, trustIdentity, cubeId, representativeDroneId, coordinatorDroneId,
 * boundAt]. It changes on every rebind (boundAt) and trust change, and carries
 * no path or credential.
 */
export function bindingFingerprint(binding) {
    return createHash('sha256').update(JSON.stringify([
        binding.origin, binding.trustIdentity, binding.cubeId,
        binding.representativeDroneId, binding.coordinatorDroneId, binding.boundAt,
    ])).digest('hex');
}
export function representativeRecoveryCommand(binding) {
    return `cd ${shellEscape(binding.worktree)} && borg representative prepare --coordinator ${shellEscape(binding.coordinatorLabel)} --role ${shellEscape(binding.representativeRoleName)} --rebind`;
}
export class RepresentativeStoreError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RepresentativeStoreError';
    }
}
export class RepresentativeGenerationError extends Error {
    code = 'BINDING_MISMATCH';
    constructor(message = 'The operator rebound this representative connection while this operation ran. Nothing was changed; restart the host connection to use the new binding.') {
        super(message);
        this.name = 'RepresentativeGenerationError';
    }
}
const BINDING_STRING_FIELDS = [
    'worktree', 'origin', 'trustIdentity', 'cubeId', 'cubeName',
    'representativeDroneId', 'representativeLabel', 'representativeRoleName',
    'coordinatorDroneId', 'coordinatorLabel', 'coordinatorRoleName', 'boundAt',
];
function validBinding(value, key) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const binding = value;
    return BINDING_STRING_FIELDS.every((field) => typeof binding[field] === 'string' && binding[field] !== '') &&
        binding.worktree === key &&
        isRepresentativeUuid(binding.cubeId) &&
        isRepresentativeUuid(binding.representativeDroneId) &&
        isRepresentativeUuid(binding.coordinatorDroneId) &&
        binding.representativeDroneId !== binding.coordinatorDroneId &&
        (binding.repositoryOrigin === undefined || typeof binding.repositoryOrigin === 'string');
}
/** A binding read from any untrusted source: validated exactly as `prepare` saves one, or null. */
export function parseBinding(value, worktree) {
    if (!validBinding(value, worktree))
        return null;
    const binding = value;
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
function validRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return isRepresentativeUuid(String(record.requestId ?? '')) &&
        typeof record.payloadDigest === 'string' &&
        typeof record.kind === 'string' &&
        typeof record.authorization === 'string' &&
        ['pending', 'ambiguous', 'sent', 'rejected'].includes(record.state) &&
        (record.entryId === undefined || typeof record.entryId === 'string') &&
        (record.maybeStored === undefined || typeof record.maybeStored === 'boolean') &&
        typeof record.createdAt === 'string' &&
        typeof record.updatedAt === 'string';
}
function sameSelection(a, b) {
    return a.origin === b.origin &&
        a.trustIdentity === b.trustIdentity &&
        a.cubeId === b.cubeId &&
        a.representativeDroneId === b.representativeDroneId &&
        a.coordinatorDroneId === b.coordinatorDroneId;
}
/** Settled history is bounded; unresolved (pending/ambiguous) records are never dropped. */
function pruneSettled(records) {
    const settled = records.filter((record) => record.state === 'sent' || record.state === 'rejected');
    if (settled.length <= SETTLED_REQUEST_LIMIT)
        return records;
    const drop = new Set(settled.slice(0, settled.length - SETTLED_REQUEST_LIMIT).map((record) => record.requestId));
    return records.filter((record) => !drop.has(record.requestId));
}
/** The worktree's CURRENT binding row inside a transaction, or null. */
export function currentBindingRow(db, worktree) {
    const row = db.prepare('SELECT binding, generation, origin FROM bindings WHERE worktree = ?').get(worktree);
    if (!row)
        return null;
    const binding = parseBinding(JSON.parse(row.binding), worktree);
    if (!binding || bindingFingerprint(binding) !== row.generation) {
        throw new Error(`The representative state holds an invalid binding row for ${worktree}`);
    }
    return { binding, generation: row.generation, origin: row.origin };
}
/** Refuse unless `binding`'s generation is the worktree's CURRENT one (inside the same transaction). */
export function requireCurrentGeneration(db, binding) {
    const generation = bindingFingerprint(binding);
    const current = currentBindingRow(db, binding.worktree);
    if (!current || current.generation !== generation)
        throw new RepresentativeGenerationError();
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
export function insertBindingRow(db, binding, seat, origin) {
    const generation = bindingFingerprint(binding);
    const holder = db.prepare('SELECT worktree FROM bindings WHERE generation = ?').get(generation);
    if (holder && holder.worktree !== binding.worktree) {
        throw new RepresentativeStoreError('BINDING_CONFLICT', `Representative drone ${binding.representativeLabel} is already bound to Coordinator ${binding.coordinatorLabel} in worktree ` +
            `${holder.worktree} with the same binding generation. Prepare this worktree with its own representative seat.`);
    }
    db.prepare('INSERT INTO bindings (worktree, generation, seat, origin, binding) VALUES (?, ?, ?, ?, ?)')
        .run(binding.worktree, generation, seat, origin, JSON.stringify(binding));
}
function loadRequests(db, generation) {
    const rows = db.prepare('SELECT record FROM requests WHERE generation = ? ORDER BY seq').all(generation);
    return rows.map((row) => {
        const record = JSON.parse(row.record);
        if (!validRequest(record))
            throw new Error('The representative state holds an invalid request record');
        return record;
    });
}
function storeRequests(db, generation, records) {
    db.prepare('DELETE FROM requests WHERE generation = ?').run(generation);
    const insert = db.prepare('INSERT INTO requests (generation, seq, request_id, record) VALUES (?, ?, ?, ?)');
    records.forEach((record, index) => insert.run(generation, index, record.requestId, JSON.stringify(record)));
}
export function createRepresentativeStore(overrides = {}) {
    const deps = {
        state: overrides.state ?? createRepresentativeState(),
        readLegacyBinding: overrides.readLegacyBinding ?? readLegacyBinding,
        readLegacyBindings: overrides.readLegacyBindings ?? readLegacyBindings,
        seatKey: overrides.seatKey ?? seatKey,
    };
    const readRow = async (worktree) => deps.state.readOnly((db) => currentBindingRow(db, worktree)?.binding ?? null);
    return {
        state: deps.state,
        getBinding: async (worktree) => (await readRow(worktree)) ?? deps.readLegacyBinding(worktree),
        listBindings: async () => {
            const rows = await deps.state.readOnly((db) => db.prepare('SELECT worktree FROM bindings').all()
                .map((row) => currentBindingRow(db, row.worktree).binding)) ?? [];
            const known = new Set(rows.map((binding) => binding.worktree));
            return [...rows, ...(await deps.readLegacyBindings()).filter((binding) => !known.has(binding.worktree))];
        },
        readRequests: async (worktree) => (await deps.state.readOnly((db) => {
            const current = currentBindingRow(db, worktree);
            return current ? loadRequests(db, current.generation) : [];
        })) ?? [],
        saveBinding: async (binding, options) => {
            if (!validBinding(binding, binding.worktree)) {
                throw new Error('Refusing to save an invalid representative binding');
            }
            // The 5.x binding is the existing selection only while no 6.x row exists.
            const legacy = await deps.readLegacyBinding(binding.worktree);
            return deps.state.transact((db) => {
                const row = currentBindingRow(db, binding.worktree);
                const existing = row?.binding ?? legacy;
                // An explicit rebind always starts a new generation (new boundAt, so a new
                // binding_fingerprint), even for the same selection.
                if (existing && sameSelection(existing, binding) && !options.rebind) {
                    if (!row)
                        insertBindingRow(db, existing, deps.seatKey(existing), legacy === existing ? 'legacy' : 'prepared');
                    return 'unchanged';
                }
                if (existing && !options.rebind) {
                    throw new RepresentativeStoreError('BINDING_CONFLICT', `This worktree is already bound to Coordinator ${existing.coordinatorLabel} in cube ${existing.cubeName}. ` +
                        `To confirm the new selection, run \`${representativeRecoveryCommand(binding)}\`.`);
                }
                const carried = row && sameSelection(row.binding, binding) ? loadRequests(db, row.generation) : [];
                db.prepare('DELETE FROM bindings WHERE worktree = ?').run(binding.worktree);
                insertBindingRow(db, binding, deps.seatKey(binding), 'prepared');
                // The same selection keeps its ledger (so unresolved sends keep blocking
                // identical content); a different selection starts with none.
                if (carried.length > 0)
                    storeRequests(db, bindingFingerprint(binding), carried);
                return existing ? 'rebound' : 'created';
            });
        },
        transactRequests: (binding, op, options = {}) => deps.state.transact((db) => {
            let generation;
            try {
                generation = requireCurrentGeneration(db, binding);
            }
            catch (error) {
                if (options.onStale === 'skip' && error instanceof RepresentativeGenerationError)
                    return undefined;
                throw error;
            }
            const records = loadRequests(db, generation);
            const before = JSON.stringify(records);
            const result = op(records);
            const next = pruneSettled(records);
            if (JSON.stringify(next) !== before)
                storeRequests(db, generation, next);
            return result;
        }),
    };
}
//# sourceMappingURL=representative-store.js.map