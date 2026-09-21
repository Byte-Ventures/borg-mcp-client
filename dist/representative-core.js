/**
 * Human representative core ("Hermes"): a SEPARATE, non-human-seat drone that
 * relays the human's requests, questions and decisions to ONE explicitly bound
 * Coordinator drone and reads that Coordinator's replies.
 *
 * It is not the Coordinator and carries none of its playbook: it cannot address
 * workers, broadcast, or manage the cube. Every message is attributed as an
 * automated relay and states whether the content is user-authorized or the
 * model's own advice. Borg does not verify that claim — it is delegate
 * messaging, not server-enforced per-message human authority.
 *
 * The backend is injected so the same logic runs against the real seat-scoped
 * client (`createSeatBackend`) or a controlled test double.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ErrorCode, ProtocolContractError, decodeAppendLogRequest } from 'borgmcp-shared/protocol';
import { CUBE_DELETED_CODE, CubeDeletedError, DRONE_EVICTED_CODE, DroneEvictedError } from './drone-lifecycle.js';
import { BorgProtocolMismatchError, BorgServerError, BorgServerHttpError, BorgServerTrustError, BorgServerUnreachableError, } from './server-errors.js';
import { representativeRecoveryCommand, isRepresentativeUuid } from './representative-store.js';
const UUID_SCAN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const REPRESENTATIVE_MESSAGE_LIMIT_BYTES = 3000;
export const REPRESENTATIVE_DELIVERY_NOTE = 'Explicit send/read round trips only: this connection has no background wake or push delivery. ' +
    'Coordinator replies are seen only when borg_representative-read is called. Each read consumes the unread view of ' +
    'everything it fetched. The host must persist each read result before relaying it, map request_id to its conversation, ' +
    'route replies by in_reply_to, and hold replies with an unknown or missing request_id for the human. An already-read ' +
    'reply cannot be retrieved through this connection. The first send/read/ack takes an exclusive process lease for this ' +
    'representative drone; other processes refuse those calls without ledger, cursor or network activity. Status stays ' +
    'read-only and reports ownership. After owner exit, death or lease expiry another process can take over. ' +
    'A process that loses its lease refuses further calls until restarted. Ownership does not route conversations inside the host.';
export class RepresentativeError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'RepresentativeError';
    }
}
/** Real backend: the existing seat-scoped client calls for one hydrated seat. */
export async function createSeatBackend(active) {
    const client = await import('./remote-client.js');
    const trust = active.serverTrustIdentity;
    return {
        whoami: () => client.whoami(active),
        roster: () => client.getRoster(active),
        append: ({ postId, message, to }) => client.appendLog(active.sessionToken, active.apiUrl, message, {
            to, postId, transportRetry: false, serverTrustIdentity: trust,
        }),
        readUnread: (limit) => client.readLog(active.sessionToken, active.apiUrl, { unreadOnly: true, limit, serverTrustIdentity: trust }),
        readEntry: (entryId) => client.readLogEntry(active.sessionToken, active.apiUrl, { entry_id: entryId }, trust),
        ack: (entryId) => client.ackLogEntry(active.sessionToken, active.apiUrl, entryId, 'ack', trust),
    };
}
export function assertRepresentativeRole(role, drone) {
    if (role.is_human_seat === true || role.role_class === 'queen' || drone?.is_queen_class === true) {
        throw new RepresentativeError('REPRESENTATIVE_ROLE_NOT_PERMITTED', `Role ${JSON.stringify(role.name)} is a human-seat or coordinating role. The human representative must hold its own ` +
            'separate non-human-seat worker role and never occupies or replaces the Coordinator.');
    }
}
/**
 * Resolve the ONE Coordinator drone the operator named. Exact label match only;
 * a missing, duplicated, non-human-seat or self target fails — no fallback.
 */
