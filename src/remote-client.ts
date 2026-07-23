/**
 * HTTP client for a verified local (self-hosted) Borg server.
 *
 * Handles:
 * - Pinned-TLS requests to the selected local server
 * - Drone-session / enrollment-credential injection
 * - Network failure handling with retry + exponential backoff
 *
 * There is no hosted-authority path: every request must carry verified local
 * server trust or it fails closed before any network or credential use.
 */

import {
  getServerCredential,
} from './config.js';
import { randomUUID } from 'node:crypto';
import {
  createProtocolEnvelope,
  decodeEvictDroneResult,
  decodeProtocolEnvelope,
  decodeProtocolErrorEnvelope,
  decodeReassignDroneResult,
  ErrorCode,
  type EvictDroneResult,
  type ReassignDroneResult,
} from 'borgmcp-shared/protocol';
import { consolePrefix } from './console-prefix.js';
import { debugLog } from './debug.js';
import { assertUuidShape } from './evict-drone.js';
import { DroneEvictedError, DRONE_EVICTED_CODE } from './drone-lifecycle.js';
import type { MessageTaxonomy, MessageTaxonomyClass } from 'borgmcp-shared/templates';
import { getTemplate, type Template, type TemplateRole } from 'borgmcp-shared/templates';
import { parseRoleSections } from 'borgmcp-shared/role-section';
import type { FragmentView, NonClobberSyncResult } from './sync-roles-render.js';
import type { WorkingRepo } from './working-repo.js';
import { loadBorgServerTrust, type ServerFetch } from './server-trust.js';
import {
  BorgServerError,
  BorgServerHttpError,
  BorgServerTrustError,
  BorgServerUnreachableError,
  LocalManageCredentialUnavailableError,
  LocalManageRequiredError,
} from './server-errors.js';
import { getActiveCube, type ActiveCube } from './cubes.js';
import {
  advanceLocalServerCursor,
  getLocalServerCursor,
  type LocalServerCursor,
} from './local-server-cursor.js';
import { readBoundedResponseBody } from './server-response.js';
import { resolveLocalLogRecipients } from './local-log-routing.js';

export interface RemoteConnection {
  apiUrl: string;
  authToken: string;
  serverTrustIdentity: string;
}

// gh#330: honor the server's Retry-After on 429 instead of failing the
// (often required) coordination signal outright. Bounded so a CLI call
// never blocks unboundedly; capped per attempt so a large window-reset
// retryAfter can't wedge the call.
const RATE_LIMIT_MAX_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_MS = 60_000; // cap a single Retry-After honor
export const LOCAL_SERVER_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
// A typed auth-error envelope is tiny; anything larger is hostile and the
// bounded read throws → the 401 fails closed to non-destructive CREDENTIAL_REJECTED.
const AUTH_ERROR_ENVELOPE_LIMIT_BYTES = 64 * 1024;
export const LOCAL_SERVER_REQUEST_TIMEOUT_MS = 5_000;
const LOCAL_SERVER_RESPONSE_LIMIT_MESSAGE =
  'Local Borg server response exceeded the response limit';

/**
 * Parse a `Retry-After` header (delta-seconds form, which the worker
 * emits — mcp-server.ts:382/583) into milliseconds. Returns null when
 * absent or not a non-negative integer count of seconds. (The HTTP-date
 * form is not emitted by the worker, so it is intentionally unhandled.)
 */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10) * 1000;
}

/**
 * How long to wait before the next 429 retry. Honors the server's
 * Retry-After when present (capped at `capMs` so a full-window reset
 * can't wedge a CLI call); falls back to an escalating 1s·(attempt+1)
 * when absent. Adds jitter (injected for tests) so co-located sibling
 * drones sharing one per-IP bucket don't retry in lockstep.
 */
export function rateLimitWaitMs(
  retryAfterMs: number | null,
  attempt: number,
  capMs: number = RATE_LIMIT_MAX_WAIT_MS,
  jitter: () => number = () => Math.random() * 500
): number {
  const base = retryAfterMs != null ? retryAfterMs : 1000 * (attempt + 1);
  return Math.min(base, capMs) + jitter();
}

/**
 * Given an ALREADY-OBTAINED response, while it is a 429 and retries
 * remain, wait per `rateLimitWaitMs` (honoring the CURRENT response's
 * Retry-After) and THEN re-run `doRequest`. Takes `initialResponse`
 * (not a first request) because the caller has already made the request
 * and read its status — re-fetching first would ignore the first 429's
 * Retry-After and double-fire an immediate extra request (CR blocker
 * d3a564f5). Returns the last Response (200-class on success, or a final
 * 429 if retries exhaust — the caller surfaces that). `sleep` is
 * injected for deterministic tests; no fetch-global mocking required.
 */
export async function retryOn429(
  initialResponse: Response,
  doRequest: () => Promise<Response>,
  opts: {
    maxRetries?: number;
    capMs?: number;
    sleep: (ms: number) => Promise<void>;
    jitter?: () => number;
    log?: (msg: string) => void;
  }
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  let response = initialResponse;
  let attempt = 0;
  while (response.status === 429 && attempt < maxRetries) {
    // Honor THIS 429's Retry-After BEFORE issuing the next request.
    const waitMs = rateLimitWaitMs(
      parseRetryAfterMs(response.headers.get('Retry-After')),
      attempt,
      opts.capMs,
      opts.jitter
    );
    opts.log?.(
      `rate limited (429); retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`
    );
    await opts.sleep(waitMs);
    attempt++;
    response = await doRequest();
  }
  return response;
}

async function localAuthorityContext(
  sessionToken: string,
  apiUrl: string,
  expectedServerTrustIdentity?: string,
): Promise<ActiveCube> {
  const active = await getActiveCube();
  const matched = active?.serverTrustIdentity !== undefined &&
    active.apiUrl === apiUrl &&
    active.sessionToken === sessionToken
    ? active
    : null;
  if (!matched) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  assertUuidShape(matched.cubeId, 'cube_id');
  assertUuidShape(matched.droneId, 'drone_id');
  if (expectedServerTrustIdentity !== undefined) {
    if (matched.serverTrustIdentity !== expectedServerTrustIdentity) {
      throw new Error('Selected Borg server authority state is missing or unreadable');
    }
    return matched;
  }
  // Only a hydrated local ActiveCube carrying the verified trust anchor
  // authorizes the request. cubes.json is mutable local state and a
  // legacy-looking sessionToken proves nothing — fail closed before any
  // network use when no verified local authority is present.
  return matched;
}

function localUnsupported(capability: string): never {
  throw new Error(`Local Borg server does not support ${capability}`);
}

