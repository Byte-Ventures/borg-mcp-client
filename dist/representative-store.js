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
import { join } from 'node:path';
import { borgConfigRoot } from './private-root.js';
import { shellEscape } from './shell-escape.js';
import { withStore } from './seat-store.js';
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
function parseFile(raw) {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || parsed.version !== 1 ||
        parsed.bindings === null || typeof parsed.bindings !== 'object' || Array.isArray(parsed.bindings) ||
        parsed.requests === null || typeof parsed.requests !== 'object' || Array.isArray(parsed.requests))
        return null;
    for (const [key, binding] of Object.entries(parsed.bindings)) {
        if (!validBinding(binding, key))
            return null;
    }
    for (const records of Object.values(parsed.requests)) {
        if (!Array.isArray(records) || !records.every(validRequest))
            return null;
    }
    return parsed;
}
const emptyFile = () => ({ version: 1, bindings: {}, requests: {} });
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
export function representativeStorePath() {
    return join(borgConfigRoot(), 'representative.json');
}
export function createRepresentativeStore(storePath = representativeStorePath()) {
    return {
        getBinding: (worktree) => withStore(storePath, emptyFile, parseFile, async (txn) => txn.data.bindings[worktree] ?? null),
        saveBinding: (binding, options) => withStore(storePath, emptyFile, parseFile, async (txn) => {
            if (!validBinding(binding, binding.worktree)) {
                throw new Error('Refusing to save an invalid representative binding');
            }
            const existing = txn.data.bindings[binding.worktree];
            if (existing && sameSelection(existing, binding))
                return 'unchanged';
            if (existing && !options.rebind) {
                throw new RepresentativeStoreError('BINDING_CONFLICT', `This worktree is already bound to Coordinator ${existing.coordinatorLabel} in cube ${existing.cubeName}. ` +
                    `To confirm the new selection, run \`${representativeRecoveryCommand(binding)}\`.`);
            }
            txn.data.bindings[binding.worktree] = binding;
            // A different selection invalidates the old ledger: its post ids belong to
            // another cube/Coordinator conversation.
            if (existing)
                delete txn.data.requests[binding.worktree];
            await txn.commit();
            return existing ? 'rebound' : 'created';
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
//# sourceMappingURL=representative-store.js.map