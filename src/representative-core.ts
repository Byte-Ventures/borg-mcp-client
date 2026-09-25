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
import { ErrorCode, ProtocolContractError, decodeAppendLogRequest, type Role, type RosterDrone as ProtocolDrone, type EnrichedStreamEntry, type DocumentCitation } from 'borgmcp-shared/protocol';
import type { ActiveCube } from './cubes.js';
import { CUBE_DELETED_CODE, CubeDeletedError, DRONE_EVICTED_CODE, DroneEvictedError } from './drone-lifecycle.js';
import {
  BorgProtocolMismatchError,
  BorgServerError,
  BorgServerHttpError,
  BorgServerTrustError,
  BorgServerUnreachableError,
} from './server-errors.js';
import { bindingFingerprint, representativeRecoveryCommand, isRepresentativeUuid, type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
import { comparePoints, createDeliveryStore, type DeliveryState } from './representative-delivery-store.js';
import { readPrivateLocalServerCursor, type LocalServerCursor } from './local-server-cursor.js';
import { validatePrivateDirectory } from './representative-listener-store.js';
import { borgConfigRoot } from './private-root.js';

const UUID_SCAN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const REPRESENTATIVE_MESSAGE_LIMIT_BYTES = 3000;

export const REPRESENTATIVE_DELIVERY_NOTE =
  'read returns undelivered replies without consuming them; persist, route by in_reply_to (unknown: hold for the ' +
  'human), then deliver through the last persisted entry_id. ack only notifies the Coordinator. A separate ' +
  'borg representative listen process emits body-free wake hints. One process at a time owns send/read/deliver/ack; ' +
  'status is read-only. Stop routing if binding_fingerprint changes.';

export type RepresentativeErrorCode =
  | typeof ErrorCode.INVALID_INPUT
  | 'DECISION_REQUIRES_USER_AUTHORIZATION'
  | 'REQUEST_ID_CONFLICT'
  | 'AMBIGUOUS_SEND_UNRESOLVED'
  | 'SEND_REJECTED'
  | 'REPRESENTATIVE_OWNERSHIP_REQUIRED'
  | 'NOT_PREPARED'
  | 'SEAT_UNAVAILABLE'
  | 'BINDING_MISMATCH'
  | 'BINDING_CONFLICT'
  | 'COORDINATOR_NOT_FOUND'
  | 'COORDINATOR_AMBIGUOUS'
  | 'COORDINATOR_NOT_HUMAN_SEAT'
  | 'COORDINATOR_IS_SELF'
  | 'COORDINATOR_UNAVAILABLE'
  | 'REPRESENTATIVE_ROLE_NOT_PERMITTED'
  | 'REPRESENTATIVE_ROLE_MISMATCH'
  | 'NOT_A_COORDINATOR_REPLY'
  | 'REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY';

export interface RepresentativeErrorDetails {
  owner?: import('./stream-owner.js').StreamOwnershipSnapshot;
  request_id?: string;
  cause_code?: string;
  cause_message?: string;
  recovery?: string;
}

export class RepresentativeError extends Error {
  constructor(
    readonly code: RepresentativeErrorCode,
    message: string,
    readonly details?: RepresentativeErrorDetails,
  ) {
    super(message);
    this.name = 'RepresentativeError';
  }
}

type RosterRole = Pick<Role, 'id' | 'name' | 'is_human_seat' | 'role_class'>;
type RosterDrone = Pick<ProtocolDrone, 'id' | 'label' | 'role_id' | 'is_queen_class'>;
type LogEntry = Pick<EnrichedStreamEntry, 'id' | 'drone_id' | 'message' | 'visibility' | 'created_at' | 'recipient_drone_ids' | 'documents'>;

/** The only Borg operations the representative may perform, all seat-scoped. */
export interface RepresentativeBackend {
  whoami(): Promise<{ cube_id: string; cube_name: string; drone_id: string; drone_label: string; role_id: string; role_name: string }>;
  roster(): Promise<{ drones: RosterDrone[]; roles: RosterRole[] }>;
  /**
   * MUST make a single transport attempt and surface the client's typed errors
   * unchanged: a typed 4xx/401/410 refusal is reported as "not stored" only
   * because no hidden retry can sit between a committed write and that answer.
   */
  append(input: { postId: string; message: string; to: string[] }): Promise<{
    entry: LogEntry;
    deduplicated: boolean;
    unreachableRecipients?: Array<{ id: string; label: string }>;
  }>;
  /**
   * One stateless page of the cube log strictly after an exact (created_at, id)
   * cursor, ascending. Reads and advances no unread cursor; never digest mode.
   */
  readAfter(cursor: LocalServerCursor | null, limit: number, continuationGuard?: () => Promise<void>): Promise<{ entries: LogEntry[]; has_more?: boolean }>;
  /** This seat's client-owned unread cursor, read only; the slice 2 migration input. */
  unreadCursor(): Promise<LocalServerCursor | null>;
  readEntry(entryId: string): Promise<{ entry: LogEntry }>;
  ack(entryId: string): Promise<void>;
}

export interface RepresentativeContext {
  binding: RepresentativeBinding;
  backend: RepresentativeBackend;
  store: RepresentativeStore;
  now?: () => Date;
  /** Checked immediately before each private delivery-state write (the tools lease in MCP). */
  guard?: () => Promise<void>;
}

/** Real backend: the existing seat-scoped client calls for one hydrated seat. */
export async function createSeatBackend(active: ActiveCube): Promise<RepresentativeBackend> {
  const client = await import('./remote-client.js');
  const trust = active.serverTrustIdentity;
  return {
    whoami: () => client.whoami(active),
    roster: () => client.getRoster(active),
    append: ({ postId, message, to }) =>
      client.appendLog(active.sessionToken, active.apiUrl, message, {
        to, postId, transportRetry: false, serverTrustIdentity: trust,
      }),
    readAfter: (cursor, limit, continuationGuard) =>
      client.readLog(active.sessionToken, active.apiUrl, { cursor, limit, serverTrustIdentity: trust, continuationGuard }),
    // Migration input only: an unsafe private root or cursor file is no cursor,
    // so the checkpoint starts empty and replays instead of trusting it.
    unreadCursor: async () => {
      try {
        if (!await validatePrivateDirectory(borgConfigRoot(), false)) return null;
      } catch {
        return null;
      }
      return readPrivateLocalServerCursor({
        origin: active.apiUrl, trustIdentity: trust!, cubeId: active.cubeId, droneId: active.droneId,
      });
    },
    readEntry: (entryId) =>
      client.readLogEntry(active.sessionToken, active.apiUrl, { entry_id: entryId }, trust),
    ack: (entryId) => client.ackLogEntry(active.sessionToken, active.apiUrl, entryId, 'ack', trust),
  };
}

export function assertRepresentativeRole(
  role: { name: string; is_human_seat?: boolean; role_class?: string },
  drone?: { is_queen_class?: boolean },
): void {
  if (role.is_human_seat === true || role.role_class === 'queen' || drone?.is_queen_class === true) {
    throw new RepresentativeError(
      'REPRESENTATIVE_ROLE_NOT_PERMITTED',
      `Role ${JSON.stringify(role.name)} is a human-seat or coordinating role. The human representative must hold its own ` +
        'separate non-human-seat worker role and never occupies or replaces the Coordinator.',
    );
  }
}

/**
 * Resolve the ONE Coordinator drone the operator named. Exact label match only;
 * a missing, duplicated, non-human-seat or self target fails — no fallback.
 */
export function resolveCoordinator(
  roster: { drones: RosterDrone[]; roles: RosterRole[] },
  selector: { label: string; selfDroneId: string },
): { drone: RosterDrone; role: RosterRole } {
  const matches = roster.drones.filter((drone) => drone.label === selector.label);
  if (matches.length === 0) {
    throw new RepresentativeError(
      'COORDINATOR_NOT_FOUND',
      `No active drone labelled ${JSON.stringify(selector.label)} exists in this cube (missing or evicted). No other drone was selected.`,
    );
  }
  if (matches.length > 1) {
    throw new RepresentativeError(
      'COORDINATOR_AMBIGUOUS',
      `${matches.length} active drones are labelled ${JSON.stringify(selector.label)}; refusing to choose between them.`,
    );
  }
  const drone = matches[0];
  if (drone.id === selector.selfDroneId) {
    throw new RepresentativeError('COORDINATOR_IS_SELF', 'The representative drone cannot be its own Coordinator.');
  }
  const role = roster.roles.find((candidate) => candidate.id === drone.role_id);
  if (!role || role.is_human_seat !== true) {
    throw new RepresentativeError(
      'COORDINATOR_NOT_HUMAN_SEAT',
      `Drone ${JSON.stringify(selector.label)} does not hold the cube's human-seat (Coordinator) role. ` +
        'The representative talks only to the Coordinator, never directly to workers.',
    );
  }
  return { drone, role };
}

/** Re-prove, against the live cube, that this seat and the bound Coordinator are still the bound ones. */
export async function verifyLiveBinding(ctx: RepresentativeContext): Promise<{ coordinator: RosterDrone; self: RosterDrone }> {
  const { binding, backend } = ctx;
  const me = await backend.whoami();
  if (me.cube_id !== binding.cubeId || me.drone_id !== binding.representativeDroneId) {
    throw new RepresentativeError(
      'BINDING_MISMATCH',
      `The live connection is not the bound cube/drone. Run \`${representativeRecoveryCommand(binding)}\` explicitly; nothing was sent.`,
    );
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
    throw new RepresentativeError(
      'COORDINATOR_UNAVAILABLE',
      `The bound Coordinator ${JSON.stringify(binding.coordinatorLabel)} is no longer an active human-seat drone in this cube ` +
        `(evicted, released or reassigned). Restore that Coordinator before running \`${representativeRecoveryCommand(binding)}\`, or explicitly select a replacement Coordinator; no other drone was selected.`,
    );
  }
  return { coordinator, self };
}

export type RepresentativeKind = 'request' | 'question' | 'decision';
export type RepresentativeAuthorization = 'user_authorized' | 'model_advice';

export interface RepresentativeSendInput {
  request_id?: string;
  kind: RepresentativeKind;
  authorization: RepresentativeAuthorization;
  message: string;
}

export interface RepresentativeSendResult {
  outcome: 'sent' | 'ambiguous';
  request_id: string;
  entry_id?: string;
  /** True when the server recognised the post id and stored nothing new. */
  deduplicated?: boolean;
  /** True when the local ledger already held this exact sent request; no network call was made. */
  duplicate?: boolean;
  coordinator: { drone_id: string; label: string };
  warning?: string;
  /** Ambiguous only: the sanitized underlying failure. */
  cause?: SendFailureCause;
  guidance?: string;
}

const SEND_FIELDS = new Set(['request_id', 'kind', 'authorization', 'message']);

function validateSendInput(raw: unknown): RepresentativeSendInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'Arguments must be an object.');
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !SEND_FIELDS.has(key) && input[key] !== undefined);
  if (unknown.length > 0) {
    throw new RepresentativeError(
      ErrorCode.INVALID_INPUT,
      `Unsupported field(s): ${unknown.join(', ')}. The recipient is fixed to the bound Coordinator; ` +
        'this connection cannot address workers, broadcast, or classify messages.',
    );
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
    throw new RepresentativeError(
      'DECISION_REQUIRES_USER_AUTHORIZATION',
      'A decision can only be relayed when the human explicitly authorized it. Send model suggestions as a question or request marked model_advice.',
    );
  }
  return {
    kind: input.kind,
    authorization: input.authorization,
    message: input.message,
    ...(typeof input.request_id === 'string' ? { request_id: input.request_id.toLowerCase() } : {}),
  };
}