function waitForLocalRequest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function decodeLocalProtocolResponse<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  allowNoContent: boolean,
  decodePayload: (value: unknown) => T = (value) => value as T,
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Local Borg server request timed out'));
  }, LOCAL_SERVER_REQUEST_TIMEOUT_MS);
  try {
    const response = await waitForLocalRequest(request(controller.signal), controller.signal);
    if (response.status === 204 && allowNoContent) return null;

    const encoded = await readBoundedResponseBody(
      response,
      LOCAL_SERVER_RESPONSE_LIMIT_BYTES,
      LOCAL_SERVER_RESPONSE_LIMIT_MESSAGE,
      controller.signal,
    );
    let body: unknown;
    try {
      body = JSON.parse(encoded);
    } catch {
      throw new Error('Local Borg server returned an invalid protocol envelope');
    }
    return decodeProtocolEnvelope(body, decodePayload).payload;
  } catch (error) {
    if (controller.signal.aborted) {
      // CR5: a TYPED transport-timeout verdict (message kept for call-site parity).
      throw new BorgServerUnreachableError('Local Borg server request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function localServerRequest<T>(
  active: ActiveCube,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  payload?: Record<string, unknown>,
): Promise<T | null> {
  return decodeLocalProtocolResponse<T>((signal) => authedFetch(path, {
      method,
      signal,
      droneSession: active.sessionToken,
      apiUrl: active.apiUrl,
      serverTrustIdentity: active.serverTrustIdentity,
      redirect: 'error',
      ...(payload === undefined
        ? { headers: { Accept: 'application/json' } }
        : {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(createProtocolEnvelope(randomUUID(), payload)),
        }),
    }), true);
}

export interface LocalManageOperation {
  operation: string;
  cubeName: string;
  noMutation: string;
}

export interface LocalManageAuthority {
  active: ActiveCube;
  connection: RemoteConnection;
}

function manageCopyValue(value: string): string {
  return JSON.stringify(value);
}

async function localManageConnection(
  active: ActiveCube,
  operation: LocalManageOperation,
): Promise<RemoteConnection> {
  const trustIdentity = active.serverTrustIdentity;
  if (!trustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  let authToken: string | null;
  try {
    authToken = await getServerCredential(active.apiUrl, trustIdentity);
  } catch {
    throw new LocalManageCredentialUnavailableError(
      operation.operation,
      operation.cubeName,
      operation.noMutation,
    );
  }
  if (!authToken) {
    throw new LocalManageCredentialUnavailableError(
      operation.operation,
      operation.cubeName,
      operation.noMutation,
    );
  }
  return { apiUrl: active.apiUrl, authToken, serverTrustIdentity: trustIdentity };
}

export async function resolveLocalManageAuthority(
  active: ActiveCube,
  operation: LocalManageOperation,
): Promise<LocalManageAuthority> {
  return { active, connection: await localManageConnection(active, operation) };
}

async function localManageRequest<T>(
  active: ActiveCube,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  operation: LocalManageOperation,
  payload?: Record<string, unknown>,
  decodePayload?: (value: unknown) => T,
  connectionOverride?: RemoteConnection,
): Promise<T | null> {
  const connection = connectionOverride ?? await localManageConnection(active, operation);
  try {
    return await decodeLocalProtocolResponse<T>((signal) => authedFetch(path, {
      method,
      signal,
      apiUrl: connection.apiUrl,
      authToken: connection.authToken,
      serverTrustIdentity: connection.serverTrustIdentity,
      redirect: 'error',
      ...(payload === undefined
        ? { headers: { Accept: 'application/json' } }
        : {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(createProtocolEnvelope(randomUUID(), payload)),
        }),
    }), true, decodePayload);
  } catch (error) {
    if (
      error instanceof BorgServerHttpError &&
      error.status === 403 &&
      error.code === ErrorCode.ACCESS_DENIED
    ) {
      throw new LocalManageRequiredError(
        operation.operation,
        operation.cubeName,
        operation.noMutation,
      );
    }
    throw error;
  }
}

async function localConnectionRequest<T>(
  connection: RemoteConnection,
  path: string,
): Promise<T> {
  return decodeLocalProtocolResponse<T>((signal) => authedFetch(path, {
    method: 'GET',
    signal,
    apiUrl: connection.apiUrl,
    authToken: connection.authToken,
    serverTrustIdentity: connection.serverTrustIdentity,
    redirect: 'error',
    headers: { Accept: 'application/json' },
  }), false) as Promise<T>;
}

async function localConnectionMutation<T>(
  connection: RemoteConnection,
  path: string,
  method: 'POST' | 'PATCH',
  payload: Record<string, unknown>,
): Promise<T> {
  return decodeLocalProtocolResponse<T>((signal) => authedFetch(path, {
    method,
    signal,
    apiUrl: connection.apiUrl,
    authToken: connection.authToken,
    serverTrustIdentity: connection.serverTrustIdentity,
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(createProtocolEnvelope(randomUUID(), payload)),
  }), false) as Promise<T>;
}

async function localOwnerConnection(connection?: RemoteConnection): Promise<RemoteConnection> {
  if (connection) return connection;
  const active = await getActiveCube();
  if (!active?.serverTrustIdentity) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const authToken = await getServerCredential(active.apiUrl, active.serverTrustIdentity);
  if (!authToken) throw new Error('No credential is stored for the selected Borg server identity');
  return {
    apiUrl: active.apiUrl,
    authToken,
    serverTrustIdentity: active.serverTrustIdentity,
  };
}

async function localCubeComposition(active: ActiveCube): Promise<{
  cube: any;
  roles: any[];
  drones: any[];
  role: any;
  drone: any;
}> {
  const base = `/api/cubes/${active.cubeId}`;
  const [cubePayload, rolePayload, dronePayload] = await Promise.all([
    localServerRequest<{ cube: any }>(active, base, 'GET'),
    localServerRequest<{ roles: any[] }>(active, `${base}/roles`, 'GET'),
    localServerRequest<{ drones: any[] }>(active, `${base}/drones`, 'GET'),
  ]);
  if (!cubePayload || !rolePayload || !dronePayload) {
    throw new Error('Local Borg server returned an incomplete cube response');
  }
  const drone = dronePayload.drones.find((candidate) => candidate.id === active.droneId);
  const role = rolePayload.roles.find((candidate) => candidate.id === drone?.role_id);
  if (!drone || !role) throw new Error('Local Borg server no longer recognizes this drone seat');
  return {
    cube: cubePayload.cube,
    roles: rolePayload.roles,
    drones: dronePayload.drones,
    role,
    drone,
  };
}

function localCursorBinding(active: ActiveCube) {
  return {
    origin: active.apiUrl,
    trustIdentity: active.serverTrustIdentity!,
    cubeId: active.cubeId,
    droneId: active.droneId,
  };
}

async function localReadLogPage(
  active: ActiveCube,
  opts: { cursor?: LocalServerCursor | null; limit?: number } = {},
): Promise<any> {
  const payload = await localServerRequest<any>(
    active,
    `/api/cubes/${active.cubeId}/logs`,
    'PUT',
    {
      cursor: opts.cursor ?? null,
      ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    },
  );
  if (!payload) throw new Error('Local Borg server returned an empty log response');
  return payload;
}

interface PendingWakePage {
  entries: Array<{
    drone_id?: unknown;
    message?: unknown;
    visibility?: unknown;
    recipient_drone_ids?: unknown;
  }>;
  cursor: LocalServerCursor | null;
  has_more: boolean;
}

function isPendingWakeEntry(
  entry: PendingWakePage['entries'][number],
  droneId: string,
): boolean {
  if (entry.visibility === 'direct') {
    const recipients = Array.isArray(entry.recipient_drone_ids)
      ? entry.recipient_drone_ids.filter((recipient): recipient is string => typeof recipient === 'string')
      : [];
    if (!recipients.includes(droneId)) return false;
  }

  const isHeartbeatPing =
    typeof entry.message === 'string' && entry.message.startsWith('[HEARTBEAT-PING]');
  return entry.drone_id !== droneId || isHeartbeatPing;
}

/**
 * client#76: inspect authoritative unread log state without advancing the
 * agent-owned unread cursor. The scan mirrors the SSE wake filters: unaddressed
 * direct entries and ordinary own posts are not work for this seat. A full
 * paginated scan prevents a run of skipped entries from hiding later real work.
 */
export async function hasPendingWakeActivity(
  active: ActiveCube,
  deps: {
    getCursor?: typeof getLocalServerCursor;
    readPage?: (active: ActiveCube, opts: { cursor: LocalServerCursor | null; limit: number }) => Promise<PendingWakePage>;
  } = {},
): Promise<boolean> {
  if (!active.serverTrustIdentity) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }

  const getCursor = deps.getCursor ?? getLocalServerCursor;
  const readPage = deps.readPage ?? localReadLogPage;
  let cursor = await getCursor(localCursorBinding(active));

  for (;;) {
    const page: PendingWakePage = await readPage(active, { cursor, limit: 500 });
    if (page.entries.some((entry) => isPendingWakeEntry(entry, active.droneId))) return true;
    if (!page.has_more) return false;
    if (!page.cursor ||
      (cursor && page.cursor.id === cursor.id && page.cursor.created_at === cursor.created_at)) {
      throw new Error('Local Borg server returned a non-advancing log cursor');
    }
    cursor = page.cursor;
  }
}

async function resolveLocalLogCursor(
  active: ActiveCube,
  since: string,
): Promise<LocalServerCursor | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(since);
  const timestamp = isUuid ? null : Date.parse(since);
  if (!isUuid && (!Number.isFinite(timestamp) || new Date(timestamp!).toISOString() !== since)) {
    throw new Error('Invalid local Borg server log cursor');
  }

  let scanCursor: LocalServerCursor | null = null;
  let timestampCursor: LocalServerCursor | null = null;
  for (;;) {
    const page = await localReadLogPage(active, { cursor: scanCursor, limit: 500 });
    for (const entry of page.entries as any[]) {
      if (isUuid && entry.id === since) {
        return { id: entry.id, created_at: entry.created_at };
      }
      if (!isUuid) {
        if (entry.created_at > since) return timestampCursor;
        timestampCursor = { id: entry.id, created_at: entry.created_at };
      }
    }
    if (!page.has_more || !page.cursor) {
      if (isUuid) throw new Error('Local Borg server log cursor was not found');
      return timestampCursor;
    }
    scanCursor = page.cursor;
  }
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Authenticated fetch helper.
 *
 * Adds the Bearer token + optional drone-session header, parses errors
 * consistently, and surfaces a re-auth recovery message ("Run: borg setup")
 * on auth failure (gh#780/#794 — never `borg assimilate`, which rides the same
 * broken Bearer).
 *
 * Accepts an optional `apiUrl` override so already-assimilated callers can
 * route to the worker that issued their drone session token, regardless of
 * what BORG_API_URL was set to when this process started.
 */
async function authedFetch(
  path: string,
  init: RequestInit & {
    droneSession?: string;
    apiUrl?: string;
    authToken?: string;
    serverTrustIdentity?: string;
  } = {}
): Promise<Response> {
  const {
    droneSession,
    apiUrl,
    authToken,
    serverTrustIdentity: suppliedTrustIdentity,
    headers,
    ...rest
  } = init;
  if (apiUrl === undefined) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const baseUrl = apiUrl;
  if (suppliedTrustIdentity === undefined) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const serverTrustIdentity = suppliedTrustIdentity;
  if (!/^\/api\/cubes(?:\/|$)/.test(path)) {
    localUnsupported(`the ${path} capability`);
  }
  let requestFetch: ServerFetch;
  let token: string;
  {
    const trust = await loadBorgServerTrust(baseUrl);
    if (trust.identity !== serverTrustIdentity) {
      // CR5: a TYPED terminal trust verdict — never inferred from error text.
      throw new BorgServerTrustError('Borg server trust identity changed; refusing the connection');
    }
    requestFetch = trust.fetchImpl;
    if (droneSession !== undefined) {
      // Local attach credentials are already cube/drone-scoped Bearers. The
      // server authenticates this single narrower principal directly.
      token = droneSession;
    } else if (authToken !== undefined) {
      token = authToken;
    } else {
      const stored = await getServerCredential(baseUrl, serverTrustIdentity);
      if (!stored) {
        throw new Error('No credential is stored for the selected Borg server identity');
      }
      token = stored;
    }
  }

  const method = ((rest.method as string | undefined) ?? 'GET').toUpperCase();

  const buildRequest = async (tok: string): Promise<Response> => {
    const finalHeaders: Record<string, string> = {
      'Authorization': `Bearer ${tok}`,
      ...(headers as Record<string, string> | undefined),
    };
    // --debug / BORG_DEBUG: trace every HTTP attempt. Logs method/path/status
    // ONLY — never the Authorization header or any token material.
    debugLog(`→ ${method} ${path}`);
    const res = await requestFetch(`${baseUrl}${path}`, {
      ...rest,
      headers: finalHeaders,
    });
    debugLog(`← ${res.status} ${method} ${path}`);
    return res;
  };

  const response = await buildRequest(token);

  if (response.status === 401) {
    // Reached only after pinned-TLS trust is verified (localAuthorityContext
    // fails closed otherwise). The DESTRUCTIVE worktree-seat reset is permitted
    // ONLY when BOTH hold: (a) this request used the drone SESSION bearer, and
    // (b) the server's bounded-decoded shared-v2 error envelope carries the EXACT
    // typed code SESSION_REJECTED. A bare 401 is never sufficient. Any other or
    // absent/malformed/oversized code — or a parent enrollment/client credential
    // (authToken/stored) — is CREDENTIAL_REJECTED → non-destructive re-enroll
    // recovery, never a seat reset. The body is read (and thus consumed) here,
    // bounded to reject oversized hostile payloads (fail closed to non-reset).
    let rejectedCode: ErrorCode | undefined;
    try {
      const body = await readBoundedResponseBody(
        response,
        AUTH_ERROR_ENVELOPE_LIMIT_BYTES,
        'Local Borg server auth error response exceeded the response limit',
      );
      rejectedCode = decodeProtocolErrorEnvelope(JSON.parse(body)).error.code;
    } catch {
      rejectedCode = undefined;
    }
    if (droneSession !== undefined && rejectedCode === ErrorCode.SESSION_REJECTED) {
      throw new BorgServerError(
        'SESSION_REJECTED',
        'the selected Borg server superseded this worktree session with a newer enrollment',
      );
    }
    if (droneSession !== undefined && rejectedCode === ErrorCode.SESSION_REVOKED) {
      throw new BorgServerError(
        'SESSION_REVOKED',
        'the selected Borg server revoked this worktree session',
      );
    }
    throw new BorgServerError(
      'CREDENTIAL_REJECTED',
      'the selected Borg server rejected the credential',
    );
  }

  if (!response.ok) {
    // Do not copy a server response body into errors or debug output: a malicious or
    // misconfigured server could reflect bearer/invitation material or inject
    // terminal controls. Decode only the bounded protocol error code for typed
    // branching; never surface the server-provided message or details.
    let code: ErrorCode | undefined;
    try {
      const body = await readBoundedResponseBody(
        response,
        AUTH_ERROR_ENVELOPE_LIMIT_BYTES,
        'Local Borg server error response exceeded the response limit',
      );
      code = decodeProtocolErrorEnvelope(JSON.parse(body)).error.code;
    } catch {
      code = undefined;
    }
    debugLog(`✗ ${response.status} ${method} ${path}`);
    if (droneSession !== undefined && response.status === 410 && code === DRONE_EVICTED_CODE) {
      throw new DroneEvictedError();
    }
    throw new BorgServerHttpError(
      response.status,
      `Borg server request failed (HTTP ${response.status})`,
      code,
    );
  }

  return response;
}

/**
 * Get the active cube's directive + role registry.
 */
export async function getCubeInfo(
  sessionToken: string,
  apiUrl: string,
  serverTrustIdentity?: string,
): Promise<{ cube: any; roles: any[] }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  const composed = await localCubeComposition(local);
  return { cube: composed.cube, roles: composed.roles };
}

/**
 * Get this drone's assigned role (with detailed_description).
 */
export async function getRoleInfo(
  sessionToken: string,
  apiUrl: string,
  serverTrustIdentity?: string,
): Promise<{ role: any }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  return { role: (await localCubeComposition(local)).role };
}

