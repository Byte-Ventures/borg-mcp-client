import crypto, { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import net, { isIP } from 'node:net';
import { globalAgent } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// RQ invocation contract: before enabling this test, verify the clean client
// worktree externally with:
//   test "$(git rev-parse HEAD)" = "$BORG_E2E_CLIENT_SHA" && git diff --quiet
// RQ owns the isolated server, CA, cube, reader seat, and two writer credentials.
// Ordinary `npm test` runs only the input-validation cases and skips the E2E.
const EXPECTED_CLIENT_SHA = '710e9a90446de07a819291307f6d75f9a21784aa';
const enabled = process.env.BORG_S4_COUPLED_E2E === '1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Cursor {
  id: string;
  created_at: string;
}

interface ActiveCube {
  cubeId: string;
  droneId: string;
  name: string;
  droneLabel: string;
  sessionToken: string;
  apiUrl: string;
  serverTrustIdentity: string;
}

interface WriterRef {
  endpoint: string;
  trust_identity: string;
  cube_id: string;
  drone_id: string;
  session_credential: string;
  role_id?: string;
  session_id?: string;
}

function installAgentTrace(
  events: Array<Record<string, unknown>>,
  agent: Pick<typeof globalAgent, 'addRequest'> = globalAgent,
  onEventCount: (count: number) => void = () => {},
): () => void {
  const original = agent.addRequest;
  const socketIds = new WeakMap<net.Socket, string>();
  const listeners = new Map<net.Socket, Array<[string, (...args: any[]) => void]>>();
  const pending = new Map<any, (socket: net.Socket) => void>();
  let nextSocketId = 1;
  let eventCount = 0;
  const recordEvent = (event: Record<string, unknown>) => {
    eventCount += 1;
    onEventCount(eventCount);
    if (events.length < MAX_SOCKET_EVENTS) events.push(event);
  };
  let active = true;
  let restored = false;
  agent.addRequest = function tracedAddRequest(request: any, options: any) {
    const method = String(options?.method ?? 'GET').toUpperCase();
    const pathname = new URL(`https://fixture.invalid${String(options?.path ?? '/')}`).pathname;
    const onSocket = (socket: net.Socket) => {
      pending.delete(request);
      if (!active) return;
      let socketId = socketIds.get(socket);
      if (!socketId) {
        socketId = `socket-${nextSocketId++}`;
        socketIds.set(socket, socketId);
        const socketListeners: Array<[string, (...args: any[]) => void]> = [
          ['close', () => recordEvent({ event: 'socket_close', socket_id: socketId, destroyed: socket.destroyed === true })],
          ['error', (error: any) => recordEvent({ event: 'socket_error', socket_id: socketId, code: normalizeDiagnosticCode(error) })],
          ['free', () => recordEvent({ event: 'socket_free', socket_id: socketId })],
        ];
        for (const [event, listener] of socketListeners) socket.on(event, listener);
        listeners.set(socket, socketListeners);
      }
      recordEvent({ event: 'request_socket', method, pathname, socket_id: socketId, reused: request.reusedSocket === true, destroyed: socket.destroyed });
    };
    pending.set(request, onSocket);
    request.once('socket', onSocket);
    return original.call(this, request, options);
  };
  return () => {
    if (restored) return;
    restored = true;
    active = false;
    agent.addRequest = original;
    for (const [request, listener] of pending) request.removeListener('socket', listener);
    pending.clear();
    for (const [socket, socketListeners] of listeners) {
      for (const [event, listener] of socketListeners) socket.removeListener(event, listener);
    }
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loopbackOrigin(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(hostname);
  const loopback = family === 4 ? hostname.startsWith('127.') : family === 6 && hostname === '::1';
  if (parsed.protocol !== 'https:' || parsed.origin !== value || !loopback) {
    throw new Error('BORG_API_URL must be a canonical numeric loopback HTTPS origin');
  }
  return parsed.origin;
}

function canonicalUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`${field} must be a canonical UUID`);
  }
  return value;
}

function decodeWriterRefs(value: unknown, active: ActiveCube): WriterRef[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error('BORG_E2E_WRITER_REFS must contain at least two writer refs');
  }
  const refs = value.map((candidate, index): WriterRef => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`writer ref ${index} must be an object`);
    }
    const ref = candidate as Record<string, unknown>;
    const endpoint = loopbackOrigin(String(ref.endpoint ?? ''));
    if (endpoint !== active.apiUrl || ref.trust_identity !== active.serverTrustIdentity) {
      throw new Error(`writer ref ${index} endpoint/trust does not match the reader active seat`);
    }
    const cubeId = canonicalUuid(ref.cube_id, `writer ref ${index}.cube_id`);
    if (cubeId !== active.cubeId) {
      throw new Error(`writer ref ${index} cube_id does not match BORG_E2E_CUBE_ID`);
    }
    const droneId = canonicalUuid(ref.drone_id, `writer ref ${index}.drone_id`);
    if (droneId === active.droneId) {
      throw new Error(`writer ref ${index} is cross-wired to the reader drone_id`);
    }
    if (typeof ref.session_credential !== 'string' || ref.session_credential.length < 43) {
      throw new Error(`writer ref ${index}.session_credential is missing or invalid`);
    }
    if (ref.session_credential === active.sessionToken) {
      throw new Error(`writer ref ${index} is cross-wired to the reader session credential`);
    }
    if (ref.role_id !== undefined) canonicalUuid(ref.role_id, `writer ref ${index}.role_id`);
    if (ref.session_id !== undefined) canonicalUuid(ref.session_id, `writer ref ${index}.session_id`);
    return {
      endpoint,
      trust_identity: active.serverTrustIdentity,
      cube_id: cubeId,
      drone_id: droneId,
      session_credential: ref.session_credential,
      ...(typeof ref.role_id === 'string' ? { role_id: ref.role_id } : {}),
      ...(typeof ref.session_id === 'string' ? { session_id: ref.session_id } : {}),
    };
  });
  if (new Set(refs.map((ref) => ref.drone_id)).size !== refs.length ||
    new Set(refs.map((ref) => ref.session_credential)).size !== refs.length) {
    throw new Error('writer refs must have distinct server-attributed drone_id and session_credential values');
  }
  return refs;
}

function sameCursor(left: Cursor | undefined, right: Cursor | undefined): boolean {
  return left?.id === right?.id && left?.created_at === right?.created_at;
}

function compareEntryOrder(left: { created_at: string; id: string }, right: { created_at: string; id: string }): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

const S4_SCHEMA_VERSION = 's4-coupled-e2e/v1' as const;
const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_IDLE_ENTRIES = 500;
const MAX_WRITERS = 16;
const MAX_STATUS_KEYS = 16;
const MAX_METHODS = 32;
const MAX_SOCKET_EVENTS = 512;
const MAX_STRING = 256;
const MAX_COUNT = 10_000;
const FAILURE_CODE = 'E2E_OPERATION_FAILED' as const;
const ABORT_CODE = 'ABORT_ERR' as const;
const ABORT_MESSAGE = 'directed observation complete' as const;
// Covers timestamp sampling and timer scheduling jitter while rejecting clock adjustments.
const QUIESCENCE_CLOCK_TOLERANCE_MS = 1_000;

export interface S4CoupledE2EOutput {
  schema_version: typeof S4_SCHEMA_VERSION;
  pass: true;
  client_sha: typeof EXPECTED_CLIENT_SHA;
  origin: string;
  simulated_idle_ms: number;
  idle_accepted_model_turns: number;
  idle_log_before_count: number;
  idle_log_after_count: number;
  idle_log_before: Array<{ id: string; created_at: string }>;
  idle_log_after: Array<{ id: string; created_at: string }>;
  idle_log_stable: true;
  idle_cursor_before: { id: string; created_at: string } | null;
  idle_cursor_after: { id: string; created_at: string } | null;
  idle_cursor_stable: true;
  directed_items: number;
  directed_accepted_model_turns: number;
  directed_unread_occurrences: number;
  authenticated_writer_ids: string[];
  validated_writer_refs: Array<{ cube_id: string; drone_id: string; role_id?: string; session_id?: string }>;
  authenticated_writer_count: number;
  writer_ids_match_configured: true;
  burst_expected: number;
  burst_drained: number;
  burst_unique: number;
  order_expected_count: number;
  order_mismatch_count: number;
  burst_order_exact: true;
  drain_pages: number;
  missing_ids: string[];
  duplicate_count: number;
  unexpected_ids: string[];
  status_counts: Record<string, number>;
  http_429_count: number;
  econnreset_count: number;
  transport_errors: Array<{ code: string | null; message: string }>;
  forbidden_fetch_attempts: number;
  all_requests_same_origin: true;
  phase_complete: true;
  turn_validation_errors: string[];
  app_server_methods: string[];
  phase: {
    stream_headers_ready_at: string;
    deadline_fired: false;
    directed_append_succeeded: true;
    directed_turn_count: number;
    quiescence_started_at: string;
    quiescence_ended_at: string;
    quiescence_elapsed_ms: number;
    wall_quiescence_elapsed_ms: number;
    abort_issued_at: string;
    abort_reason: 'directed observation complete';
    stream_error: { origin: 'iterator'; code: string | null; message: string };
    stream_shutdown_clean: true;
    directed_drain: 'succeeded';
    request_error_count: number;
    socket_event_count: number;
    requests: Array<{ method: string; pathname: string; phase: string; origin: 'bootstrap' | 'response_body'; code: string | null; message: string | null }>;
    sockets: Array<Record<string, unknown>>;
  };
  cleanup_verified: true;
}

type EntrySnapshot = { id: string; created_at: string };

function entryIdentityOrderSnapshot(entries: unknown): EntrySnapshot[] {
  if (!Array.isArray(entries)) throw new Error('log entries must be an array');
  return entries.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.created_at !== 'string') {
      throw new Error(`log entry ${index} must have string id and created_at`);
    }
    return { id: entry.id, created_at: entry.created_at };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedCount(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_COUNT;
}