const AUTHORIZATION_LINES: Record<RepresentativeAuthorization, string> = {
  user_authorized:
    'authorization: user-authorized — the representative asserts the human explicitly authorized the text below. ' +
    'This is not verified by Borg and authorizes nothing beyond that text.',
  model_advice:
    'authorization: model-advice — the representative model\'s own suggestion. NOT a human decision or approval.',
};

export function formatRepresentativeMessage(
  binding: RepresentativeBinding,
  requestId: string,
  input: RepresentativeSendInput,
): string {
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

function payloadDigest(binding: RepresentativeBinding, input: RepresentativeSendInput): string {
  return createHash('sha256')
    .update([binding.cubeId, binding.coordinatorDroneId, input.kind, input.authorization, input.message].join('\0'))
    .digest('hex');
}

export interface SendFailureCause {
  /** Stable, bounded cause code — a typed server/protocol code where one exists. */
  code: string;
  /** Sanitized, bounded underlying message. Never a credential: client errors carry none. */
  message: string;
}

function boundedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 300);
}

const SAME_ID_RETRY =
  'Nothing was re-sent automatically. Retry ONLY by calling borg_representative-send again with the same request_id and ' +
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
function classifyAppendFailure(error: unknown, binding: RepresentativeBinding): { definite: boolean; cause: SendFailureCause; recovery: string } {
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
      recovery:
        'The server\'s response could not be read, which can happen AFTER it stored the message. The operator should ' +
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

export async function sendRepresentativeMessage(
  ctx: RepresentativeContext,
  raw: unknown,
): Promise<RepresentativeSendResult & { binding_fingerprint: string }> {
  return { ...await sendOnce(ctx, raw), binding_fingerprint: bindingFingerprint(ctx.binding) };
}

async function sendOnce(
  ctx: RepresentativeContext,
  raw: unknown,
): Promise<RepresentativeSendResult> {
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
  } catch (error) {
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
      throw new RepresentativeError(
        'REQUEST_ID_CONFLICT',
        'This request_id was already used for different content. Use a new request for new content.',
      );
    }
    if (record?.state === 'sent') return { kind: 'already-sent' as const, entryId: record.entryId };
    if (!record || record.state === 'rejected') {
      const unresolved = records.find((candidate) =>
        candidate.payloadDigest === digest &&
        (candidate.state === 'ambiguous' || candidate.state === 'pending') &&
        candidate.requestId !== candidateId);
      if (unresolved) {
        throw new RepresentativeError(
          'AMBIGUOUS_SEND_UNRESOLVED',
          `Identical content already has an in-flight or unresolved send under request_id ${unresolved.requestId}. ` +
            'Wait for that call, then retry with that request_id instead of creating a new one.',
        );
      }
    }
    const stamp = now();
    if (record) {
      const prior = record.state;
      // An earlier attempt under this id may have reached the log; remember it
      // so a later definite refusal cannot mark the request as never stored.
      if (prior === 'pending' || prior === 'ambiguous') record.maybeStored = true;
      record.state = 'pending';
      record.updatedAt = stamp;
      return { kind: 'reserved' as const, prior };
    }
    records.push({
      requestId: candidateId, payloadDigest: digest, kind: input.kind, authorization: input.authorization,
      state: 'pending', createdAt: stamp, updatedAt: stamp,
    });
    return { kind: 'reserved' as const, prior: null };
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
  const settle = (state: 'sent' | 'ambiguous' | 'rejected', entryId?: string) =>
    store.transactRequests(binding.worktree, (records) => {
      const stamp = now();
      let record = records.find((candidate) => candidate.requestId === requestId);
      if (!record) {
        record = {
          requestId, payloadDigest: digest, kind: input.kind, authorization: input.authorization,
          state, createdAt: stamp, updatedAt: stamp,
        };
        records.push(record);
      }
      if (record.state === 'sent') return record.state;
      if (state === 'ambiguous') record.maybeStored = true;
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
  } catch (error) {
    await store.transactRequests(binding.worktree, (records) => {
      const index = records.findIndex((candidate) => candidate.requestId === requestId);
      if (index < 0 || records[index].state !== 'pending') return;
      if (records[index].maybeStored) {
        // Never deleted, never marked settled: at most back to its earlier unresolved 'ambiguous'.
        if (reservation.prior === 'ambiguous') records[index].state = 'ambiguous';
        return;
      }
      if (reservation.prior === null) records.splice(index, 1);
      else records[index].state = reservation.prior;
    });
    throw error;
  }

  let result: Awaited<ReturnType<RepresentativeBackend['append']>>;
  try {
    result = await ctx.backend.append({ postId: requestId, message, to: [binding.coordinatorDroneId] });
  } catch (error) {
    const failure = classifyAppendFailure(error, binding);
    if (failure.definite) {
      const recorded = await settle('rejected');
      throw new RepresentativeError(
        'SEND_REJECTED',
        `The Borg server refused this attempt (${failure.cause.code}); it was not stored by this attempt. ${failure.recovery}` +
          (recorded === 'ambiguous'
            ? ' An EARLIER attempt under this request_id is still unresolved, so the request stays listed as unresolved.'
            : ''),
        { request_id: requestId, cause_code: failure.cause.code, cause_message: failure.cause.message, recovery: failure.recovery },
      );
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
  const warnings: string[] = [];
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

export interface RepresentativeReply {
  documents?: DocumentCitation[];
  document_delivery?: string;
  entry_id: string;
  created_at: string;
  from_drone_id: string;
  from_label: string;
  addressed: 'direct' | 'broadcast';
  /** A ledger request id quoted in the reply text. Textual correlation only. */
  in_reply_to: string | null;
  message: string;
  /** This entry alone exceeds max_bytes; it is returned whole and alone. */
  oversize?: true;
}

function isAddressedCoordinatorEntry(binding: RepresentativeBinding, entry: LogEntry): 'direct' | 'broadcast' | null {
  if (entry.drone_id !== binding.coordinatorDroneId) return null;
  if (entry.visibility === 'direct') {
    return (entry.recipient_drone_ids ?? []).includes(binding.representativeDroneId) ? 'direct' : null;
  }
  return 'broadcast';
}

/** The exact text an MCP tool result carries; `max_bytes` measures this. */
export function serializeRepresentativeResult(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

const READ_SCAN_PAGE = 500;

async function deliveryState(ctx: RepresentativeContext): Promise<DeliveryState> {
  const store = createDeliveryStore(ctx.binding);
  const saved = await store.load();
  if (saved) return saved;
  // A new generation of an already-upgraded seat (rebind, new Coordinator)
  // starts empty and replays its addressed history; the unread cursor has no
  // Coordinator or generation in its key and must not be reimported.
  if (await store.otherGenerationExists()) return (await store.advance({}, ctx.guard)).after;
  // One-time upgrade: start where the pre-checkpoint destructive read left the
  // unread view, so nothing unread is lost and nothing read is replayed. Only
  // reads happen before this one atomic write, so a crash anywhere repeats it.
  const cursor = await ctx.backend.unreadCursor();
  return (await store.advance({ checkpoint: cursor, readThrough: cursor }, ctx.guard)).after;
}

const checkpointView = (point: LocalServerCursor | null) =>
  ({ entry_id: point?.id ?? null, created_at: point?.created_at ?? null });

export async function readRepresentativeReplies(
  ctx: RepresentativeContext,
  raw: unknown,
): Promise<{
  replies: RepresentativeReply[]; checkpoint: { entry_id: string | null; created_at: string | null };
  has_more: boolean; ignored_entries: number; binding_fingerprint: string; delivery: string;
}> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const allowed = ['include_broadcast', 'limit', 'max_bytes'];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key) && input[key] !== undefined);
  if (unknown.length > 0) throw new RepresentativeError(ErrorCode.INVALID_INPUT, `Unsupported field(s): ${unknown.join(', ')}.`);
  if (input.include_broadcast !== undefined && typeof input.include_broadcast !== 'boolean') {
    throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'include_broadcast must be a boolean.');
  }
  const bounded = (name: string, min: number, max: number, fallback: number) => {
    const value = input[name];
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
      throw new RepresentativeError(ErrorCode.INVALID_INPUT, `${name} must be an integer from ${min} to ${max}.`);
    }
    return value as number;
  };
  const limit = bounded('limit', 1, 50, 10);
  const maxBytes = bounded('max_bytes', 4096, 60000, 32768);
  await verifyLiveBinding(ctx);
  const state = await deliveryState(ctx);
  const requestIds = await ctx.store.transactRequests(ctx.binding.worktree, (records) =>
    new Set(records.map((record) => record.requestId)));

  // Deliberate ceiling: every read scans the cube log from the checkpoint,
  // including entries not addressed here, so an undelivered backlog costs a
  // growing scan. Upgrade path: a separate scan hint that deliver advances.
  // One addressed entry beyond `limit` is collected only to answer has_more.
  const candidates: Array<{ reply: RepresentativeReply; point: LocalServerCursor; ignoredBefore: number }> = [];
  let ignored = 0;
  let cursor = state.checkpoint;
  let last = state.checkpoint;
  scan: for (;;) {
    const page = await ctx.backend.readAfter(cursor, READ_SCAN_PAGE);
    for (const entry of page.entries) {
      const point = { id: entry.id, created_at: entry.created_at };
      // Client-side (created_at, id) filter: never repeat or regress.
      if (comparePoints(point, last) <= 0) continue;
      last = point;
      const addressed = isAddressedCoordinatorEntry(ctx.binding, entry);
      if (addressed === null || (addressed === 'broadcast' && input.include_broadcast !== true)) { ignored += 1; continue; }
      const quoted = (entry.message.match(UUID_SCAN_RE) ?? []).map((id) => id.toLowerCase());
      candidates.push({ point, ignoredBefore: ignored, reply: {
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
      } });
      if (candidates.length > limit) break scan;
    }
    const tail = page.entries.at(-1);
    if (!page.has_more || !tail) break;
    cursor = { id: tail.id, created_at: tail.created_at };
  }

  const result = (count: number, oversize = false) => {
    const taken = candidates.slice(0, count);
    const replies: RepresentativeReply[] = taken.map(({ reply }, index) =>
      (oversize && index === 0 ? { ...reply, oversize: true as const } : reply));
    return {
      replies,
      checkpoint: checkpointView(state.checkpoint),
      has_more: candidates.length > count,
      ignored_entries: count < candidates.length ? candidates[count].ignoredBefore : ignored,
      binding_fingerprint: bindingFingerprint(ctx.binding),
      delivery: REPRESENTATIVE_DELIVERY_NOTE,
    };
  };
  // Measure the real serialized result; entries are whole or omitted.
  let count = 0;
  while (count < Math.min(limit, candidates.length) &&
    Buffer.byteLength(serializeRepresentativeResult(result(count + 1))) <= maxBytes) count += 1;
  const oversize = count === 0 && candidates.length > 0;
  const final = result(oversize ? 1 : count, oversize);
  const returned = candidates[final.replies.length - 1]?.point;
  if (returned && comparePoints(returned, state.readThrough) > 0) {
    // The deliver fence widens before the caller can see the entries.
    await createDeliveryStore(ctx.binding).advance({ readThrough: returned }, ctx.guard);
  }
  return final;
}