/**
 * Get a named role's full playbook (detailed_description). Any drone in
 * the cube may read any role. `role` is a role name (case-insensitive)
 * or role id.
 */
export async function getRoleInfoByName(
  sessionToken: string,
  apiUrl: string,
  role: string,
  serverTrustIdentity?: string,
): Promise<{ role: any }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  const roles = (await localCubeComposition(local)).roles;
  const matched = roles.find((candidate) =>
    candidate.id === role || candidate.name.toLowerCase() === role.toLowerCase()
  );
  if (!matched) throw new Error(`Local Borg server has no role named ${JSON.stringify(role)}`);
  return { role: matched };
}

export async function whoami(
  sessionToken: string,
  apiUrl: string,
  serverTrustIdentity?: string,
): Promise<{ cube_id: string; cube_name: string; drone_id: string; drone_label: string; role_id: string; role_name: string }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  const composed = await localCubeComposition(local);
  return {
    cube_id: composed.cube.id,
    cube_name: composed.cube.name,
    drone_id: composed.drone.id,
    drone_label: composed.drone.label,
    role_id: composed.role.id,
    role_name: composed.role.name,
  };
}

/**
 * List all currently-connected drones in this cube.
 *
 * Optional `since` is the T2.1 sender-side liveness probe — pass either
 * an activity_log entry id (UUID; server resolves to its `created_at`)
 * OR an ISO-8601 timestamp. When provided, the response includes:
 *   - per-drone `seen_since: boolean` — true iff that drone's
 *     `last_seen` is strictly after the resolved timestamp
 *   - top-level `since: ISO-string | null` — the resolved timestamp
 *     (echoed back so the renderer can label the column accurately
 *     even when the caller passed an entry-id)
 */
