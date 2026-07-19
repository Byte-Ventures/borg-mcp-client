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
  decodeProtocolEnvelope,
  decodeProtocolErrorEnvelope,
  ErrorCode,
} from 'borgmcp-shared/protocol';
import { consolePrefix } from './console-prefix.js';
import { debugLog } from './debug.js';
import { assertUuidShape } from './evict-drone.js';
import {
  DroneEvictedError,
  DRONE_EVICTED_CODE,
  errorCodeFromBody,
} from './drone-lifecycle.js';
import type { MessageTaxonomy, MessageTaxonomyClass } from 'borgmcp-shared/templates';
import { canonicalizeWorkingRepoIdentity, type WorkingRepo } from './working-repo.js';
import { loadBorgServerTrust, type ServerFetch } from './server-trust.js';
import {
  BorgServerError,
  BorgServerHttpError,
  BorgServerTrustError,
  BorgServerUnreachableError,
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

// Compatibility validation for the deprecated request field. The CLI no longer
// offers provider configuration, but older callers may still send this shape.
const LEGACY_MODEL_DESCRIPTOR_REGEX = /^(claude|ollama):[A-Za-z0-9._:\/-]+$/;

export interface RemoteConnection {
  apiUrl: string;
  authToken: string;
  serverTrustIdentity?: string;
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

export function extractHttpErrorMessage(body: string): string {
  const joinMessageDetails = (message: string, details: string) =>
    `${message}${/[.:!?]$/.test(message) ? '' : ':'} ${details}`;
  try {
    const parsed = JSON.parse(body) as any;
    if (typeof parsed?.error === 'string') {
      return typeof parsed.details === 'string'
        ? joinMessageDetails(parsed.error, parsed.details)
        : parsed.error;
    }
    if (parsed?.error && typeof parsed.error === 'object') {
      const message = parsed.error.message;
      const details = parsed.error.details ?? parsed.details;
      if (typeof message === 'string' && typeof details === 'string') {
        return joinMessageDetails(message, details);
      }
      if (typeof message === 'string') return message;
    }
    if (typeof parsed?.message === 'string' && typeof parsed?.details === 'string') {
      return joinMessageDetails(parsed.message, parsed.details);
    }
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
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
): Promise<ActiveCube | null> {
  const active = await getActiveCube();
  const matched = active?.serverTrustIdentity !== undefined &&
    active.apiUrl === apiUrl &&
    active.sessionToken === sessionToken
    ? active
    : null;
  if (expectedServerTrustIdentity !== undefined) {
    if (!matched || matched.serverTrustIdentity !== expectedServerTrustIdentity) {
      throw new Error('Selected Borg server authority state is missing or unreadable');
    }
    return matched;
  }
  // Only a hydrated local ActiveCube carrying the verified trust anchor
  // authorizes the request. cubes.json is mutable local state and a
  // legacy-looking sessionToken proves nothing — fail closed before any
  // network use when no verified local authority is present.
  if (!matched) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
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
    return decodeProtocolEnvelope(body, (value) => value as T).payload;
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

interface LocalManageOperation {
  operation: string;
  cubeName: string;
  noMutation: string;
}

async function localManageRequest<T>(
  active: ActiveCube,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  operation: LocalManageOperation,
  payload?: Record<string, unknown>,
): Promise<T | null> {
  const trustIdentity = active.serverTrustIdentity!;
  const authToken = await getServerCredential(active.apiUrl, trustIdentity);
  if (!authToken) {
    throw new LocalManageRequiredError(
      operation.operation,
      operation.cubeName,
      operation.noMutation,
    );
  }
  try {
    return await decodeLocalProtocolResponse<T>((signal) => authedFetch(path, {
      method,
      signal,
      apiUrl: active.apiUrl,
      authToken,
      serverTrustIdentity: trustIdentity,
      redirect: 'error',
      ...(payload === undefined
        ? { headers: { Accept: 'application/json' } }
        : {
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(createProtocolEnvelope(randomUUID(), payload)),
        }),
    }), true);
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
  const hasExplicitAuth = authToken !== undefined;
  // No hosted default: a destination requires an explicit apiUrl. Fail closed
  // before any network or credential use when none is given.
  if (apiUrl === undefined) {
    // Preserve the "active cube is a local server that lacks this capability"
    // diagnostic for callers that supply neither an endpoint nor credentials.
    if (droneSession === undefined && authToken === undefined) {
      const active = await getActiveCube();
      if (active?.serverTrustIdentity !== undefined) {
        localUnsupported(`the ${path} capability`);
      }
    }
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const baseUrl = apiUrl;
  // A drone-session call must carry its verified trust identity explicitly; a
  // missing one can no longer be excused by a hosted authority.
  if (droneSession !== undefined && suppliedTrustIdentity === undefined) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  let serverTrustIdentity = suppliedTrustIdentity;
  if (serverTrustIdentity === undefined) {
    // Owner-scoped calls may recover the verified anchor from the active cube
    // when it targets the same local endpoint.
    const active = await getActiveCube();
    if (active?.apiUrl === baseUrl) serverTrustIdentity = active.serverTrustIdentity;
  }
  // Every destination must arrive through verified local-server trust. Without
  // it there is no hosted fallback — fail closed.
  if (serverTrustIdentity === undefined) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const hasServerAuthority = true;
  if (!/^\/api\/cubes(?:\/|$)/.test(path)) {
    localUnsupported(`the ${path} capability`);
  }
  let requestFetch: ServerFetch = fetch;
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

  let response = await buildRequest(token);

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
        'the selected Borg server rejected this worktree session (revoked or taken over)',
      );
    }
    throw new BorgServerError(
      'CREDENTIAL_REJECTED',
      'the selected Borg server rejected the credential',
    );
  }

  // gh#330: honor the server's Retry-After on 429 instead of failing the
  // (often required) coordination signal — borg_log / read-log / regen /
  // roster / ack all route through here. Bounded + capped + jittered.
  if (response.status === 429 && !hasServerAuthority) {
    response = await retryOn429(response, () => buildRequest(token), {
      sleep,
      log: (msg) => console.error(`${consolePrefix()}${msg}`),
    });
  }

  if (!response.ok) {
    // A selected self-hosted authority is not the trusted hosted Worker. Do
    // not copy its response body into errors or debug output: a malicious or
    // misconfigured server could reflect bearer/invitation material or inject
    // terminal controls. Decode only the bounded protocol error code for typed
    // branching; never surface the server-provided message or details.
    if (hasServerAuthority || hasExplicitAuth) {
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
      // CR5: carry the raw status in a TYPED error so a probe distinguishes an
      // endpoint/protocol-mismatch (404) from a server-failure (5xx) by code, not
      // by matching mutable message text. Message kept identical for call-site parity.
      throw new BorgServerHttpError(
        response.status,
        `Borg server request failed (HTTP ${response.status})`,
        code,
      );
    }
    // Read the body ONCE (the stream can only be consumed once) and reuse
    // it for both the debug trace and the thrown error. The server error
    // body is token-free (it never echoes the Authorization header), so it
    // is safe to surface under --debug.
    const body = await response.text();
    debugLog(`✗ ${response.status} ${method} ${path}: ${body}`);
    // Enrich the 429 message with the server's retry guidance so a
    // still-exhausted limit surfaces an actionable wait, not a bare code.
    const message = extractHttpErrorMessage(body);
    // gh#877 Path-B: the AUTHORITATIVE drone-lifecycle verdict. All drone-authed
    // calls funnel through here, so this single detection point guarantees the
    // eventual catch. Keyed on the STRUCTURED code, not the bare status (SEC
    // R2/R4): 410+DRONE_EVICTED is TERMINAL → DroneEvictedError (the index tool
    // funnel maps it to a recognizable EVICTED result so the agent shuts down).
    const code = errorCodeFromBody(body);
    if (response.status === 410 && code === DRONE_EVICTED_CODE) {
      throw new DroneEvictedError(message);
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const hint = retryAfter ? ` (retry after ${retryAfter}s)` : '';
      throw new Error(`HTTP 429: rate limited${hint}: ${message}`);
    }
    throw new Error(`HTTP ${response.status}: ${message}`);
  }

  return response;
}

/**
 * Connect this client as a Drone to a Cube.
 *
 * Returns the cube definition, the drone's assigned role (with full
 * detailed_description), the drone record, and an opaque session token
 * the caller is expected to persist via cubes.ts.
 */
export async function assimilate(
  // gh#780: prior_drone_id is the caller's saved seat id for this cube
  // (per-worktree cubes.json) — an UNTRUSTED hint the server's ownership
  // predicate validates; on a match the seat is re-attached (token
  // rotated) instead of minted. Pre-gh#780 workers ignore unknown body
  // fields only after PR-C's worker deploys — the CLI only sends it on
  // the --here same-cube recovery flow, which is publish-gated on that
  // deploy.
  cubeNameOrSelector: string | { cube_id?: string; cube_name?: string; role_id?: string; role_name?: string; prior_drone_id?: string; model?: string | null },
  apiUrl?: string,
  hostname?: string | null,
  agentKind?: 'claude' | 'codex' | 'opencode' | null,
  authToken?: string,
  serverTrustIdentity?: string,
): Promise<{
  cube: {
    id: string;
    owner_id: string;
    name: string;
    cube_directive: string;
    created_at: string;
    updated_at: string;
  };
  role: {
    id: string;
    cube_id: string;
    name: string;
    short_description: string;
    detailed_description: string;
    is_default: boolean;
    is_mandatory: boolean;
    is_human_seat: boolean;
    role_class: 'queen' | 'worker';
    created_at: string;
  };
  drone: {
    id: string;
    cube_id: string;
    role_id: string;
    label: string;
    last_seen: string;
    hostname: string | null;
    created_at: string;
  };
  sessionToken: string;
  // gh#780: true when the server re-attached an existing seat instead of
  // minting; absent from pre-gh#780 workers.
  reattached?: boolean;
}> {
  // String first arg → legacy cube_name-only path (backwards compat).
  // Object first arg → orchestrator path with optional cube_id /
  // role_id / role_name; assimilate-cmd uses this shape.
  const body: Record<string, unknown> = { hostname: hostname ?? null };
  if (agentKind === 'claude' || agentKind === 'codex' || agentKind === 'opencode') body.agent_kind = agentKind;
  if (typeof cubeNameOrSelector === 'string') {
    body.cube_name = cubeNameOrSelector;
  } else {
    if (cubeNameOrSelector.cube_id) body.cube_id = cubeNameOrSelector.cube_id;
    if (cubeNameOrSelector.cube_name) body.cube_name = cubeNameOrSelector.cube_name;
    if (cubeNameOrSelector.role_id) body.role_id = cubeNameOrSelector.role_id;
    if (cubeNameOrSelector.role_name) body.role_name = cubeNameOrSelector.role_name;
    if (cubeNameOrSelector.prior_drone_id) body.prior_drone_id = cubeNameOrSelector.prior_drone_id;
    // gh#890: model was forwarded into the selector by assimilate-deps but
    // never copied onto the wire here — the sole drop point that left
    // drones.model NULL despite the server accepting + persisting it.
    // gh#896: defense-in-depth — reject a malformed descriptor client-side with
    // a clear error BEFORE the wire. Belt-and-suspenders: the descriptor is
    // already flag-parse-validated upstream and server-gated by the same regex,
    // so this only sharpens the failure (clear local error vs a 400 round-trip).
    if (cubeNameOrSelector.model != null) {
      if (!LEGACY_MODEL_DESCRIPTOR_REGEX.test(cubeNameOrSelector.model)) {
        throw new Error(
          `Invalid model descriptor: "${cubeNameOrSelector.model}" (expected "<claude|ollama>:<model>").`
        );
      }
      body.model = cubeNameOrSelector.model;
    }
  }
  const response = await authedFetch('/api/assimilate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    apiUrl,
    authToken,
    serverTrustIdentity,
  });
  return await response.json() as any;
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
  if (local) {
    const composed = await localCubeComposition(local);
    return { cube: composed.cube, roles: composed.roles };
  }
  const response = await authedFetch('/api/drone/cube', {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return await response.json() as any;
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
  if (local) return { role: (await localCubeComposition(local)).role };
  const response = await authedFetch('/api/drone/role', {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return await response.json() as any;
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
  if (local) {
    const roles = (await localCubeComposition(local)).roles;
    const matched = roles.find((candidate) =>
      candidate.id === role || candidate.name.toLowerCase() === role.toLowerCase()
    );
    if (!matched) throw new Error(`Local Borg server has no role named ${JSON.stringify(role)}`);
    return { role: matched };
  }
  const params = new URLSearchParams({ role });
  const response = await authedFetch(`/api/drone/role?${params.toString()}`, {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return await response.json() as any;
}

export async function whoami(
  sessionToken: string,
  apiUrl: string,
  serverTrustIdentity?: string,
): Promise<{ cube_id: string; cube_name: string; drone_id: string; drone_label: string; role_id: string; role_name: string }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  if (local) {
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
  const response = await authedFetch('/api/drone/whoami', {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return await response.json() as any;
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
  if (local) {
    if (since !== undefined) localUnsupported('roster liveness filtering');
    const composed = await localCubeComposition(local);
    return { drones: composed.drones, roles: composed.roles, message_taxonomy: null };
  }
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const response = await authedFetch(`/api/drone/roster${qs}`, {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return await response.json() as any;
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
  if (local) {
    let cursor: LocalServerCursor | null = null;
    if (opts.unreadOnly) cursor = await getLocalServerCursor(localCursorBinding(local));
    if (opts.since !== undefined) {
      cursor = await resolveLocalLogCursor(local, opts.since);
    }
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
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.unreadOnly) params.set('unread_only', 'true');
  const qs = params.toString();
  const response = await authedFetch(
    `/api/drone/log${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      droneSession: sessionToken,
      apiUrl,
      serverTrustIdentity: opts.serverTrustIdentity,
    }
  );
  return await response.json() as any;
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
  if (local) {
    await localServerRequest(
      local,
      `/api/cubes/${local.cubeId}/acks`,
      'POST',
      { entry_id: entryId, kind },
    );
    return;
  }
  await authedFetch(`/api/drone/log/${entryId}/ack`, {
    method: 'POST',
    body: JSON.stringify({ kind }),
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
}

/**
 * gh#740: record a ratified cube decision (seat-holder only — the worker
 * enforces the seat gate). Supersedes the active decision on the same topic.
 */
export async function recordDecision(
  sessionToken: string,
  apiUrl: string,
  input: { topic: string; decision: string; rationale?: string },
  serverTrustIdentity?: string,
): Promise<{ decision: any }> {
  const local = await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity);
  if (local) {
    const payload = await localManageRequest<{ decision: any }>(
      local,
      `/api/cubes/${local.cubeId}/decisions`,
      'POST',
      {
        operation: 'record a decision',
        cubeName: local.name,
        noMutation: 'Nothing was recorded.',
      },
      input,
    );
    if (!payload) throw new Error('Local Borg server returned an empty decision response');
    return payload;
  }
  const response = await authedFetch('/api/drone/decide', {
    method: 'POST',
    body: JSON.stringify(input),
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return (await response.json()) as { decision: any };
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
  if (local) {
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
  const qs = topic ? `?topic=${encodeURIComponent(topic)}` : '';
  const response = await authedFetch(`/api/drone/decisions${qs}`, {
    method: 'GET',
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return (await response.json()) as { decisions: any[] };
}

/** Remove one active ratified decision. The worker enforces the seat gate. */
export async function removeDecision(
  sessionToken: string,
  apiUrl: string,
  selector: { topic: string } | { decision_id: string },
  serverTrustIdentity?: string,
): Promise<{ decision: any }> {
  if (await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity)) {
    localUnsupported('decision removal');
  }
  const response = await authedFetch('/api/drone/decisions', {
    method: 'DELETE',
    body: JSON.stringify(selector),
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity,
  });
  return (await response.json()) as { decision: any };
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
  // The cloud regen ships these in its response; the local path composes them
  // via listDecisions so self-hosted regen matches cloud behavior.
  decisions?: any[];
}> {
  const local = await localAuthorityContext(
    sessionToken,
    apiUrl,
    opts.serverTrustIdentity,
  );
  if (local) {
    const composed = await localCubeComposition(local);
    const cursor = opts.since === undefined
      ? await getLocalServerCursor(localCursorBinding(local))
      : await resolveLocalLogCursor(local, opts.since);
    const page = await localReadLogPage(local, { cursor, limit: 1 });
    // gh#740: fetch the cube's active ratified decisions so local regen
    // renders the decisions section, matching cloud regen. Resilient: a
    // decisions-fetch failure must not break orientation (warn + continue).
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
  const params = new URLSearchParams();
  if (opts.since) params.set('since', opts.since);
  if (opts.reportedModel) params.set('reported_model', opts.reportedModel);
  if (opts.workingRepo) {
    params.set('working_repo_reported', '1');
    const origin = opts.workingRepo.origin
      ? canonicalizeWorkingRepoIdentity(opts.workingRepo.origin)
      : null;
    if (origin) params.set('working_repo_origin', origin);
  }
  const qs = params.toString();
  const response = await authedFetch(
    `/api/drone/regen${qs ? `?${qs}` : ''}`,
    {
      method: 'GET',
      droneSession: sessionToken,
      apiUrl,
      serverTrustIdentity: opts.serverTrustIdentity,
    }
  );
  return await response.json() as any;
}

export async function roleRationale(
  sessionToken: string,
  apiUrl: string,
  role: string,
  section: string,
  serverTrustIdentity?: string,
): Promise<{ role: string; section: string; body: string }> {
  if (await localAuthorityContext(sessionToken, apiUrl, serverTrustIdentity)) {
    localUnsupported('role rationale sections');
  }
  const params = new URLSearchParams({ role, section });
  const response = await authedFetch(
    `/api/drone/role-rationale?${params.toString()}`,
    {
      method: 'GET',
      droneSession: sessionToken,
      apiUrl,
      serverTrustIdentity,
    }
  );
  return await response.json() as any;
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
  if (local) {
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
  const body = {
    message,
    ...(opts.visibility ? { visibility: opts.visibility } : {}),
    ...(opts.recipientDroneIds ? { recipientDroneIds: opts.recipientDroneIds } : {}),
    ...(opts.class ? { class: opts.class } : {}),
    ...(opts.to ? { to: opts.to } : {}),
  };
  const response = await authedFetch('/api/drone/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    droneSession: sessionToken,
    apiUrl,
    serverTrustIdentity: opts.serverTrustIdentity,
    body: JSON.stringify(body),
  });
  return await response.json() as any;
}

/**
 * List all cubes owned by the authenticated user. Owner-scoped via the
 * Bearer token alone; no drone session needed.
 */
export async function listCubes(connection?: RemoteConnection): Promise<{ cubes: any[] }> {
  if (connection?.serverTrustIdentity !== undefined) {
    return localConnectionRequest<{ cubes: any[] }>(connection, '/api/cubes');
  }
  const response = await authedFetch('/api/cubes', {
    method: 'GET',
    apiUrl: connection?.apiUrl,
    authToken: connection?.authToken,
    serverTrustIdentity: connection?.serverTrustIdentity,
  });
  return await response.json() as any;
}

/**
 * List bundled cube templates. Used by the `borg assimilate` orchestrator
 * to surface the interactive template prompt on first-drone bootstrap.
 */
export async function listTemplates(connection?: RemoteConnection): Promise<{ templates: Array<{ name: string; description: string; roles: any[] }> }> {
  if (connection?.serverTrustIdentity !== undefined) {
    localUnsupported('cube templates');
  }
  const response = await authedFetch('/api/templates', {
    method: 'GET',
    apiUrl: connection?.apiUrl,
    authToken: connection?.authToken,
    serverTrustIdentity: connection?.serverTrustIdentity,
  });
  return await response.json() as any;
}

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
  if (connection?.serverTrustIdentity !== undefined) {
    localUnsupported('cube creation');
  }
  const body: Record<string, unknown> = { cube_directive: cubeDirective };
  if (name) body.name = name;
  if (opts?.template) body.template = opts.template;
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'message_taxonomy')) {
    body.message_taxonomy = opts.message_taxonomy ?? null;
  }
  const response = await authedFetch('/api/cubes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    apiUrl: connection?.apiUrl,
    authToken: connection?.authToken,
    serverTrustIdentity: connection?.serverTrustIdentity,
  });
  // BUG-2 fix (v0.9.2, drone-1 dispatch 2026-05-18T10:48Z): server
  // returns `{ cube, roles }` (Phase B wire shape). Unwrap at this
  // boundary so callers receive a flat shape `{ id, name, ...cube,
  // roles, drones }` consistent with the orchestrator's CubeDetail
  // expectation. The `body.cube ?` ternary preserves backwards-compat
  // for any future endpoint that might return a non-wrapped shape.
  const responseBody = await response.json() as any;
  return responseBody.cube
    ? { ...responseBody.cube, roles: responseBody.roles ?? [], drones: responseBody.drones ?? [] }
    : responseBody;
}

/**
 * Update a cube's name and/or cube_directive. Both fields are optional;
 * pass only what changes.
 */
export async function updateCube(
  cubeId: string,
  updates: { name?: string; cube_directive?: string; message_taxonomy?: MessageTaxonomy | null }
): Promise<{ cube: any }> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    // Local (self-hosted) authority: the manage-scoped cube PATCH accepts
    // only cube_directive and message_taxonomy — the local server carries no
    // cube-rename route, so a name change fails closed cause-accurately.
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
        operation: 'change cube settings',
        cubeName: cubeId === active.cubeId ? active.name : cubeId,
        noMutation: 'No cube settings were changed.',
      },
      payload,
    );
    if (!result) throw new Error('Local Borg server returned an empty cube response');
    return result;
  }
  const response = await authedFetch(`/api/cubes/${cubeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return await response.json() as any;
}

/**
 * gh#473 PR1 — granular per-class taxonomy patch. Add / replace-by-name
 * / remove a single class within the cube's message_taxonomy, leaving
 * other classes unchanged. The worker re-validates the FULL resulting
 * array (cross-class invariants) before persist. Owner-scoped via the
 * Bearer token.
 */
export async function patchTaxonomyClass(
  cubeId: string,
  op:
    | { action: 'add'; class_def: MessageTaxonomyClass }
    | { action: 'replace'; class_def: MessageTaxonomyClass }
    | { action: 'remove'; class: string }
): Promise<{ cube: any }> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    const className = op.action === 'remove' ? op.class : op.class_def.class;
    const pastTense = op.action === 'add' ? 'added' : op.action === 'replace' ? 'replaced' : 'removed';
    const result = await localManageRequest<{ cube: any }>(
      active,
      `/api/cubes/${cubeId}/taxonomy-patch`,
      'POST',
      {
        operation: `${op.action} taxonomy class "${className}"`,
        cubeName: cubeId === active.cubeId ? active.name : cubeId,
        noMutation: `No class was ${pastTense}.`,
      },
      op,
    );
    if (!result) throw new Error('Local Borg server returned an empty taxonomy response');
    return result;
  }
  const response = await authedFetch(`/api/cubes/${cubeId}/taxonomy-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(op),
  });
  return await response.json() as any;
}

/**
 * Delete a cube. Cascade-deletes all roles, drones, and log entries.
 * Owner-scoped via the Bearer token; the worker enforces ownership.
 */
export async function deleteCube(cubeId: string): Promise<void> {
  await authedFetch(`/api/cubes/${cubeId}`, { method: 'DELETE' });
}

/**
 * Create a role inside a cube. is_default=true demotes the previous
 * default role; the cube always has exactly one default.
 */
export async function createRole(
  cubeId: string,
  data: { name: string; short_description: string; detailed_description: string; is_default?: boolean; is_mandatory?: boolean; is_human_seat?: boolean; can_broadcast?: boolean; receives_all_direct?: boolean; default_model?: string; role_class?: 'queen' | 'worker' }
): Promise<{ role: any }> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    // Local (self-hosted) authority: the cube-scoped role-create route accepts
    // only the server-known fields. default_model has no local server route.
    if (data.default_model !== undefined) localUnsupported('per-role default model');
    const result = await localManageRequest<{ role: any }>(
      active,
      `/api/cubes/${cubeId}/roles`,
      'POST',
      {
        operation: `create role "${data.name}"`,
        cubeName: cubeId === active.cubeId ? active.name : cubeId,
        noMutation: 'No role was created.',
      },
      buildLocalRoleFields(data),
    );
    if (!result) throw new Error('Local Borg server returned an empty role response');
    return result;
  }
  const response = await authedFetch(`/api/cubes/${cubeId}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return await response.json() as any;
}

/**
 * Update a role. All fields optional; pass only what changes.
 */
export async function updateRole(
  roleId: string,
  updates: { name?: string; short_description?: string; detailed_description?: string; is_default?: boolean; is_mandatory?: boolean; is_human_seat?: boolean; can_broadcast?: boolean; receives_all_direct?: boolean; default_model?: string; role_class?: 'queen' | 'worker' }
): Promise<{ role: any }> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    // Local (self-hosted) authority: role update rides the cube-scoped route
    // (/api/cubes/:cubeId/roles/:roleId), NOT the cube-unscoped cloud path.
    if (updates.default_model !== undefined) localUnsupported('per-role default model');
    const result = await localManageRequest<{ role: any }>(
      active,
      `/api/cubes/${active.cubeId}/roles/${roleId}`,
      'PATCH',
      {
        operation: `update role "${roleId}"`,
        cubeName: active.name,
        noMutation: 'No role was updated.',
      },
      buildLocalRoleFields(updates),
    );
    if (!result) throw new Error('Local Borg server returned an empty role response');
    return result;
  }
  const response = await authedFetch(`/api/roles/${roleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return await response.json() as any;
}

/**
 * Project a create/update-role field bag onto the exact snake_case keys the
 * self-hosted coordination API accepts, dropping undefined entries and the
 * cloud-only default_model (rejected before this call). name is included only
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
 * leaving the rest of the field byte-identical. Owner-scoped via the
 * Bearer token. Sections are delimited by plain-label lines (e.g.
 * `Workflow:`), NOT markdown headings.
 */
export async function patchRoleSection(
  roleId: string,
  op:
    | { action: 'replace'; heading: string; body: string }
    | { action: 'insert'; heading: string; body: string; after?: string | null }
    | { action: 'delete'; heading: string }
): Promise<{ role: any }> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    // Local (self-hosted) authority: section-patch rides the cube-scoped route
    // (/api/cubes/:cubeId/roles/:roleId/section-patch), NOT the cloud path.
    const result = await localManageRequest<{ role: any }>(
      active,
      `/api/cubes/${active.cubeId}/roles/${roleId}/section-patch`,
      'POST',
      {
        operation: `${op.action} section "${op.heading}" in role "${roleId}"`,
        cubeName: active.name,
        noMutation: `No section was ${op.action === 'insert' ? 'inserted' : op.action === 'replace' ? 'replaced' : 'deleted'}.`,
      },
      { ...op },
    );
    if (!result) throw new Error('Local Borg server returned an empty role response');
    return result;
  }
  const response = await authedFetch(`/api/roles/${roleId}/section-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(op),
  });
  return await response.json() as any;
}

/**
 * Delete a role. Worker refuses if any drone is still assigned to it
 * (reassign or evict those drones first).
 */
export async function deleteRole(roleId: string): Promise<void> {
  await authedFetch(`/api/roles/${roleId}`, { method: 'DELETE' });
}

/**
 * Reassign a drone to a different role within the same cube.
 * Queen-class seat cardinality is enforced server-side — attempting
 * to assign to a queen-class role when another drone already holds
 * the seat returns an error. The class-hierarchy guard also rejects
 * direct promotion from non-human-seat roles.
 */
export async function reassignDrone(droneId: string, roleId: string): Promise<{ drone: any }> {
  // gh#782: validate BEFORE any await — a path-shaped drone_id
  // ("../cubes/<uuid>") must never reach URL construction. role_id rides
  // in the JSON body, not the path, so it is not interpolation-exposed.
  assertUuidShape(droneId, 'drone_id');
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    const result = await localManageRequest<{ drone: any }>(
      active,
      `/api/cubes/${active.cubeId}/drones/${droneId}`,
      'PATCH',
      {
        operation: `reassign "${droneId}"`,
        cubeName: active.name,
        noMutation: 'No drone was reassigned.',
      },
      { role_id: roleId },
    );
    if (!result) throw new Error('Local Borg server returned an empty drone response');
    return result;
  }
  const response = await authedFetch(`/api/drones/${droneId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId }),
  });
  return await response.json() as any;
}

/**
 * Evict (soft-delete) a drone from its cube (gh#718). Owner-authed via the
 * Bearer token, exactly like reassignDrone — the worker's `DELETE
 * /api/drones/:id` route scopes the delete to cubes the caller owns
 * (CubeStore.evictDrone RLS owner-scope), so a non-owner can never evict
 * another account's drone. The drone row is preserved with `evicted_at` set
 * and its activity-log attribution anonymized; the route returns 204 No
 * Content (no body).
 */
export async function evictDrone(droneId: string, targetLabel: string = droneId): Promise<void> {
  // gh#782: same pre-network gate as reassignDrone — defense-in-depth at
  // the layer that interpolates the path (the borg_evict-drone tool layer
  // keeps its friendlier label-hint validation above this).
  assertUuidShape(droneId, 'drone_id');
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
    await localManageRequest(
      active,
      `/api/cubes/${active.cubeId}/drones/${droneId}`,
      'DELETE',
      {
        operation: `remove "${targetLabel}"`,
        cubeName: active.name,
        noMutation: 'No drone was removed.',
      },
    );
    return;
  }
  await authedFetch(`/api/drones/${droneId}`, { method: 'DELETE' });
}

export async function listRoles(cubeId: string): Promise<any[]> {
  const active = await getActiveCube();
  if (active?.serverTrustIdentity !== undefined) {
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
  return (await getCube(cubeId)).roles;
}

/**
 * Fetch a cube's full detail: directive, roles (with detailed
 * descriptions), and drones. Accessible to owners and active members via
 * the Bearer token; no drone session needed.
 */
export async function getCube(cubeId: string, connection?: RemoteConnection): Promise<{ id: string; name: string; roles: any[]; drones: any[]; [k: string]: any }> {
  if (connection?.serverTrustIdentity !== undefined) {
    const base = `/api/cubes/${cubeId}`;
    const [cubePayload, rolePayload, dronePayload] = await Promise.all([
      localConnectionRequest<{ cube: any }>(connection, base),
      localConnectionRequest<{ roles: any[] }>(connection, `${base}/roles`),
      localConnectionRequest<{ drones: any[] }>(connection, `${base}/drones`),
    ]);
    return {
      ...cubePayload.cube,
      roles: rolePayload.roles,
      drones: dronePayload.drones,
    };
  }
  const response = await authedFetch(`/api/cubes/${cubeId}`, {
    method: 'GET',
    apiUrl: connection?.apiUrl,
    authToken: connection?.authToken,
    serverTrustIdentity: connection?.serverTrustIdentity,
  });
  // BUG-2 fix (v0.9.2): same unwrap pattern as createCube — server
  // returns `{ cube, roles, drones }`; callers get flat shape.
  const responseBody = await response.json() as any;
  return responseBody.cube
    ? { ...responseBody.cube, roles: responseBody.roles ?? [], drones: responseBody.drones ?? [] }
    : responseBody;
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
  templateName: string
): Promise<{ created: number; updated: number }> {
  const response = await authedFetch(`/api/cubes/${cubeId}/apply-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_name: templateName }),
  });
  return await response.json() as any;
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
  decisions?: Record<string, 'accept' | 'reject'>
): Promise<any> {
  const response = await authedFetch(`/api/cubes/${cubeId}/sync-roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template_name: templateName, apply, ...(decisions ? { decisions } : {}) }),
  });
  return await response.json();
}