export async function deliverRepresentativeReplies(
  ctx: RepresentativeContext,
  raw: unknown,
): Promise<{ checkpoint: { entry_id: string | null; created_at: string | null }; advanced: boolean; binding_fingerprint: string }> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== 'through');
  if (unknown.length > 0 || !isRepresentativeUuid(input.through)) {
    throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'through must be the full UUID of a reply returned by borg_representative-read.');
  }
  await verifyLiveBinding(ctx);
  const state = await deliveryState(ctx);
  const outside = () => new RepresentativeError('REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY',
    'That entry is not in the current read window: deliver only a reply that borg_representative-read returned. Nothing changed.');
  let entry: LogEntry;
  try {
    ({ entry } = await ctx.backend.readEntry(input.through));
  } catch (error) {
    if ((error as { status?: unknown })?.status === 404) throw outside();
    throw error;
  }
  if (entry.id !== input.through || isAddressedCoordinatorEntry(ctx.binding, entry) === null) throw outside();
  const point = { id: entry.id, created_at: entry.created_at };
  const fingerprint = bindingFingerprint(ctx.binding);
  if (state.checkpoint && comparePoints(point, state.checkpoint) <= 0) {
    return { checkpoint: checkpointView(state.checkpoint), advanced: false, binding_fingerprint: fingerprint };
  }
  if (state.readThrough === null || comparePoints(point, state.readThrough) > 0) throw outside();
  const { before, after } = await createDeliveryStore(ctx.binding).advance({ checkpoint: point }, ctx.guard);
  return {
    checkpoint: checkpointView(after.checkpoint),
    // The serialized transition, not this call's earlier snapshot.
    advanced: comparePoints(after.checkpoint!, before?.checkpoint ?? null) > 0,
    binding_fingerprint: fingerprint,
  };
}