function isBoundedString(value: unknown, max = MAX_STRING): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
}

function normalizeDiagnosticCode(error: any): 'ECONNRESET' | 'ETIMEDOUT' | 'ABORT_ERR' | 'OTHER' {
  const code = error?.code ?? error?.cause?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === ABORT_CODE ? code : 'OTHER';
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isCursor(value: unknown): value is Cursor {
  return isRecord(value) && hasExactKeys(value, ['id', 'created_at']) &&
    typeof value.id === 'string' && UUID_RE.test(value.id) && isCanonicalTimestamp(value.created_at);
}

function isEntrySnapshot(value: unknown): value is EntrySnapshot {
  return isCursor(value);
}

function sameEntrySnapshot(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((entry, index) => isEntrySnapshot(entry) && isEntrySnapshot(right[index]) &&
      entry.id === right[index].id && entry.created_at === right[index].created_at);
}

function isCanonicalLoopbackOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return loopbackOrigin(value) === value;
  } catch {
    return false;
  }
}

function isRequestRecord(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['method', 'pathname', 'phase', 'origin', 'code', 'message']) &&
    isBoundedString(value.method, 16) && isBoundedString(value.pathname) && value.pathname.startsWith('/') && isBoundedString(value.phase, 64) &&
    (value.origin === 'bootstrap' || value.origin === 'response_body') &&
    (value.code === null || ['ECONNRESET', 'ETIMEDOUT', 'ABORT_ERR', 'OTHER'].includes(String(value.code))) &&
    (value.message === null || value.message === 'transport failure');
}

function isStreamError(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['origin', 'code', 'message']) &&
    (value.origin === 'bootstrap' || value.origin === 'iterator') &&
    (value.code === null || ['ECONNRESET', 'ETIMEDOUT', ABORT_CODE, 'OTHER'].includes(String(value.code))) &&
    (value.message === 'transport failure' || value.message === ABORT_MESSAGE);
}

function isPhase(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'stream_headers_ready_at', 'deadline_fired', 'directed_append_succeeded', 'directed_turn_count',
    'quiescence_started_at', 'quiescence_ended_at', 'quiescence_elapsed_ms', 'wall_quiescence_elapsed_ms', 'abort_issued_at', 'abort_reason', 'stream_error',
    'stream_shutdown_clean', 'directed_drain', 'request_error_count', 'socket_event_count', 'requests', 'sockets',
  ])) return false;
  const socket = (candidate: unknown): boolean => {
    if (!isRecord(candidate) || !isBoundedString(candidate.event, 32) || !isBoundedString(candidate.socket_id, 64)) return false;
    if (candidate.event === 'request_socket') return hasExactKeys(candidate, ['event', 'method', 'pathname', 'socket_id', 'reused', 'destroyed']) &&
      isBoundedString(candidate.method, 16) && isBoundedString(candidate.pathname) && candidate.pathname.startsWith('/') &&
      typeof candidate.reused === 'boolean' && typeof candidate.destroyed === 'boolean';
    if (candidate.event === 'socket_close') return hasExactKeys(candidate, ['event', 'socket_id', 'destroyed']) && typeof candidate.destroyed === 'boolean';
    if (candidate.event === 'socket_error') return hasExactKeys(candidate, ['event', 'socket_id', 'code']) &&
      (candidate.code === null || ['ECONNRESET', 'ETIMEDOUT', ABORT_CODE, 'OTHER'].includes(String(candidate.code)));
    return candidate.event === 'socket_free' && hasExactKeys(candidate, ['event', 'socket_id']);
  };
  return (value.stream_headers_ready_at === null || isCanonicalTimestamp(value.stream_headers_ready_at)) &&
    typeof value.deadline_fired === 'boolean' && typeof value.directed_append_succeeded === 'boolean' &&
    isNonNegativeInteger(value.directed_turn_count) &&
    (value.quiescence_started_at === null || isCanonicalTimestamp(value.quiescence_started_at)) &&
    (value.quiescence_ended_at === null || isCanonicalTimestamp(value.quiescence_ended_at)) &&
    (value.quiescence_elapsed_ms === null || isNonNegativeInteger(value.quiescence_elapsed_ms)) &&
    (value.wall_quiescence_elapsed_ms === null || isNonNegativeInteger(value.wall_quiescence_elapsed_ms)) &&
    (value.abort_issued_at === null || isCanonicalTimestamp(value.abort_issued_at)) &&
    (value.abort_reason === null || typeof value.abort_reason === 'string') &&
    (value.stream_error === null || isStreamError(value.stream_error)) && typeof value.stream_shutdown_clean === 'boolean' &&
    ['not_started', 'started', 'succeeded', 'failed'].includes(String(value.directed_drain)) &&
    isBoundedCount(value.request_error_count) && value.request_error_count >= (Array.isArray(value.requests) ? value.requests.length : 0) &&
    isBoundedCount(value.socket_event_count) && value.socket_event_count >= (Array.isArray(value.sockets) ? value.sockets.length : 0) &&
    Array.isArray(value.requests) && value.requests.length <= 32 && value.requests.every(isRequestRecord) &&
    Array.isArray(value.sockets) && value.sockets.length <= MAX_SOCKET_EVENTS && value.sockets.every(socket);
}

function isValidatedWriterRef(value: unknown): boolean {
  if (!isRecord(value) || !('cube_id' in value) || !('drone_id' in value)) return false;
  const keys = Object.keys(value);
  if (!keys.every((key) => ['cube_id', 'drone_id', 'role_id', 'session_id'].includes(key))) return false;
  return typeof value.cube_id === 'string' && UUID_RE.test(value.cube_id) &&
    typeof value.drone_id === 'string' && UUID_RE.test(value.drone_id) &&
    (value.role_id === undefined || (typeof value.role_id === 'string' && UUID_RE.test(value.role_id))) &&
    (value.session_id === undefined || (typeof value.session_id === 'string' && UUID_RE.test(value.session_id)));
}

function isStatusCounts(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length <= MAX_STATUS_KEYS && Object.entries(value).every(([status, count]) =>
    /^(?:[1-5][0-9]{2})$/.test(status) && isBoundedCount(count));
}

const SUCCESS_OUTPUT_KEYS = [
  'schema_version', 'pass', 'client_sha', 'origin', 'simulated_idle_ms', 'idle_accepted_model_turns', 'idle_log_before_count',
  'idle_log_after_count', 'idle_log_before', 'idle_log_after', 'idle_log_stable', 'idle_cursor_before',
  'idle_cursor_after', 'idle_cursor_stable', 'directed_items', 'directed_accepted_model_turns',
  'directed_unread_occurrences', 'authenticated_writer_ids', 'validated_writer_refs', 'authenticated_writer_count',
  'writer_ids_match_configured', 'burst_expected', 'burst_drained', 'burst_unique', 'order_expected_count',
  'order_mismatch_count', 'burst_order_exact', 'drain_pages', 'missing_ids', 'duplicate_count', 'unexpected_ids',
  'status_counts', 'http_429_count', 'econnreset_count', 'transport_errors', 'forbidden_fetch_attempts',
  'all_requests_same_origin', 'phase_complete', 'turn_validation_errors', 'app_server_methods', 'phase',
  'cleanup_verified',
] as const;

/** Runtime contract for the credential-safe final JSON emitted after `S4_COUPLED_E2E `. */
export function validateS4CoupledE2EOutput(value: unknown): value is S4CoupledE2EOutput {
  if (!isRecord(value) || !hasExactKeys(value, SUCCESS_OUTPUT_KEYS) || value.pass !== true ||
    value.cleanup_verified !== true || value.schema_version !== S4_SCHEMA_VERSION || value.client_sha !== EXPECTED_CLIENT_SHA ||
    !isCanonicalLoopbackOrigin(value.origin)) return false;
  const before = value.idle_log_before;
  const after = value.idle_log_after;
  const writerIds = value.authenticated_writer_ids;
  const writerRefs = value.validated_writer_refs;
  const phase = value.phase as Record<string, unknown>;
  const expectedAbort = isStreamError(phase.stream_error) && phase.stream_error.origin === 'iterator' &&
    phase.stream_error.code === ABORT_CODE && phase.stream_error.message === ABORT_MESSAGE;
  const wallQuiescenceElapsed = isCanonicalTimestamp(phase.quiescence_started_at) && isCanonicalTimestamp(phase.quiescence_ended_at)
    ? Date.parse(phase.quiescence_ended_at) - Date.parse(phase.quiescence_started_at)
    : Number.NaN;
  const quiescenceComplete = Number.isSafeInteger(wallQuiescenceElapsed) && wallQuiescenceElapsed >= 6_000 &&
    isNonNegativeInteger(phase.wall_quiescence_elapsed_ms) && phase.wall_quiescence_elapsed_ms === wallQuiescenceElapsed &&
    isNonNegativeInteger(phase.quiescence_elapsed_ms) && phase.quiescence_elapsed_ms >= 6_000 &&
    Math.abs(wallQuiescenceElapsed - phase.quiescence_elapsed_ms) <= QUIESCENCE_CLOCK_TOLERANCE_MS;
  return value.simulated_idle_ms === 2 * 20 * 60 * 1000 && value.idle_accepted_model_turns === 0 &&
    isNonNegativeInteger(value.idle_log_before_count) && value.idle_log_before_count === (Array.isArray(before) ? before.length : -1) &&
    isNonNegativeInteger(value.idle_log_after_count) && value.idle_log_after_count === (Array.isArray(after) ? after.length : -1) &&
    Array.isArray(before) && before.length <= MAX_IDLE_ENTRIES && before.every(isEntrySnapshot) &&
    Array.isArray(after) && after.length <= MAX_IDLE_ENTRIES && after.every(isEntrySnapshot) &&
    value.idle_log_stable === true && sameEntrySnapshot(before, after) &&
    (value.idle_cursor_before === null || isCursor(value.idle_cursor_before)) &&
    (value.idle_cursor_after === null || isCursor(value.idle_cursor_after)) && value.idle_cursor_stable === true &&
    sameCursor(value.idle_cursor_before ?? undefined, value.idle_cursor_after ?? undefined) &&
    value.directed_items === 1 && value.directed_accepted_model_turns === 1 && value.directed_unread_occurrences === 1 &&
    Array.isArray(writerIds) && writerIds.length >= 2 && writerIds.length <= MAX_WRITERS && writerIds.every((id) => typeof id === 'string' && UUID_RE.test(id)) &&
    new Set(writerIds).size === writerIds.length && Array.isArray(writerRefs) && writerRefs.length === writerIds.length &&
    writerRefs.every(isValidatedWriterRef) && new Set(writerRefs.map((ref) => (ref as Record<string, string>).drone_id)).size === writerRefs.length &&
    writerRefs.every((ref) => writerIds.includes((ref as Record<string, string>).drone_id)) &&
    value.authenticated_writer_count === writerIds.length && value.writer_ids_match_configured === true &&
    value.burst_expected === 150 && value.burst_drained === 150 && value.burst_unique === 150 &&
    value.order_expected_count === 150 && value.order_mismatch_count === 0 && value.burst_order_exact === true &&
    isNonNegativeInteger(value.drain_pages) && value.drain_pages >= 1 && value.drain_pages <= 1_000 &&
    Array.isArray(value.missing_ids) && value.missing_ids.length === 0 &&
    value.duplicate_count === 0 && Array.isArray(value.unexpected_ids) && value.unexpected_ids.length === 0 &&
    isStatusCounts(value.status_counts) && value.http_429_count === 0 && (value.status_counts['429'] ?? 0) === value.http_429_count && value.econnreset_count === 0 &&
    Array.isArray(value.transport_errors) && value.transport_errors.length === 0 && value.forbidden_fetch_attempts === 0 &&
    value.all_requests_same_origin === true && value.phase_complete === true &&
    Array.isArray(value.turn_validation_errors) && value.turn_validation_errors.length === 0 &&
    Array.isArray(value.app_server_methods) && value.app_server_methods.length <= MAX_METHODS &&
    value.app_server_methods.every((method) => isBoundedString(method, 64)) &&
    isPhase(value.phase) && phase.stream_headers_ready_at !== null && phase.deadline_fired === false &&
    phase.directed_append_succeeded === true && phase.directed_turn_count === 1 &&
    quiescenceComplete && phase.abort_issued_at !== null &&
    phase.abort_reason === 'directed observation complete' && expectedAbort && phase.stream_shutdown_clean === true &&
    phase.directed_drain === 'succeeded' && Array.isArray(phase.requests) && phase.requests.length === 0;
}