export async function getRoster(
  sessionToken: string,
  apiUrl: string,
  since?: string,
  serverTrustIdentity?: string,
): Promise<{ drones: any[]; roles: any[]; message_taxonomy?: MessageTaxonomy | null; since?: string | null }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  if (since !== undefined) {
    const [dronePayload, rolePayload, cubePayload] = await Promise.all([
      localServerRequest<{ drones: any[]; since?: string | null }>(
        local,
        `/api/cubes/${local.cubeId}/drones?since=${encodeURIComponent(since)}`,
        'GET',
      ),
      localServerRequest<{ roles: any[] }>(local, `/api/cubes/${local.cubeId}/roles`, 'GET'),
      localServerRequest<{ cube: any }>(local, `/api/cubes/${local.cubeId}`, 'GET'),
    ]);
    if (!dronePayload || !rolePayload || !cubePayload) {
      throw new Error('Local Borg server returned an incomplete roster response');
    }
    return {
      drones: dronePayload.drones,
      roles: rolePayload.roles,
      message_taxonomy: cubePayload.cube.message_taxonomy ?? null,
      since: dronePayload.since ?? since,
    };
  }
  const composed = await localCubeComposition(local);
  return {
    drones: composed.drones,
    roles: composed.roles,
    message_taxonomy: composed.cube.message_taxonomy ?? null,
  };
}

/**
 * Read recent log entries for the cube.
 */
export async function readLog(
  sessionToken: string,
  apiUrl: string,
  opts: {
    since?: string;
    limit?: number;
    unreadOnly?: boolean;
    serverTrustIdentity?: string;
  } = {}
): Promise<{ entries: any[]; drones: any[]; roles: any[]; behind_by?: number; has_more?: boolean }> {
  const local = await localAuthorityContext(
    sessionToken,
    apiUrl,
    opts.serverTrustIdentity,
  );
  let cursor: LocalServerCursor | null = null;
  if (opts.unreadOnly) cursor = await getLocalServerCursor(localCursorBinding(local));
  if (opts.since !== undefined) cursor = await resolveLocalLogCursor(local, opts.since);
  const page = await localReadLogPage(local, { cursor, limit: opts.limit });
  if (opts.unreadOnly && page.cursor) {
    await advanceLocalServerCursor(localCursorBinding(local), page.cursor);
  }
  const composed = await localCubeComposition(local);
  return {
    entries: page.entries,
    drones: composed.drones,
    roles: composed.roles,
    behind_by: page.behind_by,
    has_more: page.has_more,
  };
}

/**
 * Sprint 25 log substrate refactor: explicit ack on a log entry.
 *
 * Replaces in-band `ACK: <dispatch-id>` log entries with a DB-backed
 * flag on activity_log_acks. Idempotent — the server INSERT uses ON
 * CONFLICT DO NOTHING. 204 No Content on success.
 */
// 'claim' is advisory review-gate ownership; 'ack' preserves the original wire default.
export async function ackLogEntry(
  sessionToken: string,
  apiUrl: string,
  entryId: string,
  kind: 'ack' | 'claim' = 'ack',
  serverTrustIdentity?: string,
): Promise<void> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  await localServerRequest(
    local,
    `/api/cubes/${local.cubeId}/acks`,
    'POST',
    { entry_id: entryId, kind },
  );
}

/** Record a ratified cube decision using the local client's cube-manage grant. */
export async function recordDecision(
  sessionToken: string,
  apiUrl: string,
  input: { topic: string; decision: string; rationale?: string },
  serverTrustIdentity?: string,
): Promise<{ decision: any }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  const payload = await localManageRequest<{ decision: any }>(
    local,
    `/api/cubes/${local.cubeId}/decisions`,
    'POST',
    {
      operation: `record a decision in cube ${manageCopyValue(local.name)}`,
      cubeName: local.name,
      noMutation: 'Nothing was recorded.',
    },
    input,
  );
  if (!payload) throw new Error('Local Borg server returned an empty decision response');
  return payload;
}

/**
 * gh#740: list active ratified decisions for the cube (any member). With
 * `topic`, returns that topic's active decision.
 */
export async function listDecisions(
  sessionToken: string,
  apiUrl: string,
  topic?: string,
  serverTrustIdentity?: string,
): Promise<{ decisions: any[] }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  const payload = await localServerRequest<{ decisions: any[] }>(
    local,
    `/api/cubes/${local.cubeId}/decisions`,
    'PUT',
    {},
  );
  if (!payload) throw new Error('Local Borg server returned an empty decisions response');
  return {
    decisions: topic === undefined
      ? payload.decisions
      : payload.decisions.filter((decision) => decision.topic === topic),
  };
}

/** Remove one active ratified decision. The worker enforces the seat gate. */
export async function removeDecision(
  sessionToken: string,
  apiUrl: string,
  selector: { topic: string } | { decision_id: string },
  serverTrustIdentity?: string,
): Promise<{ decision: any }> {
  void sessionToken;
  void apiUrl;
  void selector;
  void serverTrustIdentity;
  localUnsupported('decision removal');
}

/**
 * Regen: one-shot composite of everything a drone needs to be oriented.
 *
 * Returns the active cube's directive, the drone's own role with full
 * detailed_description, the public role registry (no detailed_description
 * leakage for OTHER roles), the drone roster, and the caller's unread-log
 * COUNT (behind_by). gh#886: the recent-log PAYLOAD is no longer rendered
 * client-side — the drone gets the count and drains via borg_read-log. Use
 * on session start and before each new task to stay in sync.
 *
 * gh#29 Sprint C / Q3a: optional `since` cursor (entry-id UUID or
 * ISO-8601 timestamp). The worker still ships `recentLog` for rollout-compat
 * (a pre-gh#886 client renders it; `since` trims it to entries strictly after
 * the anchor) — but the current client renders the unread COUNT, not the
 * payload, so `since` no longer affects what this client shows.
 */