export async function ackRepresentativeReply(
  ctx: RepresentativeContext,
  raw: unknown,
): Promise<{ acknowledged: string }> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => key !== 'entry_id');
  if (unknown.length > 0 || typeof input.entry_id !== 'string' || !isRepresentativeUuid(input.entry_id)) {
    throw new RepresentativeError(ErrorCode.INVALID_INPUT, 'entry_id must be the full UUID of a reply returned by borg_representative-read.');
  }
  await verifyLiveBinding(ctx);
  const { entry } = await ctx.backend.readEntry(input.entry_id);
  if (entry.id !== input.entry_id || isAddressedCoordinatorEntry(ctx.binding, entry) !== 'direct') {
    throw new RepresentativeError(
      'NOT_A_COORDINATOR_REPLY',
      'Only a direct reply from the bound Coordinator to this representative can be acknowledged here.',
    );
  }
  await ctx.backend.ack(entry.id);
  return { acknowledged: entry.id };
}

export async function representativeStatus(ctx: RepresentativeContext): Promise<{
  role: string;
  connected: boolean;
  problem?: { code: string; message: string };
  cube: { id: string; name: string };
  repository_origin: string | null;
  worktree: string;
  representative: { drone_id: string; label: string; role: string };
  coordinator: { drone_id: string; label: string; role: string };
  unresolved_requests: Array<{ request_id: string; state: string; kind: string; updated_at: string }>;
  delivery: string;
  authority: string;
  binding_fingerprint: string;
  checkpoint_problem?: { code: string; message: string };
}> {
  const { binding } = ctx;
  let problem: { code: string; message: string } | undefined;
  try {
    await verifyLiveBinding(ctx);
  } catch (error) {
    problem = {
      code: error instanceof RepresentativeError ? error.code : 'BACKEND_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
  let checkpointProblem: { code: string; message: string } | undefined;
  try {
    await createDeliveryStore(binding).load();
  } catch (error) {
    checkpointProblem = { code: (error as { code?: string }).code ?? 'BACKEND_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
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
    authority:
      'Borg records these messages as posts from the representative drone. The user-authorized / model-advice label is this ' +
      'connection\'s own attribution and is not verified or enforced by the Borg server.',
    binding_fingerprint: bindingFingerprint(binding),
    ...(checkpointProblem ? { checkpoint_problem: checkpointProblem } : {}),
  };
}