export const isS4CoupledResult = validateS4CoupledE2EOutput;

export function isS4CoupledOutput(value: unknown): boolean {
  if (isS4CoupledResult(value)) return true;
  return isRecord(value) && hasExactKeys(value, ['schema_version', 'pass', 'client_sha', 'origin', 'error_code', 'cleanup_verified']) &&
    value.schema_version === S4_SCHEMA_VERSION && value.pass === false && value.client_sha === EXPECTED_CLIENT_SHA && isCanonicalLoopbackOrigin(value.origin) &&
    value.error_code === FAILURE_CODE && typeof value.cleanup_verified === 'boolean';
}

function serializeS4Output(value: unknown, maxBytes = MAX_OUTPUT_BYTES): string {
  if (!isS4CoupledOutput(value)) throw new Error('invalid S4 coupled E2E output');
  const line = `S4_COUPLED_E2E ${JSON.stringify(value)}`;
  if (Buffer.byteLength(line, 'utf8') > maxBytes) throw new Error('S4 coupled E2E output exceeds byte limit');
  return line;
}

function normalizedFailureOutput(origin: string, cleanupVerified: boolean, _error: unknown) {
  return {
    schema_version: S4_SCHEMA_VERSION,
    pass: false,
    client_sha: EXPECTED_CLIENT_SHA,
    origin,
    error_code: FAILURE_CODE,
    cleanup_verified: cleanupVerified,
  } as const;
}

function completeS4Output(): Record<string, unknown> {
  const entry = { id: '11111111-1111-4111-8111-111111111111', created_at: '2026-01-01T00:00:00.000Z' };
  const writerIds = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  return {
    schema_version: S4_SCHEMA_VERSION, pass: true, client_sha: EXPECTED_CLIENT_SHA, origin: 'https://127.0.0.1:7443', simulated_idle_ms: 2 * 20 * 60 * 1000,
    idle_accepted_model_turns: 0, idle_log_before_count: 1, idle_log_after_count: 1,
    idle_log_before: [entry], idle_log_after: [{ ...entry }], idle_log_stable: true,
    idle_cursor_before: entry, idle_cursor_after: { ...entry }, idle_cursor_stable: true,
    directed_items: 1, directed_accepted_model_turns: 1, directed_unread_occurrences: 1,
    authenticated_writer_ids: writerIds, validated_writer_refs: writerIds.map((drone_id) => ({
      cube_id: entry.id, drone_id,
    })), authenticated_writer_count: 2, writer_ids_match_configured: true,
    burst_expected: 150, burst_drained: 150, burst_unique: 150, order_expected_count: 150,
    order_mismatch_count: 0, burst_order_exact: true, drain_pages: 9, missing_ids: [], duplicate_count: 0,
    unexpected_ids: [], status_counts: { '200': 1 }, http_429_count: 0, econnreset_count: 0,
    transport_errors: [], forbidden_fetch_attempts: 0, all_requests_same_origin: true, phase_complete: true,
    turn_validation_errors: [], app_server_methods: ['thread/read', 'turn/start'], phase: {
      stream_headers_ready_at: '2026-01-01T00:00:00.000Z', deadline_fired: false,
      directed_append_succeeded: true, directed_turn_count: 1,
      quiescence_started_at: '2026-01-01T00:00:01.000Z', quiescence_ended_at: '2026-01-01T00:00:07.000Z', quiescence_elapsed_ms: 6_000, wall_quiescence_elapsed_ms: 6_000,
      abort_issued_at: '2026-01-01T00:00:07.000Z', abort_reason: 'directed observation complete',
      stream_error: { origin: 'iterator', code: ABORT_CODE, message: ABORT_MESSAGE },
      stream_shutdown_clean: true, directed_drain: 'succeeded', request_error_count: 0, socket_event_count: 0, requests: [], sockets: [],
    }, cleanup_verified: true,
  };
}

// The one-line runner output is valid only when every independently emitted proof holds.
function proofComplete(proof: {
  idleTurns: number; idleLogStable: boolean; idleCursorStable: boolean;
  directedTurns: number; directedOccurrences: number; expected: number; writerCount: number;
  writerIdsMatchConfigured: boolean; drained: number; unique: number; missing: number;
  duplicates: number; unexpected: number; orderExact: boolean; has429: boolean; resets: number;
  transportErrors: number; requestErrors: number; forbiddenFetches: number; sameOrigin: boolean;
  turnErrors: number; phaseComplete: boolean;
}): boolean {
  return proof.idleTurns === 0 && proof.idleLogStable && proof.idleCursorStable &&
    proof.directedTurns === 1 && proof.directedOccurrences === 1 && proof.expected === 150 &&
    proof.writerCount >= 2 && proof.writerIdsMatchConfigured && proof.drained === 150 &&
    proof.unique === 150 && proof.missing === 0 && proof.duplicates === 0 &&
    proof.unexpected === 0 && proof.orderExact && !proof.has429 && proof.resets === 0 &&
    proof.transportErrors === 0 && proof.requestErrors === 0 && proof.forbiddenFetches === 0 &&
    proof.sameOrigin && proof.turnErrors === 0 && proof.phaseComplete;
}

function trackInnerReaderRelease(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new Error('instrumented app-server response exceeded 65535 bytes');
}

async function fetchWithBodyLifetime(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; clearDeadlineAfterHeaders?: (response: Response) => boolean; onDeadline?: () => void; onBodyError?: (error: unknown) => void } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, clearDeadlineAfterHeaders, onDeadline, onBodyError } = options;
  const controller = new AbortController();
  let settled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => controller.abort(init.signal?.reason);
  const finalize = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
    reader?.releaseLock();
  };
  const timer = setTimeout(() => {
    onDeadline?.();
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    if (!response.body) {
      finalize();
      return response;
    }
    if (clearDeadlineAfterHeaders?.(response)) clearTimeout(timer);
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finalize();
            streamController.close();
          } else {
            streamController.enqueue(chunk.value);
          }
        } catch (error) {
          onBodyError?.(error);
          finalize();
          streamController.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finalize();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    finalize();
    throw error;
  }
}

function createRecordingFetch(
  rawFetch: typeof fetch,
  origin: string,
  getPhase: () => string,
  requests: Array<{ method: string; pathname: string; phase: string; origin: 'bootstrap' | 'response_body'; code: string | null; message: string | null }>,
  statuses = new Map<number, number>(),
  stream: { headersReady?: () => void; deadline?: () => void; bootstrapError?: (error: unknown) => void } = {},
  onRequestErrorCount: (count: number) => void = () => {},
): typeof fetch {
  let requestErrorCount = 0;
  const recordError = (record: { method: string; pathname: string; phase: string; origin: 'bootstrap' | 'response_body'; code: string; message: string }) => {
    requestErrorCount += 1;
    onRequestErrorCount(requestErrorCount);
    if (requests.length < 32) requests.push(record);
  };
  return async (input, init = {}) => {
    const url = new URL(input.toString());
    if (url.origin !== origin || loopbackOrigin(url.origin) !== origin) {
      throw new Error(`cross-authority request refused: ${url.href}`);
    }
    const record = () => ({ method: String(init.method ?? 'GET').toUpperCase(), pathname: url.pathname, phase: getPhase() });
    const streamRequest = url.pathname.endsWith('/stream');
    try {
      const response = await fetchWithBodyLifetime(rawFetch, input, init, {
        clearDeadlineAfterHeaders: (candidate) => streamRequest && candidate.ok && candidate.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream',
        onDeadline: () => { if (streamRequest) stream.deadline?.(); },
        onBodyError: (error: any) => recordError({ ...record(), origin: 'response_body', code: normalizeDiagnosticCode(error), message: 'transport failure' }),
      });
      if (streamRequest) stream.headersReady?.();
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      return response;
    } catch (error: any) {
      if (streamRequest) stream.bootstrapError?.(error);
      recordError({ ...record(), origin: 'bootstrap', code: normalizeDiagnosticCode(error), message: 'transport failure' });
      throw error;
    }
  };
}