export async function regen(
  sessionToken: string,
  apiUrl: string,
  opts: {
    since?: string;
    /** Advisory self-report from the running agent; never model-routing config. */
    reportedModel?: string;
    /** Current cwd-derived identity; refreshed each regen to avoid stale routing data. */
    workingRepo?: WorkingRepo;
    /** Verified self-hosted authority from the caller's first active-state read. */
    serverTrustIdentity?: string;
  } = {}
): Promise<{
  cube: any;
  role: any;
  drone: any;
  roles: any[];
  drones: any[];
  // gh#886: recentLog kept for rollout-compat (worker still sends it); the
  // client no longer renders it. behind_by is the caller's unread count the
  // client renders as a drain instruction. Optional — absent from pre-gh#886
  // workers (client falls back to rendering recentLog).
  recentLog?: any[];
  behind_by?: number;
  // gh#740: active ratified decisions for the cube, rendered by regen-format.
  // Local regen composes these via listDecisions.
  decisions?: any[];
}> {
  const local = await localAuthorityContext(
    sessionToken,
    apiUrl,
    opts.serverTrustIdentity,
  );
  const composed = await localCubeComposition(local);
  const cursor = opts.since === undefined
    ? await getLocalServerCursor(localCursorBinding(local))
    : await resolveLocalLogCursor(local, opts.since);
  const page = await localReadLogPage(local, { cursor, limit: 1 });
  let decisions: any[] = [];
  try {
    decisions = (await listDecisions(
      sessionToken,
      apiUrl,
      undefined,
      opts.serverTrustIdentity,
    )).decisions;
  } catch (error) {
    console.warn(
      `Local regen: failed to fetch ratified decisions (${error instanceof Error ? error.message : String(error)}); continuing without them.`,
    );
  }
  return {
    cube: composed.cube,
    role: composed.role,
    drone: composed.drone,
    roles: composed.roles,
    drones: composed.drones,
    recentLog: [],
    behind_by: page.entries.length + page.behind_by,
    decisions,
  };
}

export async function roleRationale(
  sessionToken: string,
  apiUrl: string,
  role: string,
  section: string,
  serverTrustIdentity?: string,
): Promise<{ role: string; section: string; body: string }> {
  void sessionToken;
  void apiUrl;
  void role;
  void section;
  void serverTrustIdentity;
  localUnsupported('role rationale sections');
}

/**
 * Append a message to the cube's shared activity log.
 */
export async function appendLog(
  sessionToken: string,
  apiUrl: string,
  message: string,
  opts: {
    visibility?: 'broadcast' | 'direct';
    recipientDroneIds?: string[];
    class?: string;
    to?: string[];
    serverTrustIdentity?: string;
  } = {}
): Promise<{
  entry: {
    id: string;
    cube_id: string;
    drone_id: string;
    message: string;
    visibility: 'broadcast' | 'direct';
    created_at: string;
  };
  routing?: {
    class: string | null;
    recipients: string[];
    fellOpen: boolean;
    message: string | null;
  } | null;
  // gh#534: directed recipients currently unreachable via the wake path
  // (wake-path:deaf). Empty/absent for broadcast or all-reachable sends.
  unreachableRecipients?: { id: string; label: string }[];
}> {
  if (opts.visibility === 'broadcast' && (opts.to?.length ?? 0) > 0) {
    throw new Error(
      "Invalid input: visibility:'broadcast' cannot be combined with non-empty to:. " +
      'Remove visibility to direct to recipients, or remove to: to broadcast.',
    );
  }
  const local = await localAuthorityContext(
    sessionToken,
    apiUrl,
    opts.serverTrustIdentity,
  );
  let visibility = opts.visibility;
  let recipientDroneIds = opts.recipientDroneIds;
    if (visibility !== 'broadcast' &&
        (!recipientDroneIds || recipientDroneIds.length === 0) &&
        opts.to !== undefined) {
      const base = `/api/cubes/${local.cubeId}`;
      const [rolePayload, dronePayload] = await Promise.all([
        localServerRequest<{ roles: any[] }>(local, `${base}/roles`, 'GET'),
        localServerRequest<{ drones: any[] }>(local, `${base}/drones`, 'GET'),
      ]);
      if (!rolePayload || !dronePayload) {
        throw new Error('Local Borg server returned an incomplete cube roster');
      }
      recipientDroneIds = resolveLocalLogRecipients(
        opts.to,
        dronePayload.drones,
        rolePayload.roles,
      );
      visibility = 'direct';
    } else if (visibility === undefined && recipientDroneIds !== undefined) {
      visibility = 'direct';
    }
    const payload = await localServerRequest<{ entry: any }>(
      local,
      `/api/cubes/${local.cubeId}/logs`,
      'POST',
      {
        message,
        ...(visibility ? { visibility } : {}),
        ...(visibility === 'direct' && recipientDroneIds
          ? { recipientDroneIds }
          : {}),
        // server#48 append-time taxonomy routing: forward the requested class
        // so the server can classify/route. It is honored only when no explicit
        // visibility/recipients override it (server resolveMessageRouting).
        ...(opts.class ? { class: opts.class } : {}),
      },
    );
    if (!payload) throw new Error('Local Borg server returned an empty log response');
  return { entry: payload.entry };
}

/**
 * List cubes readable by the local client's live grants.
 */
export async function listCubes(connection?: RemoteConnection): Promise<{ cubes: any[] }> {
  return localConnectionRequest<{ cubes: any[] }>(await localOwnerConnection(connection), '/api/cubes');
}

/**
 * List bundled cube templates. Used by the `borg assimilate` orchestrator
 * to surface the interactive template prompt on first-drone bootstrap.
 */
/**
 * Create a new cube. Server-side seeds a default "Drone" role atomically
 * so the cube is assimilatable immediately, OR applies the named template
 * atomically when `opts.template` is set (single-withUserId transaction —
 * skips the auto-Drone insert to avoid is_default partial-index conflict).
 *
 * Returns `{ cube, roles }` — the roles array lets the assimilate
 * orchestrator pick a default role without a follow-up `getCube` call.
 * Existing callers that read `body.cube` keep working (forward-compat).
 */
export async function createCube(
  name: string | undefined,
  cubeDirective: string,
  opts?: { template?: string; message_taxonomy?: MessageTaxonomy | null },
  connection?: RemoteConnection,
): Promise<{ id: string; name: string; cube_directive?: string; roles: any[]; drones?: any[]; [k: string]: any }> {
  if (!name?.trim()) throw new Error('Local Borg server cube creation requires a cube name');
  if (opts?.template !== undefined && opts.template !== 'default') {
    throw new Error('Local Borg server supports only the default cube seed');
  }
  const resolved = await localOwnerConnection(connection);
  const created = await localConnectionMutation<{
    cube_id: string;
    human_seat_role_id: string;
    default_worker_role_id: string;
  }>(resolved, '/api/cubes', 'POST', {
    retry_key: randomUUID(),
    name: name.trim(),
    template: 'default',
  });
  if (!created?.cube_id) throw new Error('Local Borg server returned an invalid cube creation response');
  const patch: Record<string, unknown> = { cube_directive: cubeDirective };
  if (opts?.message_taxonomy !== undefined) patch.message_taxonomy = opts.message_taxonomy;
  await localConnectionMutation(resolved, `/api/cubes/${created.cube_id}`, 'PATCH', patch);
  return getCube(created.cube_id, resolved);
}

/**
 * Update a cube's name and/or cube_directive. Both fields are optional;
 * pass only what changes.
 */