export function resolveCoordinator(roster, selector) {
    const matches = roster.drones.filter((drone) => drone.label === selector.label);
    if (matches.length === 0) {
        throw new RepresentativeError('COORDINATOR_NOT_FOUND', `No active drone labelled ${JSON.stringify(selector.label)} exists in this cube (missing or evicted). No other drone was selected.`);
    }
    if (matches.length > 1) {
        throw new RepresentativeError('COORDINATOR_AMBIGUOUS', `${matches.length} active drones are labelled ${JSON.stringify(selector.label)}; refusing to choose between them.`);
    }
    const drone = matches[0];
    if (drone.id === selector.selfDroneId) {
        throw new RepresentativeError('COORDINATOR_IS_SELF', 'The representative drone cannot be its own Coordinator.');
    }
    const role = roster.roles.find((candidate) => candidate.id === drone.role_id);
    if (!role || role.is_human_seat !== true) {
        throw new RepresentativeError('COORDINATOR_NOT_HUMAN_SEAT', `Drone ${JSON.stringify(selector.label)} does not hold the cube's human-seat (Coordinator) role. ` +
            'The representative talks only to the Coordinator, never directly to workers.');
    }
    return { drone, role };
}
/** Re-prove, against the live cube, that this seat and the bound Coordinator are still the bound ones. */
async function verifyLiveBinding(ctx) {
    const { binding, backend } = ctx;
    const me = await backend.whoami();
    if (me.cube_id !== binding.cubeId || me.drone_id !== binding.representativeDroneId) {
        throw new RepresentativeError('BINDING_MISMATCH', `The live connection is not the bound cube/drone. Run \`${representativeRecoveryCommand(binding)}\` explicitly; nothing was sent.`);
    }
    const roster = await backend.roster();
    const self = roster.drones.find((drone) => drone.id === binding.representativeDroneId);
    const selfRole = roster.roles.find((role) => role.id === self?.role_id);
    if (!self || !selfRole) {
        throw new RepresentativeError('SEAT_UNAVAILABLE', 'The representative drone is no longer active in the cube.');
    }
    assertRepresentativeRole(selfRole, self);
    const coordinator = roster.drones.find((drone) => drone.id === binding.coordinatorDroneId);
    const coordinatorRole = roster.roles.find((role) => role.id === coordinator?.role_id);
    if (!coordinator || coordinatorRole?.is_human_seat !== true) {
        throw new RepresentativeError('COORDINATOR_UNAVAILABLE', `The bound Coordinator ${JSON.stringify(binding.coordinatorLabel)} is no longer an active human-seat drone in this cube ` +
            `(evicted, released or reassigned). Restore that Coordinator before running \`${representativeRecoveryCommand(binding)}\`, or explicitly select a replacement Coordinator; no other drone was selected.`);
    }
    return { coordinator, self };
}
const SEND_FIELDS = new Set(['request_id', 'kind', 'authorization', 'message']);
function validateSendInput(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'Arguments must be an object.');
    }
    const input = raw;
    const unknown = Object.keys(input).filter((key) => !SEND_FIELDS.has(key) && input[key] !== undefined);
    if (unknown.length > 0) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, `Unsupported field(s): ${unknown.join(', ')}. The recipient is fixed to the bound Coordinator; ` +
            'this connection cannot address workers, broadcast, or classify messages.');
    }
    if (input.kind !== 'request' && input.kind !== 'question' && input.kind !== 'decision') {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'kind must be "request", "question" or "decision".');
    }
    if (input.authorization !== 'user_authorized' && input.authorization !== 'model_advice') {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'authorization must be "user_authorized" or "model_advice".');
    }
    if (typeof input.message !== 'string' || input.message.trim() === '') {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'message must be a non-empty string.');
    }
    if (Buffer.byteLength(input.message, 'utf8') > REPRESENTATIVE_MESSAGE_LIMIT_BYTES) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, `message exceeds ${REPRESENTATIVE_MESSAGE_LIMIT_BYTES} bytes.`);
    }
    if (input.request_id !== undefined && input.request_id !== null &&
        (typeof input.request_id !== 'string' || !isRepresentativeUuid(input.request_id))) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'request_id must be a UUID previously returned by this tool, or omitted.');
    }
    if (input.kind === 'decision' && input.authorization !== 'user_authorized') {
        throw new RepresentativeError('DECISION_REQUIRES_USER_AUTHORIZATION', 'A decision can only be relayed when the human explicitly authorized it. Send model suggestions as a question or request marked model_advice.');
    }
    return {
        kind: input.kind,
        authorization: input.authorization,
        message: input.message,
        ...(typeof input.request_id === 'string' ? { request_id: input.request_id.toLowerCase() } : {}),
    };
}
const AUTHORIZATION_LINES = {
    user_authorized: 'authorization: user-authorized — the representative asserts the human explicitly authorized the text below. ' +
        'This is not verified by Borg and authorizes nothing beyond that text.',
    model_advice: 'authorization: model-advice — the representative model\'s own suggestion. NOT a human decision or approval.',
};
export function formatRepresentativeMessage(binding, requestId, input) {
    return [
        `[HUMAN-REPRESENTATIVE · automated relay via ${binding.representativeLabel} · not typed by the human]`,
        `request_id: ${requestId}`,
        `kind: ${input.kind}`,
        AUTHORIZATION_LINES[input.authorization],
        `reply: direct to ${binding.representativeLabel}, quoting the request_id.`,
        '---',
        input.message,
    ].join('\n');
}
function payloadDigest(binding, input) {
    return createHash('sha256')
        .update([binding.cubeId, binding.coordinatorDroneId, input.kind, input.authorization, input.message].join('\0'))
        .digest('hex');
}
function boundedMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 300);
}
const SAME_ID_RETRY = 'Nothing was re-sent automatically. Retry ONLY by calling borg_representative-send again with the same request_id and ' +
    'identical content: the server deduplicates on that id (protocol post_id), so that retry cannot create a second ' +
    'message. Never re-send this content under a different request_id while it is unresolved.';