function decodeFrame(buffer: Buffer): { value: any; consumed: number } | null {
  if (buffer.length < 6) return null;
  const lengthCode = buffer[1] & 0x7f;
  let offset = 2;
  let length = lengthCode;
  if (lengthCode === 126) {
    if (buffer.length < 8) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (lengthCode === 127) {
    if (buffer.length < 14) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if ((buffer[1] & 0x80) === 0) throw new Error('expected masked app-server client frame');
  const consumed = offset + 4 + length;
  if (buffer.length < consumed) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    payload[index] = buffer[offset + 4 + index] ^ mask[index % 4];
  }
  return { value: JSON.parse(payload.toString('utf8')), consumed };
}

async function bounded<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupJoinedFixture({
  streamAbort,
  streamPromise,
  sockets,
  appServer,
  runtimeDir,
  restoreAgentTrace,
}: {
  streamAbort?: AbortController;
  streamPromise?: Promise<void>;
  sockets: Iterable<Pick<net.Socket, 'destroy'>>;
  appServer?: Pick<net.Server, 'close'>;
  runtimeDir?: string;
  restoreAgentTrace: () => void;
}): Promise<void> {
  try {
    streamAbort?.abort();
    await bounded(streamPromise?.catch(() => {}) ?? Promise.resolve(), 'final stream cleanup').catch(() => {});
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // Cleanup continues so global tracing is restored after partial setup failures.
      }
    }
    await bounded(new Promise<void>((resolve) => {
      if (appServer) appServer.close(() => resolve());
      else resolve();
    }), 'app-server close').catch(() => {});
    if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  } finally {
    restoreAgentTrace();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/cubes.js');
  vi.doUnmock('../src/server-trust.js');
  vi.doUnmock('../src/local-server-cursor.js');
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('Sprint 4 E2E harness validation', () => {
  it('accepts only the complete credential-safe success output schema', () => {
    expect(isS4CoupledResult(completeS4Output())).toBe(true);
    expect(isS4CoupledOutput(completeS4Output())).toBe(true);
  });

  it.each([
    ['leaked credential field', (output: any) => { output.session_credential = 'secret'; }],
    ['nested sensitive field', (output: any) => { output.phase.sockets.push({ event: 'socket_free', socket_id: 'socket-1', token: 'secret' }); }],
    ['unknown nested field', (output: any) => { output.phase.extra = true; }],
    ['same-count idle replacement', (output: any) => { output.idle_log_after[0].id = '44444444-4444-4444-8444-444444444444'; }],
    ['idle order reversal', (output: any) => {
      output.idle_log_before.push({ id: '44444444-4444-4444-8444-444444444444', created_at: '2026-01-01T00:00:01.000Z' });
      output.idle_log_after = [...output.idle_log_before].reverse();
      output.idle_log_before_count = 2;
      output.idle_log_after_count = 2;
    }],
    ['coerced idle identity', (output: any) => { output.idle_log_before[0].id = 1; }],
    ['idle timestamp tie-break mutation', (output: any) => { output.idle_log_after[0].created_at = '2026-01-01T00:00:00.001Z'; }],
    ['cursor-only mutation', (output: any) => { output.idle_cursor_after.id = '44444444-4444-4444-8444-444444444444'; }],
    ['equal quiescence timestamps', (output: any) => { output.phase.quiescence_ended_at = output.phase.quiescence_started_at; }],
    ['reversed quiescence timestamps', (output: any) => { output.phase.quiescence_ended_at = '2026-01-01T00:00:00.000Z'; }],
    ['noncanonical quiescence timestamp', (output: any) => { output.phase.quiescence_ended_at = '2026-01-01T00:00:07Z'; }],
    ['missing quiescence elapsed', (output: any) => { delete output.phase.quiescence_elapsed_ms; }],
    ['negative quiescence elapsed', (output: any) => { output.phase.quiescence_elapsed_ms = -1; }],
    ['NaN quiescence elapsed', (output: any) => { output.phase.quiescence_elapsed_ms = Number.NaN; }],
    ['fractional quiescence elapsed', (output: any) => { output.phase.quiescence_elapsed_ms = 6_000.5; }],
    ['zero quiescence elapsed', (output: any) => { output.phase.quiescence_elapsed_ms = 0; }],
    ['short quiescence elapsed', (output: any) => { output.phase.quiescence_elapsed_ms = 5_999; }],
    ['wall 1ms and monotonic 6000ms', (output: any) => { output.phase.quiescence_ended_at = '2026-01-01T00:00:01.001Z'; output.phase.wall_quiescence_elapsed_ms = 1; }],
    ['wall 6000ms and monotonic 1ms', (output: any) => { output.phase.quiescence_elapsed_ms = 1; }],
    ['wall 5999ms and monotonic 6000ms', (output: any) => { output.phase.quiescence_ended_at = '2026-01-01T00:00:06.999Z'; output.phase.wall_quiescence_elapsed_ms = 5_999; }],
    ['excessive positive clock mismatch', (output: any) => { output.phase.quiescence_ended_at = '2026-01-01T00:00:08.001Z'; output.phase.wall_quiescence_elapsed_ms = 7_001; }],
    ['excessive negative clock mismatch', (output: any) => { output.phase.quiescence_elapsed_ms = 7_001; }],
    ['emitted wall delta inconsistent with timestamps', (output: any) => { output.phase.wall_quiescence_elapsed_ms = 6_001; }],
    ['incomplete phase', (output: any) => { delete output.phase.directed_drain; }],
    ['cross-wired writer inventory', (output: any) => { output.validated_writer_refs[1].drone_id = output.validated_writer_refs[0].drone_id; }],
    ['non-empty zero-error list', (output: any) => { output.transport_errors.push({ code: 'ECONNRESET' }); }],
    ['abort phrase plus secret', (output: any) => { output.phase.stream_error.message = `${ABORT_MESSAGE} token=secret`; }],
    ['oversized idle snapshot', (output: any) => {
      output.idle_log_before = Array.from({ length: MAX_IDLE_ENTRIES + 1 }, () => output.idle_log_before[0]);
      output.idle_log_after = [...output.idle_log_before];
      output.idle_log_before_count = output.idle_log_before.length;
      output.idle_log_after_count = output.idle_log_after.length;
    }],
    ['oversized writer inventory', (output: any) => {
      output.authenticated_writer_ids = Array.from({ length: MAX_WRITERS + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    }],
    ['oversized status map', (output: any) => {
      output.status_counts = Object.fromEntries(Array.from({ length: MAX_STATUS_KEYS + 1 }, (_, index) => [String(100 + index), 0]));
    }],
    ['oversized method string', (output: any) => { output.app_server_methods = ['x'.repeat(65)]; }],
    ['oversized socket evidence', (output: any) => {
      output.phase.sockets = Array.from({ length: MAX_SOCKET_EVENTS + 1 }, (_, index) => ({ event: 'socket_free', socket_id: `socket-${index}` }));
      output.phase.socket_event_count = output.phase.sockets.length;
    }],
  ])('rejects hostile success output with %s', (_case, mutate) => {
    const output = structuredClone(completeS4Output());
    mutate(output);
    expect(isS4CoupledResult(output)).toBe(false);
    expect(isS4CoupledOutput(output)).toBe(false);
  });

  it('accepts the exact and tolerance-boundary quiescence clock evidence', () => {
    expect(isS4CoupledResult(completeS4Output())).toBe(true);
    const toleranceBoundary = structuredClone(completeS4Output());
    (toleranceBoundary.phase as any).quiescence_elapsed_ms = 7_000;
    expect(isS4CoupledResult(toleranceBoundary)).toBe(true);
  });

  it('validates the closed failure output schema', () => {
    const success = completeS4Output();
    const failure = normalizedFailureOutput(String(success.origin), false,
      new Error('/private/owned/ca.pem BORG_E2E_READER_TOKEN=secret'));
    expect(isS4CoupledOutput(failure)).toBe(true);
    expect(isS4CoupledOutput({ ...failure, unexpected: true })).toBe(false);
    expect(isS4CoupledOutput({ ...failure, error_code: '/private/ca.pem token=secret' })).toBe(false);
    expect(serializeS4Output(failure)).not.toMatch(/private|token|secret|\.pem/);
  });

  it('rejects cyclic, deeply nested, and oversized output without recursive traversal', () => {
    const cyclic = completeS4Output() as any;
    cyclic.phase.extra = cyclic;
    expect(() => isS4CoupledOutput(cyclic)).not.toThrow();
    expect(isS4CoupledOutput(cyclic)).toBe(false);
    const deep: any = {};
    let cursor = deep;
    for (let index = 0; index < 1_000; index += 1) cursor = cursor.next = {};
    const output = completeS4Output() as any;
    output.phase.extra = deep;
    expect(() => isS4CoupledOutput(output)).not.toThrow();
    expect(isS4CoupledOutput(output)).toBe(false);
  });

  it.each(['request_error_count', 'socket_event_count'])(
    'enforces the shared count policy for phase.%s',
    (field) => {
      for (const invalid of [MAX_COUNT + 1, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY, Number.NaN, 1.5, -1]) {
        const output = completeS4Output() as any;
        output.phase[field] = invalid;
        expect(isS4CoupledOutput(output)).toBe(false);
      }
      const boundary = completeS4Output() as any;
      boundary.phase[field] = MAX_COUNT;
      expect(isS4CoupledOutput(boundary)).toBe(true);
    },
  );

  it('rejects a phase total below its retained sample length', () => {
    const output = completeS4Output() as any;
    output.phase.sockets = [{ event: 'socket_free', socket_id: 'socket-1' }];
    output.phase.socket_event_count = 0;
    expect(isS4CoupledOutput(output)).toBe(false);
  });

  it('enforces the persistent runner line byte limit using UTF-8 bytes', () => {
    const lineBytes = Buffer.byteLength(serializeS4Output(completeS4Output()), 'utf8');
    expect(serializeS4Output(completeS4Output(), lineBytes)).toContain('S4_COUPLED_E2E');
    expect(() => serializeS4Output(completeS4Output(), lineBytes - 1)).toThrow(/byte limit/);
    expect(lineBytes).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    const oversized = completeS4Output() as any;
    oversized.phase.sockets = Array.from({ length: MAX_SOCKET_EVENTS }, (_, index) => ({
      event: 'socket_free', socket_id: `${index}-${'ø'.repeat(28)}`,
    }));
    oversized.phase.socket_event_count = oversized.phase.sockets.length;
    expect(isS4CoupledOutput(oversized)).toBe(true);
    expect(() => serializeS4Output(oversized)).toThrow(/byte limit/);
  });

  it('rejects each non-success proof class from the strict result validator', () => {
    const complete = {
      idleTurns: 0, idleLogStable: true, idleCursorStable: true, directedTurns: 1,
      directedOccurrences: 1, expected: 150, writerCount: 2, writerIdsMatchConfigured: true,
      drained: 150, unique: 150, missing: 0, duplicates: 0, unexpected: 0, orderExact: true,
      has429: false, resets: 0, transportErrors: 0, requestErrors: 0, forbiddenFetches: 0,
      sameOrigin: true, turnErrors: 0, phaseComplete: true,
    };
    expect(proofComplete(complete)).toBe(true);
    for (const patch of [
      { idleCursorStable: false }, { idleLogStable: false }, { phaseComplete: false },
      { writerIdsMatchConfigured: false }, { orderExact: false }, { duplicates: 1 },
      { transportErrors: 1 }, { requestErrors: 1 }, { resets: 1 }, { has429: true },
    ]) expect(proofComplete({ ...complete, ...patch })).toBe(false);
  });

  it('takes identity/order snapshots without mutating source entries', () => {
    const source = [{ id: 'a', created_at: '2026-01-01T00:00:00.000Z', message: 'original' }];
    const before = entryIdentityOrderSnapshot(source);
    source[0].message = 'changed after snapshot';
    const after = entryIdentityOrderSnapshot([{ id: 'b', created_at: '2026-01-01T00:00:00.000Z' }]);
    expect(before).toEqual([{ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }]);
    expect(before).not.toEqual(after);
  });
  it('accepts canonical numeric IPv4 and IPv6 loopback origins', () => {
    expect(loopbackOrigin('https://127.0.0.1:7443')).toBe('https://127.0.0.1:7443');
    expect(loopbackOrigin('https://[::1]:7443')).toBe('https://[::1]:7443');
  });

  it.each([
    'https://localhost:7443',
    'https://192.0.2.1:7443',
    'http://127.0.0.1:7443',
    'https://127.0.0.1:7443/path',
  ])('rejects non-numeric, non-loopback, non-TLS, or non-origin input %s', (value) => {
    expect(() => loopbackOrigin(value)).toThrow(/numeric loopback HTTPS origin/);
  });

  it('accepts only canonical authenticated writer UUIDs', () => {
    expect(UUID_RE.test('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(UUID_RE.test('')).toBe(false);
    expect(UUID_RE.test('writer-1')).toBe(false);
    expect(UUID_RE.test('11111111-1111-4111-7111-111111111111')).toBe(false);
  });

  it.each([
    ['cube mismatch', { cube_id: '22222222-2222-4222-8222-222222222222' }, /cube_id/],
    ['malformed UUID', { drone_id: 'writer-1' }, /drone_id/],
    ['missing session', { session_credential: undefined }, /session_credential/],
    ['reader cross-wire', { drone_id: '11111111-1111-4111-8111-111111111111' }, /cross-wired/],
    ['endpoint mismatch', { endpoint: 'https://127.0.0.1:7444' }, /endpoint\/trust/],
  ])('rejects writer ref %s before any append', (_case, patch, message) => {
    const active: ActiveCube = {
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: '11111111-1111-4111-8111-111111111111',
      name: 'cube',
      droneLabel: 'reader',
      sessionToken: 'r'.repeat(43),
      apiUrl: 'https://127.0.0.1:7443',
      serverTrustIdentity: 'spki-sha256:test',
    };
    const writer = (drone: string, credential: string) => ({
      endpoint: active.apiUrl,
      trust_identity: active.serverTrustIdentity,
      cube_id: active.cubeId,
      drone_id: drone,
      session_credential: credential,
    });
    expect(() => decodeWriterRefs([
      { ...writer('22222222-2222-4222-8222-222222222222', 'a'.repeat(43)), ...patch },
      writer('33333333-3333-4333-8333-333333333333', 'b'.repeat(43)),
    ], active)).toThrow(message);
  });

  it('rejects duplicate writer identity and credential before any append', () => {
    const active: ActiveCube = {
      cubeId: '11111111-1111-4111-8111-111111111111',
      droneId: '11111111-1111-4111-8111-111111111111',
      name: 'cube',
      droneLabel: 'reader',
      sessionToken: 'r'.repeat(43),
      apiUrl: 'https://127.0.0.1:7443',
      serverTrustIdentity: 'spki-sha256:test',
    };
    const writer = {
      endpoint: active.apiUrl,
      trust_identity: active.serverTrustIdentity,
      cube_id: active.cubeId,
      drone_id: '22222222-2222-4222-8222-222222222222',
      session_credential: 'a'.repeat(43),
    };
    expect(() => decodeWriterRefs([writer, writer], active)).toThrow(/distinct/);
  });

  it.each(['eof', 'error'] as const)('releases the upstream abort bridge when the response body reaches %s', async (outcome) => {
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        if (outcome === 'eof') controller.close();
        else controller.error(new Error('stalled transport failed'));
      },
    });
    const sourceResponse = new Response(source);
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async () => sourceResponse),
      'https://127.0.0.1:7443/stream',
      { signal },
    );
    const reader = response.body!.getReader();
    if (outcome === 'eof') await expect(reader.read()).resolves.toMatchObject({ done: true });
    else await expect(reader.read()).rejects.toThrow('stalled transport failed');
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await reader.cancel().catch(() => {});
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('releases the upstream abort bridge when the response body is cancelled', async () => {
    const removeEventListener = vi.fn();
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener,
    } as unknown as AbortSignal;
    let sourceCancelled = 0;
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      cancel() { sourceCancelled += 1; },
    }));
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async () => sourceResponse),
      'https://127.0.0.1:7443/stream',
      { signal },
    );
    await response.body!.cancel(new Error('consumer stopped'));
    expect(sourceCancelled).toBe(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('keeps the upstream abort bridge until a stalled response body is cancelled', async () => {
    const upstream = new AbortController();
    const removeEventListener = vi.spyOn(upstream.signal, 'removeEventListener');
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let transportAborted = false;
    let sourceResponse!: Response;
    let releaseLock!: ReturnType<typeof vi.spyOn>;
    const fetchImpl: typeof fetch = vi.fn(async (_input, init) => {
      init!.signal!.addEventListener('abort', () => {
        transportAborted = true;
        sourceController.error(init!.signal!.reason);
      }, { once: true });
      sourceResponse = new Response(new ReadableStream<Uint8Array>({
        start(controller) { sourceController = controller; },
      }));
      releaseLock = trackInnerReaderRelease();
      return sourceResponse;
    });
    const response = await fetchWithBodyLifetime(fetchImpl, 'https://127.0.0.1:7443/stream', {
      signal: upstream.signal,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    upstream.abort(new Error('external stream shutdown'));
    await expect(pending).rejects.toThrow('external stream shutdown');
    expect(transportAborted).toBe(true);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled connect while allowing an SSE body past its header deadline', async () => {
    vi.useFakeTimers();
    const connectFetch: typeof fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    const connect = fetchWithBodyLifetime(connectFetch, 'https://127.0.0.1:7443/logs', {}, {
      timeoutMs: 10,
    });
    const connectRejected = expect(connect).rejects.toThrow('request timeout');
    await vi.advanceTimersByTimeAsync(10);
    await connectRejected;

    const upstream = new AbortController();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let deadlineFired = false;
    const sse = await fetchWithBodyLifetime(
      vi.fn(async (_input, init) => {
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
        return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      }),
      'https://127.0.0.1:7443/stream',
      { signal: upstream.signal },
      { timeoutMs: 10, clearDeadlineAfterHeaders: (response) => response.headers.get('content-type')?.startsWith('text/event-stream') === true, onDeadline: () => { deadlineFired = true; } },
    );
    const reader = sse.body!.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(11);
    expect(deadlineFired).toBe(false);
    upstream.abort(new Error('external stream shutdown'));
    await expect(pending).rejects.toThrow('external stream shutdown');
    vi.useRealTimers();
  });

  it.each([
    ['error status', 500, 'text/event-stream'],
    ['wrong content type', 200, 'application/json'],
    ['missing content type', 200, undefined],
  ])('keeps a /stream %s body under the deadline', async (_case, status, contentType) => {
    vi.useFakeTimers();
    const upstream = new AbortController();
    const removeEventListener = vi.spyOn(upstream.signal, 'removeEventListener');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let deadlineFired = false;
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }), {
      status,
      headers: contentType ? { 'Content-Type': contentType } : {},
    });
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async (_input, init) => {
        init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true });
        return sourceResponse;
      }),
      'https://127.0.0.1:7443/stream',
      { signal: upstream.signal },
      { timeoutMs: 10, clearDeadlineAfterHeaders: (value) => value.ok && value.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream', onDeadline: () => { deadlineFired = true; } },
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    const rejected = expect(pending).rejects.toThrow('request timeout');
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(deadlineFired).toBe(true);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    await reader.cancel().catch(() => {});
    expect(releaseLock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('keeps a non-SSE stalled body bounded through deadline cleanup', async () => {
    vi.useFakeTimers();
    const upstream = new AbortController();
    const removeEventListener = vi.spyOn(upstream.signal, 'removeEventListener');
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let deadlineFired = false;
    const sourceResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) { sourceController = controller; },
    }), { headers: { 'Content-Type': 'application/json' } });
    const releaseLock = trackInnerReaderRelease();
    const response = await fetchWithBodyLifetime(
      vi.fn(async (_input, init) => {
        init!.signal!.addEventListener('abort', () => sourceController.error(init!.signal!.reason), { once: true });
        return sourceResponse;
      }),
      'https://127.0.0.1:7443/logs',
      { signal: upstream.signal },
      { timeoutMs: 10, onDeadline: () => { deadlineFired = true; } },
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    const pendingRejected = expect(pending).rejects.toThrow('request timeout');
    await vi.advanceTimersByTimeAsync(10);
    await pendingRejected;
    expect(deadlineFired).toBe(true);
    expect(sourceResponse.body!.locked).toBe(false);
    expect(releaseLock).toHaveBeenCalledTimes(1);
    await reader.cancel().catch(() => {});
    expect(releaseLock).toHaveBeenCalledTimes(1);
    expect(removeEventListener).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('attributes an injected post-abort directed-drain body reset without masking it', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const records: Array<Record<string, unknown>> = [];
    const source = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(reset); },
    }));
    const response = await fetchWithBodyLifetime(
      vi.fn(async () => source),
      'https://127.0.0.1:7443/api/cubes/11111111-1111-4111-8111-111111111111/logs',
      {},
      { onBodyError: (error: any) => records.push({ method: 'PUT', pathname: '/api/cubes/11111111-1111-4111-8111-111111111111/logs', phase: 'post_abort_directed_drain', origin: 'response_body', code: error.code }) },
    );
    await expect(response.json()).rejects.toBe(reset);
    expect(records).toEqual([{
      method: 'PUT', pathname: '/api/cubes/11111111-1111-4111-8111-111111111111/logs', phase: 'post_abort_directed_drain', origin: 'response_body', code: 'ECONNRESET',
    }]);
    expect(source.body!.locked).toBe(false);
  });

  it('attributes a real local directed-drain readLog body reset', async () => {
    const origin = 'https://127.0.0.1:7443';
    const cubeId = '11111111-1111-4111-8111-111111111111';
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const records: Array<{ method: string; pathname: string; phase: string; origin: 'bootstrap' | 'response_body'; code: string | null; message: string | null }> = [];
    let requestPhase = 'post_abort_directed_drain';
    const recordingFetch = createRecordingFetch(
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(reset); },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      origin,
      () => requestPhase,
      records,
    );
    vi.doMock('../src/cubes.js', () => ({
      getActiveCube: vi.fn(async () => ({ cubeId, droneId: '22222222-2222-4222-8222-222222222222', sessionToken: 's'.repeat(43), apiUrl: origin, serverTrustIdentity: 'spki-sha256:test' })),
    }));
    vi.doMock('../src/server-trust.js', () => ({
      loadBorgServerTrust: vi.fn(async () => ({ identity: 'spki-sha256:test', fetchImpl: recordingFetch })),
    }));
    const remote = await import('../src/remote-client.js');
    await expect(remote.readLog('s'.repeat(43), origin, { unreadOnly: true, limit: 20 })).rejects.toBe(reset);
    expect(records).toContainEqual(expect.objectContaining({
      method: 'PUT',
      pathname: `/api/cubes/${cubeId}/logs`,
      phase: 'post_abort_directed_drain',
      origin: 'response_body',
      code: 'ECONNRESET',
    }));
    requestPhase = 'changed-after-read';
  });

  it('attributes a stream bootstrap reset through the shared helper', async () => {
    const reset = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
    const records: any[] = [];
    let bootstrap: any;
    const fetchImpl = createRecordingFetch(
      vi.fn(async () => { throw reset; }),
      'https://127.0.0.1:7443',
      () => 'stream_bootstrap',
      records,
      undefined,
      { bootstrapError: (error) => { bootstrap = error; } },
    );
    await expect(fetchImpl('https://127.0.0.1:7443/api/cubes/11111111-1111-4111-8111-111111111111/stream')).rejects.toBe(reset);
    expect(bootstrap).toBe(reset);
    expect(records).toContainEqual(expect.objectContaining({ origin: 'bootstrap', method: 'GET', pathname: '/api/cubes/11111111-1111-4111-8111-111111111111/stream', code: 'ECONNRESET' }));
  });

  it('traces and restores a scoped agent request lifecycle', () => {
    const calls: Array<Record<string, unknown>> = [];
    const agent = { addRequest: vi.fn() } as unknown as Pick<typeof globalAgent, 'addRequest'>;
    const original = agent.addRequest;
    const restore = installAgentTrace(calls, agent);
    const request = new EventEmitter() as any;
    request.reusedSocket = true;
    const socket = new EventEmitter() as any;
    socket.destroyed = false;
    agent.addRequest(request, { method: 'PUT', path: '/api/cubes/11111111-1111-4111-8111-111111111111/logs' } as any);
    request.emit('socket', socket);
    socket.emit('free');
    socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    socket.destroyed = true;
    socket.emit('close');
    restore();
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'request_socket', method: 'PUT', reused: true, destroyed: false }),
      expect.objectContaining({ event: 'socket_free' }),
      expect.objectContaining({ event: 'socket_error', code: 'ECONNRESET' }),
      expect.objectContaining({ event: 'socket_close', destroyed: true }),
    ]));
    expect(agent.addRequest).toBe(original);
    expect(socket.listenerCount('free')).toBe(0);
  });

  it('restores an inactive tracer before a pending request receives its socket', () => {
    const calls: Array<Record<string, unknown>> = [];
    const agent = { addRequest: vi.fn() } as unknown as Pick<typeof globalAgent, 'addRequest'>;
    const original = agent.addRequest;
    const restore = installAgentTrace(calls, agent);
    const request = new EventEmitter() as any;
    const socket = new EventEmitter() as any;
    socket.destroyed = false;
    agent.addRequest(request, { method: 'GET', path: '/api/cubes/x/stream' } as any);
    restore();
    restore();
    request.emit('socket', socket);
    expect(calls).toEqual([]);
    expect(socket.listenerCount('close')).toBe(0);
    expect(agent.addRequest).toBe(original);
  });

  it('restores the original agent when setup fails immediately after installation', () => {
    const calls: Array<Record<string, unknown>> = [];
    const agent = { addRequest: vi.fn() } as unknown as Pick<typeof globalAgent, 'addRequest'>;
    const original = agent.addRequest;
    try {
      const restore = installAgentTrace(calls, agent);
      try {
        throw new Error('setup failed');
      } finally {
        restore();
        restore();
      }
    } catch (error) {
      expect((error as Error).message).toBe('setup failed');
    }
    expect(agent.addRequest).toBe(original);
    expect(calls).toEqual([]);
  });

  it('cleans joined resources before restoring tracing and tolerates setup optionals', async () => {
    const order: string[] = [];
    const abort = new AbortController();
    const streamPromise = new Promise<void>((resolve) => {
      abort.signal.addEventListener('abort', () => {
        order.push('abort');
        resolve();
      }, { once: true });
    }).then(() => { order.push('settled'); });
    const runtimeDir = await mkdtemp(path.join(tmpdir(), 'borg-client-s4-cleanup-'));
    await cleanupJoinedFixture({
      streamAbort: abort,
      streamPromise,
      sockets: [{ destroy: () => { order.push('socket'); } }],
      appServer: { close: (callback: () => void) => { order.push('server'); callback(); } },
      runtimeDir,
      restoreAgentTrace: () => { order.push('restore'); },
    });
    expect(order).toEqual(['abort', 'settled', 'socket', 'server', 'restore']);
    expect(existsSync(runtimeDir)).toBe(false);

    await expect(cleanupJoinedFixture({
      sockets: [],
      restoreAgentTrace: () => { order.push('optional-restore'); },
    })).resolves.toBeUndefined();
    expect(order.at(-1)).toBe('optional-restore');
  });
});