export async function updateCube(
  cubeId: string,
  updates: { name?: string; cube_directive?: string; message_taxonomy?: MessageTaxonomy | null },
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ cube: any }> {
  assertUuidShape(cubeId, 'cube_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  if (updates.name !== undefined) localUnsupported('cube rename');
  const payload: Record<string, unknown> = {};
  if (updates.cube_directive !== undefined) payload.cube_directive = updates.cube_directive;
  if (Object.prototype.hasOwnProperty.call(updates, 'message_taxonomy')) {
    payload.message_taxonomy = updates.message_taxonomy ?? null;
  }
  const result = await localManageRequest<{ cube: any }>(
    active,
    `/api/cubes/${cubeId}`,
    'PATCH',
    {
      operation: `update cube settings in cube ${manageCopyValue(cubeId === active.cubeId ? active.name : cubeId)}`,
      cubeName: cubeId === active.cubeId ? active.name : cubeId,
      noMutation: 'No cube settings were changed.',
    },
    payload,
    undefined,
    connectionOverride,
  );
  if (!result) throw new Error('Local Borg server returned an empty cube response');
  return result;
}

/**
 * gh#473 PR1 — granular per-class taxonomy patch. Add / replace-by-name
 * / remove a single class within the cube's message_taxonomy, leaving
 * other classes unchanged. The server re-validates the full resulting
 * array and requires the selected local client's live cube-manage grant.
 */
export async function patchTaxonomyClass(
  cubeId: string,
  op:
    | { action: 'add'; class_def: MessageTaxonomyClass }
     | { action: 'replace'; class_def: MessageTaxonomyClass }
      | { action: 'remove'; class: string },
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ cube: any }> {
  assertUuidShape(cubeId, 'cube_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const className = op.action === 'remove' ? op.class : op.class_def.class;
  const preposition = op.action === 'add' ? 'to' : op.action === 'replace' ? 'in' : 'from';
  const pastTense = op.action === 'add' ? 'added' : op.action === 'replace' ? 'replaced' : 'removed';
  const cubeName = cubeId === active.cubeId ? active.name : cubeId;
  const result = await localManageRequest<{ cube: any }>(
    active,
    `/api/cubes/${cubeId}/taxonomy-patch`,
    'POST',
    {
      operation: `${op.action} message class ${manageCopyValue(className)} ${preposition} cube ${manageCopyValue(cubeName)}`,
      cubeName,
      noMutation: `No message class was ${pastTense}.`,
    },
    op,
    undefined,
    connectionOverride,
  );
  if (!result) throw new Error('Local Borg server returned an empty taxonomy response');
  return result;
}

/**
 * Delete a cube. Cascade-deletes all roles, drones, and log entries.
 * Requires a live cube-manage grant on the selected local client.
 */
export async function deleteCube(cubeId: string): Promise<void> {
  void cubeId;
  localUnsupported('cube deletion');
}

/**
 * Create a role inside a cube. is_default=true demotes the previous
 * default role; the cube always has exactly one default.
 */
export async function createRole(
  cubeId: string,
  data: { name: string; short_description: string; detailed_description: string; is_default?: boolean; is_mandatory?: boolean; is_human_seat?: boolean; can_broadcast?: boolean; receives_all_direct?: boolean; default_model?: string; role_class?: 'queen' | 'worker' },
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ role: any }> {
  assertUuidShape(cubeId, 'cube_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  if (data.default_model !== undefined) localUnsupported('per-role default model');
  const result = await localManageRequest<{ role: any }>(
    active,
    `/api/cubes/${cubeId}/roles`,
    'POST',
    {
      operation: `create role ${manageCopyValue(data.name)} in cube ${manageCopyValue(cubeId === active.cubeId ? active.name : cubeId)}`,
      cubeName: cubeId === active.cubeId ? active.name : cubeId,
      noMutation: 'No role was created.',
    },
    buildLocalRoleFields(data),
    undefined,
    connectionOverride,
  );
  if (!result) throw new Error('Local Borg server returned an empty role response');
  return result;
}

/**
 * Update a role. All fields optional; pass only what changes.
 */
export async function updateRole(
  roleId: string,
  updates: { name?: string; short_description?: string; detailed_description?: string; is_default?: boolean; is_mandatory?: boolean; is_human_seat?: boolean; can_broadcast?: boolean; receives_all_direct?: boolean; default_model?: string; role_class?: 'queen' | 'worker' },
  targetCubeId?: string,
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ role: any }> {
  assertUuidShape(roleId, 'role_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const cubeId = targetCubeId ?? active.cubeId;
  assertUuidShape(cubeId, 'cube_id');
  if (updates.default_model !== undefined) localUnsupported('per-role default model');
  const result = await localManageRequest<{ role: any }>(
    active,
    `/api/cubes/${cubeId}/roles/${roleId}`,
    'PATCH',
    {
      operation: `update role ${manageCopyValue(roleId)} in cube ${manageCopyValue(cubeId === active.cubeId ? active.name : cubeId)}`,
      cubeName: cubeId === active.cubeId ? active.name : cubeId,
      noMutation: 'No role was updated.',
    },
    buildLocalRoleFields(updates),
    undefined,
    connectionOverride,
  );
  if (!result) throw new Error('Local Borg server returned an empty role response');
  return result;
}

/**
 * Project a create/update-role field bag onto the exact snake_case keys the
 * self-hosted coordination API accepts, dropping undefined entries and the
 * unsupported default_model (rejected before this call). name is included only
 * when present so a partial update PATCHes just the supplied fields.
 */
function buildLocalRoleFields(
  fields: {
    name?: string;
    short_description?: string;
    detailed_description?: string;
    is_default?: boolean;
    is_mandatory?: boolean;
    is_human_seat?: boolean;
    can_broadcast?: boolean;
    receives_all_direct?: boolean;
    role_class?: 'queen' | 'worker';
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of [
    'name',
    'short_description',
    'detailed_description',
    'is_default',
    'is_mandatory',
    'is_human_seat',
    'can_broadcast',
    'receives_all_direct',
    'role_class',
  ] as const) {
    if (fields[key] !== undefined) payload[key] = fields[key];
  }
  return payload;
}

/**
 * gh#473 PR1 — granular role-text section patch. Replace / insert /
 * delete a single named section of a role's detailed_description,
 * leaving the rest of the field byte-identical. Requires the selected local
 * client's live cube-manage grant. Sections are delimited by plain-label lines (e.g.
 * `Workflow:`), NOT markdown headings.
 */
export async function patchRoleSection(
  roleId: string,
  op:
    | { action: 'replace'; heading: string; body: string }
    | { action: 'insert'; heading: string; body: string; after?: string | null }
    | { action: 'delete'; heading: string },
  targetCubeId?: string,
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ role: any }> {
  assertUuidShape(roleId, 'role_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const cubeId = targetCubeId ?? active.cubeId;
  assertUuidShape(cubeId, 'cube_id');
  const result = await localManageRequest<{ role: any }>(
    active,
    `/api/cubes/${cubeId}/roles/${roleId}/section-patch`,
    'POST',
    {
      operation: `${op.action} section ${manageCopyValue(op.heading)} ${op.action === 'delete' ? 'from' : 'in'} role ${manageCopyValue(roleId)} in cube ${manageCopyValue(cubeId === active.cubeId ? active.name : cubeId)}`,
      cubeName: cubeId === active.cubeId ? active.name : cubeId,
      noMutation: `No role section was ${op.action === 'insert' ? 'inserted' : op.action === 'replace' ? 'replaced' : 'deleted'}.`,
    },
    { ...op },
    undefined,
    connectionOverride,
  );
  if (!result) throw new Error('Local Borg server returned an empty role response');
  return result;
}

/**
 * Delete a role. Worker refuses if any drone is still assigned to it
 * (reassign or evict those drones first).
 */
export async function deleteRole(roleId: string): Promise<void> {
  void roleId;
  localUnsupported('role deletion');
}

/**
 * Reassign a drone to a different role within the same cube.
 * Queen-class seat cardinality is enforced server-side — attempting
 * to assign to a queen-class role when another drone already holds
 * the seat returns an error. The class-hierarchy guard also rejects
 * direct promotion from non-human-seat roles.
 */
export async function reassignDrone(
  droneId: string,
  roleId: string,
  activeOverride?: ActiveCube,
): Promise<ReassignDroneResult> {
  // Validate both identifiers before credential lookup or network access.
  assertUuidShape(droneId, 'drone_id');
  assertUuidShape(roleId, 'role_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  assertUuidShape(active.cubeId, 'cube_id');
  const result = await localManageRequest<ReassignDroneResult>(
    active,
    `/api/cubes/${active.cubeId}/drones/${droneId}`,
    'PATCH',
    {
      operation: `reassign drone ${manageCopyValue(droneId)} to role ${manageCopyValue(roleId)} in cube ${manageCopyValue(active.name)}`,
      cubeName: active.name,
      noMutation: 'No drone was reassigned.',
    },
    { role_id: roleId },
    decodeReassignDroneResult,
  );
  if (!result) throw new Error('Local Borg server returned an empty drone reassignment response');
  return result;
}

export interface EvictDroneOptions {
  cubeId?: string;
  cubeName?: string;
  targetReference?: string;
  active?: ActiveCube;
}

export async function evictDrone(
  droneId: string,
  options: EvictDroneOptions = {},
): Promise<EvictDroneResult> {
  assertUuidShape(droneId, 'drone_id');
  if (options.cubeId !== undefined) assertUuidShape(options.cubeId, 'cube_id');
  const active = options.active ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const cubeId = options.cubeId ?? active.cubeId;
  assertUuidShape(cubeId, 'cube_id');
  const cubeName = options.cubeName ?? (cubeId === active.cubeId ? active.name : cubeId);
  const targetReference = options.targetReference ?? droneId;
  const result = await localManageRequest<EvictDroneResult>(
    active,
    `/api/cubes/${cubeId}/drones/${droneId}`,
    'DELETE',
    {
      operation: `remove ${manageCopyValue(targetReference)} from cube ${manageCopyValue(cubeName)}`,
      cubeName,
      noMutation: 'No drone was removed.',
    },
    {},
    decodeEvictDroneResult,
  );
  if (!result) throw new Error('Local Borg server returned an empty drone eviction response');
  return result;
}

export async function listRoles(cubeId: string): Promise<any[]> {
  assertUuidShape(cubeId, 'cube_id');
  const active = await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const result = await localServerRequest<{ roles: any[] }>(
    active,
    `/api/cubes/${cubeId}/roles`,
    'GET',
  );
  if (!result || !Array.isArray(result.roles)) {
    throw new Error('Local Borg server returned an invalid roles response');
  }
  return result.roles;
}

export async function getCubeForManagement(
  cubeId: string,
  operation: LocalManageOperation,
  activeOverride?: ActiveCube,
  connectionOverride?: RemoteConnection,
): Promise<{ id: string; name: string; roles: any[]; drones: any[]; [k: string]: any }> {
  assertUuidShape(cubeId, 'cube_id');
  const active = activeOverride ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  return getCube(cubeId, connectionOverride ?? await localManageConnection(active, operation));
}

/**
 * Fetch a cube's full detail: directive, roles (with detailed
 * descriptions), and drones. Access is enforced by the local client's live
 * per-cube grant.
 */
export async function getCube(cubeId: string, connection?: RemoteConnection): Promise<{ id: string; name: string; roles: any[]; drones: any[]; [k: string]: any }> {
  assertUuidShape(cubeId, 'cube_id');
  const resolved = await localOwnerConnection(connection);
  const base = `/api/cubes/${cubeId}`;
  const [cubePayload, rolePayload, dronePayload] = await Promise.all([
    localConnectionRequest<{ cube: any }>(resolved, base),
    localConnectionRequest<{ roles: any[] }>(resolved, `${base}/roles`),
    localConnectionRequest<{ drones: any[] }>(resolved, `${base}/drones`),
  ]);
  return {
    ...cubePayload.cube,
    roles: rolePayload.roles,
    drones: dronePayload.drones,
  };
}

/**
 * gh#473 PR2 — apply a named template to an existing cube via the
 * NON-CLOBBERING server route. New roles are inserted; existing
 * template-named roles get ADD fragments auto-applied (template
 * sections/classes the cube lacks) but their EVOLVED (conflicting)
 * fragments are surfaced server-side and KEPT, never overwritten. Returns
 * `{ created, updated }` counts. To selectively take template versions of
 * conflicting fragments, use `syncRoles` with a `decisions` map instead.
 */
export async function applyTemplate(
  cubeId: string,
  templateName: string,
  authorityOverride?: LocalManageAuthority,
): Promise<{ created: number; updated: number }> {
  assertUuidShape(cubeId, 'cube_id');
  const template = getTemplate(templateName);
  if (!template) throw new Error(`Unknown Borg template ${JSON.stringify(templateName)}`);
  const active = authorityOverride?.active ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const authority = authorityOverride ?? await resolveLocalManageAuthority(active, {
    operation: `apply template ${manageCopyValue(templateName)}`,
    cubeName: cubeId === active.cubeId ? active.name : cubeId,
    noMutation: 'No template fragments were changed.',
  });
  const current = await getCubeForManagement(cubeId, {
    operation: `apply template ${manageCopyValue(templateName)}`,
    cubeName: cubeId === active.cubeId ? active.name : cubeId,
    noMutation: 'No template fragments were changed.',
  }, active, authority.connection);
  let created = 0;
  let updated = 0;
  for (const role of template.roles) {
    const existing = current.roles.find((candidate) => candidate.name === role.name);
    if (!existing) {
      await createRole(cubeId, role, active, authority.connection);
      created++;
      continue;
    }
    if (await applyMissingRoleFields(existing, role, cubeId, active, authority.connection)) updated++;
    updated += await applyMissingRoleSections(existing, role, cubeId, active, authority.connection);
  }
  for (const classDef of template.message_taxonomy ?? []) {
    const currentClasses = (current.message_taxonomy ?? []) as MessageTaxonomy;
    if (!currentClasses.some((candidate) => candidate.class === classDef.class)) {
      await patchTaxonomyClass(cubeId, { action: 'add', class_def: classDef }, active, authority.connection);
      updated++;
    }
  }
  return { created, updated };
}

/**
 * gh#473 PR2 — NON-CLOBBERING sync of a cube's roles + message_taxonomy
 * against the current built-in template. Dry-run by default classifies
 * each fragment (role-text SECTION / short_description / flags / taxonomy
 * CLASS) as ADD / UNCHANGED / CONFLICT. Pass apply=true to commit:
 * ADD fragments auto-apply (zero clobber risk); CONFLICT fragments apply
 * ONLY when their stable key appears in `decisions` as 'accept'.
 * Unspecified conflicts DEFAULT TO REJECT — the cube's evolved text is
 * never silently overwritten. Custom roles (names not in template) are
 * never touched. Returns a NonClobberSyncResult.
 */
export async function syncRoles(
  cubeId: string,
  templateName: string = 'software-dev',
  apply: boolean = false,
  decisions?: Record<string, 'accept' | 'reject'>,
  authorityOverride?: LocalManageAuthority,
): Promise<NonClobberSyncResult> {
  assertUuidShape(cubeId, 'cube_id');
  const template = getTemplate(templateName);
  if (!template) throw new Error(`Unknown Borg template ${JSON.stringify(templateName)}`);
  const active = authorityOverride?.active ?? await getActiveCube();
  if (!active?.serverTrustIdentity) throw new Error('Selected Borg server authority state is missing or unreadable');
  const authority = authorityOverride ?? await resolveLocalManageAuthority(active, {
    operation: `sync template ${manageCopyValue(templateName)}`,
    cubeName: cubeId === active.cubeId ? active.name : cubeId,
    noMutation: 'No role synchronization changes were applied.',
  });
  const current = await getCubeForManagement(cubeId, {
    operation: `sync template ${manageCopyValue(templateName)}`,
    cubeName: cubeId === active.cubeId ? active.name : cubeId,
    noMutation: 'No role synchronization changes were applied.',
  }, active, authority.connection);
  const roles: NonClobberSyncResult['roles'] = [];
  const taxonomy: FragmentView[] = [];
  const additions: Array<{ key: string; run: () => Promise<void> }> = [];
  const conflictKeys = new Set<string>();
  for (const role of template.roles) {
    const existing = current.roles.find((candidate) => candidate.name === role.name);
    if (!existing) {
      const key = `role:${role.name}`;
      const fragments: FragmentView[] = [{
        key,
        kind: 'add',
        label: 'role',
        cubeValue: null,
        templateValue: role.name,
      }];
      roles.push({ name: role.name, status: 'new', fragments });
      additions.push({ key, run: async () => { await createRole(cubeId, role, active, authority.connection); } });
      continue;
    }
    const fragments: FragmentView[] = [];
    addRoleScalarFragment(fragments, additions, conflictKeys, decisions, existing, role, 'short_description', 'short description', cubeId, active, authority.connection);
    for (const field of ['is_default', 'is_mandatory', 'is_human_seat', 'can_broadcast', 'receives_all_direct'] as const) {
      if (role[field] !== undefined) addRoleScalarFragment(fragments, additions, conflictKeys, decisions, existing, role, field, field, cubeId, active, authority.connection);
    }
    const currentSections = new Map(parseRoleSections(String(existing.detailed_description ?? '')).map((section) => [section.heading, section]));
    for (const section of parseRoleSections(role.detailed_description)) {
      if (!section.heading) continue;
      const key = `role:${role.name}:section:${section.heading}`;
      const previous = currentSections.get(section.heading);
      const kind = !previous ? 'add' : previous.body === section.body ? 'unchanged' : 'conflict';
      fragments.push({ key, kind, label: `section ${section.heading}`, cubeValue: previous?.body ?? null, templateValue: section.body });
      if (kind === 'add') additions.push({ key, run: async () => { await patchRoleSection(existing.id, { action: 'insert', heading: section.heading!, body: section.body }, cubeId, active, authority.connection); } });
      if (kind === 'conflict') conflictKeys.add(key);
      if (kind === 'conflict' && decisions?.[key] === 'accept') additions.push({ key, run: async () => { await patchRoleSection(existing.id, { action: 'replace', heading: section.heading!, body: section.body }, cubeId, active, authority.connection); } });
    }
    roles.push({ name: role.name, status: 'existing', fragments });
  }
  for (const existing of current.roles) {
    if (!template.roles.some((role) => role.name === existing.name)) {
      roles.push({ name: existing.name, status: 'custom-skipped', fragments: [] });
    }
  }
  for (const classDef of template.message_taxonomy ?? []) {
    const key = `taxonomy:${classDef.class}`;
    const currentClass = (current.message_taxonomy ?? []).find((candidate: MessageTaxonomyClass) => candidate.class === classDef.class);
    const currentValue = currentClass ? stableJson(currentClass) : null;
    const templateValue = stableJson(classDef);
    const kind = !currentClass ? 'add' : currentValue === templateValue ? 'unchanged' : 'conflict';
    taxonomy.push({ key, kind, label: `taxonomy class ${classDef.class}`, cubeValue: currentValue, templateValue });
    if (kind === 'add') additions.push({ key, run: async () => { await patchTaxonomyClass(cubeId, { action: 'add', class_def: classDef }, active, authority.connection); } });
    if (kind === 'conflict') conflictKeys.add(key);
    if (kind === 'conflict' && decisions?.[key] === 'accept') additions.push({ key, run: async () => { await patchTaxonomyClass(cubeId, { action: 'replace', class_def: classDef }, active, authority.connection); } });
  }
  const acceptedConflicts = [...conflictKeys].filter((key) => decisions?.[key] === 'accept');
  const rejectedConflicts = [...conflictKeys].filter((key) => decisions?.[key] !== 'accept');
  const classifiedKeys = new Set([...conflictKeys]);
  const unmatchedDecisions = Object.keys(decisions ?? {}).filter((key) => !classifiedKeys.has(key));
  const addedKeys = additions.filter(({ key }) => !conflictKeys.has(key)).map(({ key }) => key);
  if (apply) {
    for (const addition of additions) {
      if (conflictKeys.has(addition.key) && decisions?.[addition.key] !== 'accept') continue;
      await addition.run();
    }
  }
  return {
    dryRun: !apply,
    roles,
    taxonomy,
    applied: {
      added: apply ? addedKeys : [],
      acceptedConflicts: apply ? acceptedConflicts : [],
    },
    rejectedConflicts,
    unmatchedDecisions,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function addRoleScalarFragment(
  fragments: FragmentView[],
  additions: Array<{ key: string; run: () => Promise<void> }>,
  conflictKeys: Set<string>,
  decisions: Record<string, 'accept' | 'reject'> | undefined,
  existing: any,
  template: TemplateRole,
  field: 'short_description' | 'is_default' | 'is_mandatory' | 'is_human_seat' | 'can_broadcast' | 'receives_all_direct',
  label: string,
  cubeId: string,
  active: ActiveCube,
  connection: RemoteConnection,
): void {
  const templateValue = template[field];
  if (templateValue === undefined) return;
  const key = `role:${template.name}:${field}`;
  const currentValue = existing[field];
  const missing = currentValue === undefined || (field === 'short_description' && currentValue === '');
  const kind = missing ? 'add' : currentValue === templateValue ? 'unchanged' : 'conflict';
  fragments.push({ key, kind, label, cubeValue: missing ? null : String(currentValue), templateValue: String(templateValue) });
  if (kind === 'add') additions.push({
    key,
    run: async () => { await updateRole(existing.id, { [field]: templateValue } as Parameters<typeof updateRole>[1], cubeId, active, connection); },
  });
  if (kind === 'conflict') {
    conflictKeys.add(key);
    if (decisions?.[key] === 'accept') additions.push({
      key,
      run: async () => { await updateRole(existing.id, { [field]: templateValue } as Parameters<typeof updateRole>[1], cubeId, active, connection); },
    });
  }
}

async function applyMissingRoleFields(existing: any, template: TemplateRole, cubeId: string, active: ActiveCube, connection: RemoteConnection): Promise<boolean> {
  const updates: Record<string, unknown> = {};
  if ((existing.short_description === undefined || existing.short_description === '') && template.short_description) {
    updates.short_description = template.short_description;
  }
  for (const field of ['is_default', 'is_mandatory', 'is_human_seat', 'can_broadcast', 'receives_all_direct'] as const) {
    if (existing[field] === undefined && template[field] !== undefined) updates[field] = template[field];
  }
  if (Object.keys(updates).length === 0) return false;
  await updateRole(existing.id, updates as Parameters<typeof updateRole>[1], cubeId, active, connection);
  return true;
}

async function applyMissingRoleSections(existing: any, template: TemplateRole, cubeId: string, active: ActiveCube, connection: RemoteConnection): Promise<number> {
  const currentSections = new Map(parseRoleSections(String(existing.detailed_description ?? '')).map((section) => [section.heading, section]));
  let updated = 0;
  for (const section of parseRoleSections(template.detailed_description)) {
    if (section.heading && !currentSections.has(section.heading)) {
      await patchRoleSection(existing.id, { action: 'insert', heading: section.heading, body: section.body }, cubeId, active, connection);
      updated++;
    }
  }
  return updated;
}