/**
 * Classify one failed append. "Definite" is claimed ONLY for a typed refusal
 * the server returned to the single transport attempt the backend contract
 * allows — that attempt was answered instead of stored. Everything else
 * (no answer, 5xx, an unreadable or contract-violating response, a trust
 * failure of unknown timing, anything unrecognised) may follow a committed
 * write and stays ambiguous, but keeps its cause and a matching recovery.
 */
function classifyAppendFailure(error, binding) {
    const message = boundedMessage(error);
    const prepareRecovery = `The operator must restore this connection: run \`${representativeRecoveryCommand(binding)}\`, then restart the MCP process.`;
    if (error instanceof BorgServerError &&
        (error.code === ErrorCode.SESSION_REJECTED || error.code === ErrorCode.SESSION_REVOKED || error.code === 'CREDENTIAL_REJECTED')) {
        return { definite: true, cause: { code: error.code, message }, recovery: prepareRecovery };
    }
    if (error instanceof DroneEvictedError || error instanceof CubeDeletedError) {
        return {
            definite: true,
            cause: { code: error instanceof DroneEvictedError ? DRONE_EVICTED_CODE : CUBE_DELETED_CODE, message },
            recovery: prepareRecovery,
        };
    }
    if (error instanceof BorgServerHttpError) {
        const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : `HTTP_${error.status}`;
        if (error.status >= 400 && error.status < 500) {
            const recovery = error.status === 429
                ? 'The server is rate limiting this drone. Wait, then retry with the same request_id and identical content.'
                : error.status === 409
                    ? 'The server already holds a DIFFERENT message under this request_id. Do not resend; ask the operator to inspect the cube log.'
                    : error.status === 401 || error.status === 403
                        ? `The server denied this drone. ${prepareRecovery}`
                        : 'The server refused this content. Correct it and send it as a new request, or ask the operator.';
            return { definite: true, cause: { code, message }, recovery };
        }
        return {
            definite: false,
            cause: { code, message },
            recovery: 'The server reported an internal error and may or may not have stored the message. Check the server, then retry.',
        };
    }
    if (error instanceof BorgServerUnreachableError) {
        return {
            definite: false,
            cause: { code: 'SERVER_UNREACHABLE', message },
            recovery: 'The server did not answer in time; the request may still have arrived. Check that the Borg server is running, then retry.',
        };
    }
    if (error instanceof BorgProtocolMismatchError || error instanceof ProtocolContractError) {
        return {
            definite: false,
            cause: { code: error instanceof BorgProtocolMismatchError ? 'PROTOCOL_MISMATCH' : 'PROTOCOL_CONTRACT', message },
            recovery: 'The server\'s response could not be read, which can happen AFTER it stored the message. The operator should ' +
                'check that client and server versions match (`borg update`), then retry.',
        };
    }
    if (error instanceof BorgServerTrustError) {
        return {
            definite: false,
            cause: { code: 'SERVER_TRUST', message },
            recovery: 'The server\'s pinned TLS identity could not be confirmed. The operator must verify the server before any retry.',
        };
    }
    return {
        definite: false,
        cause: { code: 'UNKNOWN', message },
        recovery: 'An unrecognised failure interrupted the send. Check `borg representative status`, then retry.',
    };
}
export async function sendRepresentativeMessage(ctx, raw) {
    const input = validateSendInput(raw);
    const { binding, store } = ctx;
    const now = () => (ctx.now?.() ?? new Date()).toISOString();
    const digest = payloadDigest(binding, input);
    const coordinatorRef = { drone_id: binding.coordinatorDroneId, label: binding.coordinatorLabel };
    // Everything predictable is decided locally BEFORE anything is reserved, so
    // invalid input can never leave a record behind.
    const candidateId = input.request_id ?? randomUUID();
    const message = formatRepresentativeMessage(binding, candidateId, input);
    try {
        decodeAppendLogRequest({ post_id: candidateId, message, to: [binding.coordinatorDroneId] });
    }
    catch (error) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, `The message cannot be sent as written: ${boundedMessage(error)}`);
    }
    // ONE locked transaction: look up, decide conflicts, allocate the id and
    // reserve it as 'pending'. No await separates the check from the reservation,
    // so overlapping calls cannot both conclude "nothing is in flight".
    const reservation = await store.transactRequests(binding.worktree, (records) => {
        const record = input.request_id
            ? records.find((candidate) => candidate.requestId === input.request_id)
            : undefined;
        if (record && record.payloadDigest !== digest) {
            throw new RepresentativeError('REQUEST_ID_CONFLICT', 'This request_id was already used for different content. Use a new request for new content.');
        }
        if (record?.state === 'sent')
            return { kind: 'already-sent', entryId: record.entryId };
        if (!record || record.state === 'rejected') {
            const unresolved = records.find((candidate) => candidate.payloadDigest === digest &&
                (candidate.state === 'ambiguous' || candidate.state === 'pending') &&
                candidate.requestId !== candidateId);
            if (unresolved) {
                throw new RepresentativeError('AMBIGUOUS_SEND_UNRESOLVED', `Identical content already has an in-flight or unresolved send under request_id ${unresolved.requestId}. ` +
                    'Wait for that call, then retry with that request_id instead of creating a new one.');
            }
        }
        const stamp = now();
        if (record) {
            const prior = record.state;
            // An earlier attempt under this id may have reached the log; remember it
            // so a later definite refusal cannot mark the request as never stored.
            if (prior === 'pending' || prior === 'ambiguous')
                record.maybeStored = true;
            record.state = 'pending';
            record.updatedAt = stamp;
            return { kind: 'reserved', prior };
        }
        records.push({
            requestId: candidateId, payloadDigest: digest, kind: input.kind, authorization: input.authorization,
            state: 'pending', createdAt: stamp, updatedAt: stamp,
        });
        return { kind: 'reserved', prior: null };
    });
    const requestId = candidateId;
    if (reservation.kind === 'already-sent') {
        return {
            outcome: 'sent', request_id: requestId, entry_id: reservation.entryId,
            duplicate: true, deduplicated: true, coordinator: coordinatorRef,
        };
    }
    // Settling is monotonic so overlapping same-id calls converge: 'sent' is
    // terminal, and a definite refusal never hides an attempt that may be stored.
    const settle = (state, entryId) => store.transactRequests(binding.worktree, (records) => {
        const stamp = now();
        let record = records.find((candidate) => candidate.requestId === requestId);
        if (!record) {
            record = {
                requestId, payloadDigest: digest, kind: input.kind, authorization: input.authorization,
                state, createdAt: stamp, updatedAt: stamp,
            };
            records.push(record);
        }
        if (record.state === 'sent')
            return record.state;
        if (state === 'ambiguous')
            record.maybeStored = true;
        record.state = state === 'rejected' && record.maybeStored ? 'ambiguous' : state;
        record.updatedAt = stamp;
        if (state === 'sent') {
            record.entryId = entryId;
            delete record.maybeStored;
        }
        return record.state;
    });
    // Live verification happens before any posting. Nothing was sent if it fails,
    // so this call's reservation is released (an older unresolved state is kept).
    // Only a genuinely sole, never-posted reservation may be released: once the
    // record is marked maybeStored, another attempt under this id has reserved it
    // (and may be appending right now), so it stays unresolved and keeps blocking
    // identical content under a new id until a same-id attempt settles it.
    try {
        await verifyLiveBinding(ctx);
    }
    catch (error) {
        await store.transactRequests(binding.worktree, (records) => {
            const index = records.findIndex((candidate) => candidate.requestId === requestId);
            if (index < 0 || records[index].state !== 'pending')
                return;
            if (records[index].maybeStored) {
                // Never deleted, never marked settled: at most back to its earlier unresolved 'ambiguous'.
                if (reservation.prior === 'ambiguous')
                    records[index].state = 'ambiguous';
                return;
            }
            if (reservation.prior === null)
                records.splice(index, 1);
            else
                records[index].state = reservation.prior;
        });
        throw error;
    }
    let result;
    try {
        result = await ctx.backend.append({ postId: requestId, message, to: [binding.coordinatorDroneId] });
    }
    catch (error) {
        const failure = classifyAppendFailure(error, binding);
        if (failure.definite) {
            const recorded = await settle('rejected');
            throw new RepresentativeError('SEND_REJECTED', `The Borg server refused this attempt (${failure.cause.code}); it was not stored by this attempt. ${failure.recovery}` +
                (recorded === 'ambiguous'
                    ? ' An EARLIER attempt under this request_id is still unresolved, so the request stays listed as unresolved.'
                    : ''), { request_id: requestId, cause_code: failure.cause.code, cause_message: failure.cause.message, recovery: failure.recovery });
        }
        await settle('ambiguous');
        return {
            outcome: 'ambiguous',
            request_id: requestId,
            coordinator: coordinatorRef,
            cause: failure.cause,
            guidance: `The outcome is unknown (${failure.cause.code}). ${failure.recovery} ${SAME_ID_RETRY}`,
        };
    }
    await settle('sent', result.entry.id);
    const recipients = result.entry.recipient_drone_ids ?? [];
    const warnings = [];
    if (result.entry.visibility !== 'direct' || recipients.length !== 1 || recipients[0] !== binding.coordinatorDroneId) {
        warnings.push('The server\'s routing echo does not show exactly the bound Coordinator as the direct recipient.');
    }
    if (result.unreachableRecipients?.some((recipient) => recipient.id === binding.coordinatorDroneId)) {
        warnings.push('The server reports the Coordinator as currently unreachable; it will see the entry when it next reads its log.');
    }
    return {
        outcome: 'sent',
        request_id: requestId,
        entry_id: result.entry.id,
        deduplicated: result.deduplicated,
        duplicate: false,
        coordinator: coordinatorRef,
        ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
    };
}
function isAddressedCoordinatorEntry(binding, entry) {
    if (entry.drone_id !== binding.coordinatorDroneId)
        return null;
    if (entry.visibility === 'direct') {
        return (entry.recipient_drone_ids ?? []).includes(binding.representativeDroneId) ? 'direct' : null;
    }
    return 'broadcast';
}
export async function readRepresentativeReplies(ctx, raw) {
    const input = (raw ?? {});
    const unknown = Object.keys(input).filter((key) => key !== 'include_broadcast' && key !== 'limit' && input[key] !== undefined);
    if (unknown.length > 0)
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, `Unsupported field(s): ${unknown.join(', ')}.`);
    if (input.include_broadcast !== undefined && typeof input.include_broadcast !== 'boolean') {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'include_broadcast must be a boolean.');
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'limit must be an integer from 1 to 200.');
    }
    await verifyLiveBinding(ctx);
    const page = await ctx.backend.readUnread(input.limit);
    const requestIds = await ctx.store.transactRequests(ctx.binding.worktree, (records) => new Set(records.map((record) => record.requestId)));
    const replies = [];
    for (const entry of page.entries) {
        const addressed = isAddressedCoordinatorEntry(ctx.binding, entry);
        if (addressed === null || (addressed === 'broadcast' && input.include_broadcast !== true))
            continue;
        const quoted = (entry.message.match(UUID_SCAN_RE) ?? []).map((id) => id.toLowerCase());
        replies.push({
            entry_id: entry.id,
            created_at: entry.created_at,
            from_drone_id: ctx.binding.coordinatorDroneId,
            from_label: ctx.binding.coordinatorLabel,
            addressed,
            in_reply_to: quoted.find((id) => requestIds.has(id)) ?? null,
            message: entry.message,
            ...(entry.documents?.length ? {
                documents: entry.documents,
                document_delivery: 'Document bodies are not included and cannot be fetched through this connection. Ask the Coordinator to provide the content through a supported channel.',
            } : {}),
        });
    }
    return {
        replies,
        ignored_entries: page.entries.length - replies.length,
        has_more: page.has_more === true,
        delivery: REPRESENTATIVE_DELIVERY_NOTE,
    };
}
export async function ackRepresentativeReply(ctx, raw) {
    const input = (raw ?? {});
    const unknown = Object.keys(input).filter((key) => key !== 'entry_id');
    if (unknown.length > 0 || typeof input.entry_id !== 'string' || !isRepresentativeUuid(input.entry_id)) {
        throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'entry_id must be the full UUID of a reply returned by borg_representative-read.');
    }
    await verifyLiveBinding(ctx);
    const { entry } = await ctx.backend.readEntry(input.entry_id);
    if (entry.id !== input.entry_id || isAddressedCoordinatorEntry(ctx.binding, entry) !== 'direct') {
        throw new RepresentativeError('NOT_A_COORDINATOR_REPLY', 'Only a direct reply from the bound Coordinator to this representative can be acknowledged here.');
    }
    await ctx.backend.ack(entry.id);
    return { acknowledged: entry.id };
}
export async function representativeStatus(ctx) {
    const { binding } = ctx;
    let problem;
    try {
        await verifyLiveBinding(ctx);
    }
    catch (error) {
        problem = {
            code: error instanceof RepresentativeError ? error.code : 'BACKEND_ERROR',
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
    const unresolved = (await ctx.store.readRequests(binding.worktree))
        .filter((record) => record.state === 'pending' || record.state === 'ambiguous')
        .map((record) => ({
        request_id: record.requestId, state: record.state, kind: record.kind, updated_at: record.updatedAt,
    }));
    return {
        role: 'Human representative — an automated delegate speaking for the human. It is not the human and not the Coordinator.',
        connected: problem === undefined,
        ...(problem ? { problem } : {}),
        cube: { id: binding.cubeId, name: binding.cubeName },
        repository_origin: binding.repositoryOrigin ?? null,
        worktree: binding.worktree,
        representative: {
            drone_id: binding.representativeDroneId, label: binding.representativeLabel, role: binding.representativeRoleName,
        },
        coordinator: {
            drone_id: binding.coordinatorDroneId, label: binding.coordinatorLabel, role: binding.coordinatorRoleName,
        },
        unresolved_requests: unresolved,
        delivery: REPRESENTATIVE_DELIVERY_NOTE,
        authority: 'Borg records these messages as posts from the representative drone. The user-authorized / model-advice label is this ' +
            'connection\'s own attribution and is not verified or enforced by the Borg server.',
    };
}
//# sourceMappingURL=representative-core.js.map