describe.runIf(enabled)('Sprint 4 joined client/server E2E', () => {
  it('proves idle=0, directed=1, exact 150 drain, transport health, and zero egress', async () => {
    expect(required('BORG_E2E_CLIENT_SHA')).toBe(EXPECTED_CLIENT_SHA);
    const origin = loopbackOrigin(required('BORG_API_URL'));
    const caPath = path.resolve(required('BORG_E2E_CA_PATH'));
    const trustIdentity = required('BORG_E2E_TRUST_IDENTITY');

    const active: ActiveCube = {
      cubeId: canonicalUuid(required('BORG_E2E_CUBE_ID'), 'BORG_E2E_CUBE_ID'),
      droneId: canonicalUuid(required('BORG_E2E_READER_DRONE_ID'), 'BORG_E2E_READER_DRONE_ID'),
      name: 's4-coupled-e2e',
      droneLabel: 's4-reader',
      sessionToken: required('BORG_E2E_READER_TOKEN'),
      apiUrl: origin,
      serverTrustIdentity: trustIdentity,
    };
    const writerRefs = decodeWriterRefs(
      JSON.parse(required('BORG_E2E_WRITER_REFS')) as unknown,
      active,
    );
    const runtimeDir = await mkdtemp(path.join(tmpdir(), 'borg-client-s4-coupled-'));
    const socketPath = path.join(runtimeDir, 'instrumented-app-server.sock');
    const sockets = new Set<net.Socket>();
    const cursorState = new Map<string, Cursor>();
    const statuses = new Map<number, number>();
    const requestUrls: string[] = [];
    const transportErrors: Array<{ code: string | null; message: string }> = [];
    const turnErrors: string[] = [];
    const methods: string[] = [];
    const phase = {
      stream_headers_ready_at: null as string | null,
      deadline_fired: false,
      directed_append_succeeded: false,
      directed_turn_count: 0,
      quiescence_started_at: null as string | null,
      quiescence_ended_at: null as string | null,
      quiescence_elapsed_ms: null as number | null,
      wall_quiescence_elapsed_ms: null as number | null,
      abort_issued_at: null as string | null,
      abort_reason: null as string | null,
      stream_error: null as { origin: 'bootstrap' | 'iterator'; code: string | null; message: string } | null,
      stream_shutdown_clean: false,
      directed_drain: 'not_started' as 'not_started' | 'started' | 'succeeded' | 'failed',
      request_error_count: 0,
      socket_event_count: 0,
      requests: [] as Array<{ method: string; pathname: string; phase: string; origin: 'bootstrap' | 'response_body'; code: string | null; message: string | null }>,
      sockets: [] as Array<Record<string, unknown>>,
    };
    let requestPhase = 'setup';
    const restoreAgentTrace = installAgentTrace(phase.sockets, globalAgent, (count) => { phase.socket_event_count = count; });
    let result: Record<string, unknown> | undefined;
    let operationError: unknown;
    let appServer: net.Server | undefined;
    let streamAbort: AbortController | undefined;
    let streamPromise: Promise<void> | undefined;
    try {
    let forbiddenFetchAttempts = 0;
    let acceptedTurns = 0;

    const cursorKey = (binding: { purpose?: string }) => binding.purpose ?? 'unread';
    vi.doMock('../src/local-server-cursor.js', () => ({
      getLocalServerCursor: vi.fn(async (binding: { purpose?: string }) => cursorState.get(cursorKey(binding)) ?? null),
      advanceLocalServerCursor: vi.fn(async (binding: { purpose?: string }, cursor: Cursor) => {
        const key = cursorKey(binding);
        const prior = cursorState.get(key);
        if (!prior || prior.created_at < cursor.created_at ||
          (prior.created_at === cursor.created_at && prior.id < cursor.id)) {
          cursorState.set(key, cursor);
        }
      }),
      clearLocalServerCursor: vi.fn(async (binding: { purpose?: string }) => {
        cursorState.delete(cursorKey(binding));
      }),
      encodeLocalServerCursor: (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url'),
    }));
    vi.doMock('../src/cubes.js', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/cubes.js')>(),
      getActiveCube: vi.fn(async () => active),
    }));

    const actualTrust = await vi.importActual<typeof import('../src/server-trust.js')>('../src/server-trust.js');
    const pinnedFetch = actualTrust.createPinnedServerFetch(origin, readFileSync(caPath, 'utf8'));
    const recordingFetch = createRecordingFetch(async (input, init) => {
      requestUrls.push(new URL(input.toString()).href);
      return pinnedFetch(input, init);
    }, origin, () => requestPhase, phase.requests, statuses, {
      headersReady: () => { phase.stream_headers_ready_at = new Date().toISOString(); },
      deadline: () => { phase.deadline_fired = true; },
      bootstrapError: (error: any) => {
        phase.stream_error = { origin: 'bootstrap', code: normalizeDiagnosticCode(error), message: 'transport failure' };
      },
    }, (count) => { phase.request_error_count = count; });
    vi.doMock('../src/server-trust.js', () => ({
      ...actualTrust,
      loadBorgServerTrust: vi.fn(async () => ({ identity: trustIdentity, fetchImpl: recordingFetch })),
    }));
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      forbiddenFetchAttempts += 1;
      throw new Error(`untrusted fetch forbidden: ${String(input)}`);
    }));

    appServer = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => { if (turnErrors.length < 32) turnErrors.push('app-server socket failure'); });
      let buffer = Buffer.alloc(0);
      let handshaken = false;
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (!handshaken) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const headers = buffer.subarray(0, end).toString('utf8');
          const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/mi)?.[1]?.trim();
          if (!key) return socket.destroy(new Error('missing websocket key'));
          const accept = crypto.createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
          socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${accept}`,
            '',
            '',
          ].join('\r\n'));
          buffer = buffer.subarray(end + 4);
          handshaken = true;
        }
        for (;;) {
          const decoded = decodeFrame(buffer);
          if (!decoded) return;
          buffer = buffer.subarray(decoded.consumed);
          const request = decoded.value;
             if (typeof request.method === 'string' && methods.length < MAX_METHODS) methods.push(request.method.slice(0, 64));
          if (typeof request.id !== 'number') continue;
          let result: any = {};
          if (request.method === 'thread/read') {
            result = { thread: {
              id: 's4-thread',
              cwd: process.cwd(),
              preview: 's4 coupled fixture',
              status: { type: 'idle' },
              updatedAt: Date.now(),
            } };
          } else if (request.method === 'turn/start') {
            const input = request.params?.input;
            const text = Array.isArray(input) ? input[0]?.text : null;
            if (
              request.params?.threadId !== 's4-thread' ||
              input?.length !== 1 ||
              input[0]?.type !== 'text' ||
              typeof text !== 'string' ||
              !text.startsWith('New Borg cube-log activity arrived:') ||
              !text.includes('s4-directed-')
            ) {
              turnErrors.push('invalid turn/start thread or prompt');
              socket.write(frame({ id: request.id, error: { message: 'invalid instrumented turn' } }));
              continue;
            }
            acceptedTurns += 1;
          }
          socket.write(frame({ id: request.id, result }));
        }
      });
    });

      await bounded(new Promise<void>((resolve, reject) => {
        appServer!.once('error', reject);
        appServer!.listen(socketPath, resolve);
      }), 'app-server listen');

      const remote = await import('../src/remote-client.js');
      const stream = await import('../src/log-stream.js');
      const wake = await import('../src/codex-app-wake.js');
      const wakeDeps = {
        getActiveCube: async () => active,
        getCodexWakeTarget: async () => ({ socketPath, threadId: 's4-thread' }),
        isStreamOwner: () => true,
      };

      const drainUnread = async (limit: number) => {
        const entries: any[] = [];
        let pages = 0;
        for (;;) {
          const page = await remote.readLog(active.sessionToken, origin, {
            unreadOnly: true,
            limit,
            serverTrustIdentity: trustIdentity,
          });
          pages += 1;
          entries.push(...page.entries);
          if (!page.has_more) return { entries, pages };
        }
      };
      await drainUnread(500);
      const unreadBaseline = cursorState.get('unread');
      if (unreadBaseline) cursorState.set('stream', unreadBaseline);
      const idleLogBefore = await remote.readLog(active.sessionToken, origin, {
        limit: 500,
        serverTrustIdentity: trustIdentity,
      });
      const idleCursorBefore = cursorState.get('unread');

      wake.resetCodexWakeForTests();
      await wake.fireCodexHeartbeatTick({
        ...wakeDeps,
        hasPendingWork: async () => remote.hasPendingWakeActivity(active),
        now: () => wake.CODEX_HEARTBEAT_CADENCE_MS,
      });
      await wake.fireCodexHeartbeatTick({
        ...wakeDeps,
        hasPendingWork: async () => remote.hasPendingWakeActivity(active),
        now: () => 2 * wake.CODEX_HEARTBEAT_CADENCE_MS,
      });
      const idleTurns = acceptedTurns;
      const idleLogAfter = await remote.readLog(active.sessionToken, origin, {
        limit: 500,
        serverTrustIdentity: trustIdentity,
      });
      const idleCursorAfter = cursorState.get('unread');
      const idleLogBeforeSnapshot = entryIdentityOrderSnapshot(idleLogBefore.entries);
      const idleLogAfterSnapshot = entryIdentityOrderSnapshot(idleLogAfter.entries);
      const idleLogStable = JSON.stringify(idleLogBeforeSnapshot) === JSON.stringify(idleLogAfterSnapshot) &&
        idleLogBefore.has_more === idleLogAfter.has_more;
      const idleCursorStable = sameCursor(idleCursorBefore, idleCursorAfter);

      let streamReadyResolve!: () => void;
      const streamReady = new Promise<void>((resolve) => { streamReadyResolve = resolve; });
      const streamFetch: typeof fetch = async (input, init) => {
        const response = await recordingFetch(input, init);
        streamReadyResolve();
        return response;
      };
      streamAbort = new AbortController();
      streamPromise = stream.streamOnce(active, null, () => {}, {
        fetchImpl: streamFetch,
        appendLine: async () => {},
        hasInboxEntryId: async () => false,
        injectOpenCode: async () => false,
        wakeCodex: (reason) => wake.wakeCodexViaAppServer(
          reason,
          { BORG_CODEX_REMOTE_WAKE: '1' },
          wakeDeps,
        ),
        abortSignal: streamAbort.signal,
      });
      void streamPromise.catch((error: any) => {
        phase.stream_error ??= {
          origin: 'iterator',
          code: streamAbort?.signal.aborted ? ABORT_CODE : normalizeDiagnosticCode(error),
          message: streamAbort?.signal.aborted ? ABORT_MESSAGE : 'transport failure',
        };
      });
      await bounded(Promise.race([
        streamReady,
        streamPromise.then(() => { throw new Error('stream ended before ready'); }),
      ]), 'stream readiness');

      const append = async (token: string, message: string, direct = false) => {
        const response = await recordingFetch(`${origin}/api/cubes/${active.cubeId}/logs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            protocol_version: '2',
            request_id: randomUUID(),
            payload: {
              message,
              visibility: direct ? 'direct' : 'broadcast',
              recipientDroneIds: direct ? [active.droneId] : [],
            },
          }),
          redirect: 'error',
        });
        const body = await response.json() as any;
        if (!response.ok) throw new Error(`append HTTP ${response.status}: ${body?.error?.code ?? 'unknown'}`);
        return body.payload.entry;
      };

      const directed = await append(writerRefs[0].session_credential, `s4-directed-${randomUUID()}`, true);
      phase.directed_append_succeeded = true;
      await bounded((async () => {
        while (acceptedTurns < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      })(), 'directed turn');
      phase.directed_turn_count = acceptedTurns - idleTurns;
      phase.quiescence_started_at = new Date().toISOString();
      const quiescenceStartedAt = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      phase.quiescence_ended_at = new Date().toISOString();
      phase.quiescence_elapsed_ms = Math.floor(performance.now() - quiescenceStartedAt);
      phase.wall_quiescence_elapsed_ms = Date.parse(phase.quiescence_ended_at) - Date.parse(phase.quiescence_started_at);
      const directedTurns = acceptedTurns - idleTurns;
      phase.abort_issued_at = new Date().toISOString();
      phase.abort_reason = 'directed observation complete';
      streamAbort.abort(new Error('directed observation complete'));
      await bounded(streamPromise.catch((error) => {
        if (!/abort|directed observation complete/i.test(error?.message ?? '')) throw error;
      }), 'stream shutdown');
      phase.stream_shutdown_clean = true;
      streamPromise = undefined;

      requestPhase = 'post_abort_directed_drain';
      phase.directed_drain = 'started';
      const directedDrain = await drainUnread(20).then((value) => {
        phase.directed_drain = 'succeeded';
        return value;
      }, (error) => {
        phase.directed_drain = 'failed';
        throw error;
      });
      requestPhase = 'burst';
      const directedOccurrences = directedDrain.entries.filter((entry) => entry.id === directed.id).length;
      const expectedEntries: Array<{ id: string; created_at: string }> = [];
      const authenticatedWriterIds = new Set<string>();
      for (let offset = 0; offset < 150; offset += 30) {
        const batch = Array.from({ length: Math.min(30, 150 - offset) }, (_, index) => {
          const sequence = offset + index;
          return append(
            writerRefs[sequence % writerRefs.length].session_credential,
            `s4-burst-${String(sequence).padStart(3, '0')}-${randomUUID()}`,
          );
        });
        for (const entry of await bounded(Promise.all(batch), `burst batch ${offset / 30 + 1}`)) {
          if (typeof entry.drone_id !== 'string' || !UUID_RE.test(entry.drone_id)) {
            throw new Error('burst append response omitted a valid authenticated writer drone_id');
          }
          if (typeof entry.id !== 'string' || typeof entry.created_at !== 'string') {
            throw new Error('burst append response omitted a canonical entry ordering tuple');
          }
          expectedEntries.push({ id: entry.id, created_at: entry.created_at });
          authenticatedWriterIds.add(entry.drone_id);
        }
      }

      const burstDrain = await drainUnread(17);
      const expectedIds = expectedEntries.map((entry) => entry.id);
      const expected = new Set(expectedIds);
      const drainedIds = burstDrain.entries.map((entry) => entry.id);
      const drainedExpected = drainedIds.filter((id) => expected.has(id));
      const unique = new Set(drainedExpected);
      const missing = expectedIds.filter((id) => !unique.has(id));
      const duplicates = drainedExpected.length - unique.size;
      const unexpected = drainedIds.filter((id) => !expected.has(id));
      const expectedOrder = [...expectedEntries].sort(compareEntryOrder).map((entry) => entry.id);
      const orderMismatchCount = Math.max(expectedOrder.length, drainedIds.length) -
        expectedOrder.filter((id, index) => drainedIds[index] === id).length;
      const burstOrderExact = orderMismatchCount === 0;
      const resets = transportErrors.filter((error) => error.code === 'ECONNRESET');
      const allRequestsSameOrigin = requestUrls.every((value) => new URL(value).origin === origin);
      const configuredWriterIds = new Set(writerRefs.map((ref) => ref.drone_id));
      const writerIdsMatchConfigured = authenticatedWriterIds.size === configuredWriterIds.size &&
        [...authenticatedWriterIds].every((id) => configuredWriterIds.has(id));
      const expectedAbort = phase.stream_error?.origin === 'iterator' && phase.stream_error.code === ABORT_CODE &&
        phase.stream_error.message === ABORT_MESSAGE;
      const phaseComplete = phase.stream_headers_ready_at !== null && !phase.deadline_fired &&
        phase.directed_append_succeeded && phase.directed_turn_count === 1 &&
        phase.quiescence_started_at !== null && phase.quiescence_ended_at !== null &&
        Date.parse(phase.quiescence_ended_at) > Date.parse(phase.quiescence_started_at) &&
        phase.quiescence_elapsed_ms !== null && phase.quiescence_elapsed_ms >= 6_000 &&
        phase.wall_quiescence_elapsed_ms !== null && phase.wall_quiescence_elapsed_ms >= 6_000 &&
        phase.wall_quiescence_elapsed_ms === Date.parse(phase.quiescence_ended_at) - Date.parse(phase.quiescence_started_at) &&
        Math.abs(phase.wall_quiescence_elapsed_ms - phase.quiescence_elapsed_ms) <= QUIESCENCE_CLOCK_TOLERANCE_MS &&
        phase.abort_issued_at !== null && phase.abort_reason === 'directed observation complete' &&
        expectedAbort && phase.stream_shutdown_clean && phase.directed_drain === 'succeeded';
      const pass = proofComplete({
        idleTurns, idleLogStable, idleCursorStable, directedTurns, directedOccurrences,
        expected: expectedIds.length, writerCount: authenticatedWriterIds.size, writerIdsMatchConfigured,
        drained: drainedExpected.length, unique: unique.size, missing: missing.length,
        duplicates, unexpected: unexpected.length, orderExact: burstOrderExact,
        has429: statuses.has(429), resets: resets.length, transportErrors: transportErrors.length,
        requestErrors: phase.requests.length, forbiddenFetches: forbiddenFetchAttempts,
        sameOrigin: allRequestsSameOrigin, turnErrors: turnErrors.length, phaseComplete,
      });
      result = {
        schema_version: S4_SCHEMA_VERSION,
        pass,
        client_sha: EXPECTED_CLIENT_SHA,
        origin,
        simulated_idle_ms: 2 * wake.CODEX_HEARTBEAT_CADENCE_MS,
        idle_accepted_model_turns: idleTurns,
        idle_log_before_count: idleLogBefore.entries.length,
        idle_log_after_count: idleLogAfter.entries.length,
        idle_log_before: idleLogBeforeSnapshot,
        idle_log_after: idleLogAfterSnapshot,
        idle_log_stable: idleLogStable,
        idle_cursor_before: idleCursorBefore ?? null,
        idle_cursor_after: idleCursorAfter ?? null,
        idle_cursor_stable: idleCursorStable,
        directed_items: 1,
        directed_accepted_model_turns: directedTurns,
        directed_unread_occurrences: directedOccurrences,
        authenticated_writer_ids: [...authenticatedWriterIds].sort(),
        validated_writer_refs: writerRefs.map(({ cube_id, drone_id, role_id, session_id }) => ({
          cube_id,
          drone_id,
          ...(role_id ? { role_id } : {}),
          ...(session_id ? { session_id } : {}),
        })),
        authenticated_writer_count: authenticatedWriterIds.size,
        writer_ids_match_configured: writerIdsMatchConfigured,
        burst_expected: expectedIds.length,
        burst_drained: drainedExpected.length,
        burst_unique: unique.size,
        order_expected_count: expectedOrder.length,
        order_mismatch_count: orderMismatchCount,
        burst_order_exact: burstOrderExact,
        drain_pages: burstDrain.pages,
        missing_ids: missing,
        duplicate_count: duplicates,
        unexpected_ids: unexpected,
        status_counts: Object.fromEntries([...statuses].sort(([a], [b]) => a - b)),
        http_429_count: statuses.get(429) ?? 0,
        econnreset_count: resets.length,
        transport_errors: transportErrors,
        forbidden_fetch_attempts: forbiddenFetchAttempts,
        all_requests_same_origin: allRequestsSameOrigin,
        phase_complete: phaseComplete,
        turn_validation_errors: turnErrors,
        app_server_methods: methods,
        phase,
      };
    } catch (error) {
      operationError = error;
    } finally {
      await cleanupJoinedFixture({
        streamAbort,
        streamPromise,
        sockets,
        appServer,
        runtimeDir,
        restoreAgentTrace,
      });
    }

    const cleanupVerified = !existsSync(runtimeDir) && sockets.size === 0;
    if (operationError) {
      const failureOutput = normalizedFailureOutput(origin, cleanupVerified, operationError);
      expect(isS4CoupledOutput(failureOutput)).toBe(true);
      console.log(serializeS4Output(failureOutput));
      throw operationError;
    }
    const output = {
      ...result,
      pass: result?.pass === true && cleanupVerified,
      cleanup_verified: cleanupVerified,
    };
    if (!validateS4CoupledE2EOutput(output)) {
      throw new Error('final S4 coupled E2E output failed the success schema');
    }
    console.log(serializeS4Output(output));

    expect(validateS4CoupledE2EOutput(output)).toBe(true);
    expect(isS4CoupledOutput(output)).toBe(true);
    expect(output).toMatchObject({
      pass: true,
      idle_accepted_model_turns: 0,
      idle_log_stable: true,
      idle_cursor_stable: true,
      directed_accepted_model_turns: 1,
      directed_unread_occurrences: 1,
      burst_expected: 150,
      burst_drained: 150,
      burst_unique: 150,
      order_expected_count: 150,
      order_mismatch_count: 0,
      burst_order_exact: true,
      missing_ids: [],
      duplicate_count: 0,
      unexpected_ids: [],
      http_429_count: 0,
      econnreset_count: 0,
      forbidden_fetch_attempts: 0,
      all_requests_same_origin: true,
      phase_complete: true,
      turn_validation_errors: [],
      cleanup_verified: true,
    });
    expect(output.authenticated_writer_count).toEqual(expect.any(Number));
    expect(output.authenticated_writer_count as number).toBeGreaterThanOrEqual(2);
  }, 45_000);
});
