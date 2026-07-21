import {
  ATTACH_PATH,
  CUBES_PATH,
  ENROLLMENT_EXCHANGE_PATH,
  HEALTH_PATH,
  PROTOCOL_INFO_PATH,
  createAttachRequestEnvelope,
  createProtocolEnvelope,
  decodeAttachResponseEnvelope,
  decodeCreateCubeRequest,
  decodeCreateCubeResponseEnvelope,
  decodeEnrollmentExchangeRequest,
  decodeEnrollmentExchangeResponseEnvelope,
  decodeProtocolErrorEnvelope,
  decodeProtocolTagPreflight,
  ErrorCode,
  type CreateCubeResponse,
  type ProtocolTagPreflight,
  type ServerCapability,
} from 'borgmcp-shared/protocol';
import { createHash, randomUUID } from 'node:crypto';
import {
  activatePendingServerEnrollment,
  clearPendingServerCubeCreation,
  clearPendingServerEnrollment,
  getServerCredential,
  getServerCredentialRecord,
  getPendingServerEnrollment,
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
  type PendingServerCubeCreationRecord,
} from './config.js';
import {
  activateAndBindSeat,
  bindPendingSeatToWorktree,
  scrubPendingSeat,
  seatRef,
  type ActivateSeatOutcome,
  type BindPendingSeatOutcome,
  type SeatBinding,
  type SeatOperation as ServerSessionOperation,
} from './seats.js';
import { BorgServerError, BorgServerUnreachableError } from './server-errors.js';
import { DroneEvictedError, DRONE_EVICTED_CODE } from './drone-lifecycle.js';
import { readBoundedResponseBody } from './server-response.js';
import {
  loadBorgServerTrust,
  type BorgServerTrust,
} from './server-trust.js';

const HANDSHAKE_BODY_LIMIT = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ATTACH_PATH = '/api/client/attach';
export const DEFAULT_LOCAL_SERVER_ORIGIN = 'https://127.0.0.1:7091' as const;

type FetchLike = typeof fetch;

function handshakeUrl(origin: string, path: string): string {
  return new URL(path, `${origin}/`).toString();
}

/** Bodyless, non-identifying liveness probe from the shared contract. */
export async function probeBorgServer(
  origin: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 750,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(handshakeUrl(origin, HEALTH_PATH), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    return response.status === 204;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const readHandshakeBody = (response: Response, signal?: AbortSignal) =>
  readBoundedResponseBody(
    response,
    HANDSHAKE_BODY_LIMIT,
    'Borg server protocol handshake exceeded the response limit',
    signal,
  );

async function readHandshakeBodyWithTimeout(response: Response): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error('Borg server protocol handshake timed out'));
  }, HANDSHAKE_TIMEOUT_MS);
  try {
    return await readHandshakeBody(response, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Credential-free protocol-tag preflight. After the caller has verified pinned
 * TLS, confirm the server speaks the exact protocol tag BEFORE any bearer is
 * created, sent, or a seat attached. Sends NO Authorization header, cookie,
 * query, or body; rejects redirects; and bounds the response. A tag mismatch,
 * an extra field, or any transport anomaly fails closed here — no keychain
 * write and no attach. The bearer is proven only at attach.
 */
export async function preflightBorgServerTag(
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProtocolTagPreflight> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(handshakeUrl(origin, PROTOCOL_INFO_PATH), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Borg server protocol preflight failed (HTTP ${response.status})`);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(await readHandshakeBody(response, controller.signal));
    } catch (error) {
      if (error instanceof Error && error.message.includes('response limit')) throw error;
      throw new Error('Borg server returned an invalid protocol preflight');
    }
    return decodeProtocolTagPreflight(decoded);
  } finally {
    clearTimeout(timeout);
  }
}

export interface EnrolledServerConnection {
  token: string;
  trustIdentity: string;
  protocol: ProtocolTagPreflight;
  clientId?: string | null;
  serverCapabilities?: ServerCapability[];
}

export interface ResolvedServerAuthority extends BorgServerTrust {
  token: string;
}

export interface NewServerEnrollment extends EnrolledServerConnection {
  clientId: string;
  serverCapabilities: ServerCapability[];
}

export interface ServerAttachResult {
  cube: { id: string; name: string };
  role: {
    id: string;
    name: string;
    role_class?: 'queen' | 'worker';
    is_human_seat?: boolean;
  };
  drone: { id: string; label: string };
  session: {
    credentialRef: string;
    sessionId: string;
    expiresAt: string;
  };
  result: 'created' | 'reused';
}

/**
 * Attach an enrolled client principal to one granted cube/role over protocol v2.
 * The client CSPRNG-generates the session bearer and persists it PENDING in the
 * OS keychain (keyed by the stable per-seat identity) BEFORE this request, so an
 * interrupted/lost response is recovered by re-sending the exact same bearer —
 * the server binds only its digest. A verified `created`/`reused` response
 * activates that pending record in place; the server never returns a bearer.
 */
/**
 * The PREPARE + network half of an attach, WITHOUT the keychain pending→ACTIVE
 * transition. The deferred `activate` / `scrubPending` thunks let the cube-lock-
 * owning orchestration (assimilate) FINALIZE binding-FIRST: write the cubes
 * binding referencing this exact pending record under the cube lock, THEN call
 * `activate()` as the single last step. `credentialRef` is the deterministic
 * per-seat account, known here (before activation) so the binding can reference
 * it. `scrubPending` compare-and-scrubs ONLY this own pending record on a
 * FINALIZE abort.
 */
export interface PreparedServerAttach {
  cube: ServerAttachResult['cube'];
  role: ServerAttachResult['role'];
  drone: ServerAttachResult['drone'];
  session: { sessionId: string; expiresAt: string };
  result: 'created' | 'reused';
  credentialRef: string;
  pendingBearerDigest: string;
  /** The single-store ATOMIC activate+bind (CR#2 collapse): given the worktree
   *  binding + display (known only at FINALIZE), stamp the exact digest-matched
   *  PENDING record ACTIVE and bind the worktree in ONE commit. Returns the typed
   *  outcome (`activated`/`missing`/`replaced`) — never throws for a race. */
  activate: (binding: SeatBinding) => Promise<ActivateSeatOutcome>;
  scrubPending: () => Promise<boolean>;
  /** CR#2: bind the EXACT digest-matched PENDING record to the preserved worktree
   *  WITHOUT activating (it stays pending). Invoked by the activation-failure path so
   *  the preserved sibling worktree owns a discoverable, resumable pending record —
   *  the rerun FROM there re-derives the exact ref and re-sends the identical bearer
   *  (ghost-free convergence). Fail-closed typed outcome; never throws for a race. */
  bindPending: (binding: SeatBinding) => Promise<BindPendingSeatOutcome>;
}

/**
 * The NETWORK-ONLY half of an attach: POST the ALREADY-MINTED pending bearer and
 * decode, WITHOUT minting (the mint is owned by the single-store prepareSeat, CR#1).
 * Returns the deferred activate/scrubPending handles: FINALIZE calls `activate`
 * with the decided worktree binding, and activateAndBindSeat stamps ACTIVE + binds
 * the worktree in ONE atomic commit (activate+bind merged — no cross-store gap).
 */
export async function sendBorgServerAttach(
  origin: string,
  trustIdentity: string,
  parentCredential: string,
  request: {
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    priorDroneId?: string;
  },
  pendingBearer: string,
  deps: {
    fetchImpl?: FetchLike;
    activateAndBind?: typeof activateAndBindSeat;
    bindPending?: typeof bindPendingSeatToWorktree;
    scrubPending?: typeof scrubPendingSeat;
    sessionCredentialRef?: typeof seatRef;
  } = {},
): Promise<PreparedServerAttach> {
  if (!UUID_RE.test(request.cubeId) || !UUID_RE.test(request.roleId)) {
    throw new Error('Borg server attach requires valid cube and role identities');
  }
  if (request.priorDroneId !== undefined && !UUID_RE.test(request.priorDroneId)) {
    throw new Error('Borg server attach prior drone identity is invalid');
  }
  if (!/^[A-Za-z0-9_-]{43,1024}$/.test(parentCredential)) {
    throw new Error('stored Borg server enrollment credential is invalid');
  }
  const pending = { credential: pendingBearer };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (deps.fetchImpl ?? fetch)(handshakeUrl(origin, ATTACH_PATH), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parentCredential}`,
        },
        body: JSON.stringify(createAttachRequestEnvelope(randomUUID(), {
          cube_id: request.cubeId,
          role_id: request.roleId,
          session_credential: pending.credential,
          ...(request.priorDroneId === undefined
            ? {}
            : { prior_drone_id: request.priorDroneId }),
        })),
      });
    } catch (error) {
      throw new BorgServerUnreachableError('Borg server attach transport failed', { cause: error });
    }
    if (response.status === 401 || response.status === 403 || response.status === 410) {
      // A typed SESSION_REJECTED body means the presented bearer targets a seat
      // already bound to a different session (takeover), distinct from a rejected
      // parent enrollment credential. Decode defensively; any anomaly falls back
      // to the generic credential rejection below. Never echo the response body.
      if (response.status === 401 || response.status === 410) {
        let rejectedCode: ErrorCode | undefined;
        try {
          rejectedCode = decodeProtocolErrorEnvelope(
            JSON.parse(await readHandshakeBody(response, controller.signal)),
          ).error.code;
        } catch {
          rejectedCode = undefined;
        }
        if (rejectedCode === ErrorCode.SESSION_REJECTED) {
          throw new BorgServerError(
            'SESSION_REJECTED',
            'Borg server rejected the session: the seat is already bound to another session',
          );
        }
        if (rejectedCode === ErrorCode.AUTH_EXPIRED) {
          throw new BorgServerError(
            'AUTH_EXPIRED',
            'Borg server session expired',
          );
        }
        if (rejectedCode === ErrorCode.SESSION_REVOKED) {
          throw new BorgServerError(
            'SESSION_REVOKED',
            'Borg server session was revoked',
          );
        }
        if (response.status === 410 && rejectedCode === DRONE_EVICTED_CODE) {
          throw new DroneEvictedError();
        }
      }
      if (response.status === 410) throw new Error('Borg server attach failed (HTTP 410)');
      throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
    }
    if (response.status === 409) {
      throw new BorgServerError('ATTACH_CONFLICT', 'Borg server attach request conflicted');
    }
    if (!response.ok) {
      throw new Error(`Borg server attach failed (HTTP ${response.status})`);
    }

    let decoded: ReturnType<typeof decodeAttachResponseEnvelope>['payload'];
    try {
      decoded = decodeAttachResponseEnvelope(
        JSON.parse(await readHandshakeBody(response, controller.signal)),
      ).payload;
    } catch (error) {
      if (error instanceof Error && error.message.includes('response limit')) throw error;
      throw new Error('Borg server returned an invalid attach response');
    }
    if (decoded.cube.id !== request.cubeId || decoded.role.id !== request.roleId) {
      throw new Error('Borg server returned an attach identity outside the request');
    }

    const seatInput = {
      origin,
      trustIdentity,
      cubeId: request.cubeId,
      roleId: request.roleId,
      operation: request.operation,
    };
    const credentialRef = (deps.sessionCredentialRef ?? seatRef)(seatInput);
    const pendingBearerDigest = createHash('sha256').update(pending.credential).digest('hex');
    return {
      cube: decoded.cube,
      role: decoded.role,
      drone: decoded.drone,
      session: {
        sessionId: decoded.session.id,
        expiresAt: decoded.session.expires_at,
      },
      result: decoded.result,
      credentialRef,
      pendingBearerDigest,
      // The single-store ATOMIC activate+bind — invoked by FINALIZE with the decided
      // worktree binding. Stamps server metadata + the worktree binding ONLY onto the
      // EXACT pending record whose bearer we sent (digest-matched), in ONE commit. A
      // same-ref replacement or a concurrent delete aborts (`replaced`/`missing`) —
      // never binds bearer A's server session onto bearer B, and never leaves an
      // ACTIVE credential without a binding (they land together).
      activate: (binding: SeatBinding) =>
        (deps.activateAndBind ?? activateAndBindSeat)({
          ...seatInput,
          droneId: decoded.drone.id,
          sessionId: decoded.session.id,
          expiresAt: decoded.session.expires_at,
          expectedPendingDigest: pendingBearerDigest,
          worktree: binding.worktree,
          name: binding.name,
          droneLabel: binding.droneLabel,
          ...(binding.roleName !== undefined ? { roleName: binding.roleName } : {}),
          ...(binding.roleClass !== undefined ? { roleClass: binding.roleClass } : {}),
          ...(binding.isHumanSeat !== undefined ? { isHumanSeat: binding.isHumanSeat } : {}),
        }),
      // Abort-scrub of ONLY this own pending record (never an ACTIVE record, never
      // a same-ref replacement) — invoked when the server did not honor the
      // reattach/remint intent.
      scrubPending: () => (deps.scrubPending ?? scrubPendingSeat)(
        credentialRef,
        { origin, trustIdentity, cubeId: request.cubeId },
        pendingBearerDigest,
      ),
      // CR#2: on activation failure, bind the EXACT digest-matched PENDING record to
      // the preserved (spawned) worktree WITHOUT activating it — it stays pending, so
      // it is non-hydratable as a live seat but IS discoverable/resumable from that
      // worktree. The rerun re-sends the identical bearer and converges (no ghost).
      bindPending: (binding: SeatBinding) =>
        (deps.bindPending ?? bindPendingSeatToWorktree)({
          ...seatInput,
          expectedPendingDigest: pendingBearerDigest,
          droneId: decoded.drone.id,
          worktree: binding.worktree,
          name: binding.name,
          droneLabel: binding.droneLabel,
          ...(binding.roleName !== undefined ? { roleName: binding.roleName } : {}),
          ...(binding.roleClass !== undefined ? { roleClass: binding.roleClass } : {}),
          ...(binding.isHumanSeat !== undefined ? { isHumanSeat: binding.isHumanSeat } : {}),
        }),
    };
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof BorgServerUnreachableError)) {
      throw new BorgServerUnreachableError('Borg server attach transport timed out', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// SR-seven (c): the pre-composite mint-without-cube-lock seams (prepareBorgServerAttach)
// and the activate-first no-binding wrapper (attachBorgServer) are DELETED — there is
// no code path, not even test-only, that mints/sends a session_credential outside the
// cube-owned composite. The ONLY session-credential send is sendBorgServerAttach, driven
// by assimilate-deps AFTER prepareSeat has minted under the single store flock.

/**
 * Redeem one invitation after the caller has verified TLS and derived the
 * stable server/CA identity. The client-generated bearer + retry key are
 * persisted PENDING in the local 0600 file store before the first request. A
 * transport-ambiguous exchange is retried with that exact tuple; only a decoded
 * response followed by an authenticated protocol proof activates the bearer.
 */
export async function enrollBorgServer(
  origin: string,
  trustIdentity: string,
  invitation: string,
  deps: {
    fetchImpl?: FetchLike;
    prepareEnrollment?: typeof getOrCreatePendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    clientName?: string;
  } = {},
): Promise<NewServerEnrollment> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // Credential-free tag preflight FIRST (CR fb4d6eba): after pinned TLS, an
  // incompatible server must be rejected before any credential is created or
  // persisted and before any invitation/secret-bearing request is sent.
  const protocol = await preflightBorgServerTag(origin, fetchImpl);

  const pending = await (deps.prepareEnrollment ?? getOrCreatePendingServerEnrollment)({
    origin,
    trustIdentity,
    invitation,
    ...(deps.clientName ? { clientName: deps.clientName } : {}),
  });
  const request = decodeEnrollmentExchangeRequest({
    invitation: pending.invitation,
    retry_key: pending.retryKey,
    client_credential: pending.credential,
    ...(pending.clientName ? { client_name: pending.clientName } : {}),
  });
  let response: Response | null = null;
  let lastTransportError: unknown;
  for (let attempt = 0; attempt < 2 && response === null; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      response = await fetchImpl(handshakeUrl(origin, ENROLLMENT_EXCHANGE_PATH), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(createProtocolEnvelope(randomUUID(), request)),
      });
    } catch (error) {
      lastTransportError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response) throw lastTransportError;

  if (response.status === 401 || response.status === 403) {
    await (deps.clearPendingEnrollment ?? clearPendingServerEnrollment)(
      origin,
      trustIdentity,
      pending.retryKey,
    );
    throw new BorgServerError(
      'INVITATION_REJECTED',
      'the invitation was rejected or expired',
    );
  }
  if (response.status !== 201) {
    throw new Error(`Borg server enrollment failed (HTTP ${response.status})`);
  }
  let decoded: ReturnType<typeof decodeEnrollmentExchangeResponseEnvelope>;
  try {
    decoded = decodeEnrollmentExchangeResponseEnvelope(
      JSON.parse(await readHandshakeBodyWithTimeout(response)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('response limit')) throw error;
    throw new Error('Borg server returned an invalid enrollment envelope');
  }

  await (deps.activateEnrollment ?? activatePendingServerEnrollment)({
    origin,
    trustIdentity,
    retryKey: pending.retryKey,
    credential: pending.credential,
    clientId: decoded.payload.client_id,
    serverCapabilities: decoded.payload.server_capabilities,
  });
  return {
    token: pending.credential,
    trustIdentity,
    protocol,
    clientId: decoded.payload.client_id,
    serverCapabilities: decoded.payload.server_capabilities,
  };
}

/** Resume an exact durable enrollment tuple without asking for the invitation again. */
export async function resumeBorgServerEnrollment(
  origin: string,
  trustIdentity: string,
  deps: {
    fetchImpl?: FetchLike;
    loadPendingEnrollment?: typeof getPendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    onPending?: () => void;
  } = {},
): Promise<NewServerEnrollment | null> {
  const pending = await (deps.loadPendingEnrollment ?? getPendingServerEnrollment)(
    origin,
    trustIdentity,
  );
  if (!pending) return null;
  deps.onPending?.();
  return enrollBorgServer(origin, trustIdentity, pending.invitation, {
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    prepareEnrollment: async () => pending,
    ...(deps.activateEnrollment === undefined
      ? {}
      : { activateEnrollment: deps.activateEnrollment }),
    ...(deps.clearPendingEnrollment === undefined
      ? {}
      : { clearPendingEnrollment: deps.clearPendingEnrollment }),
    ...(pending.clientName === undefined ? {} : { clientName: pending.clientName }),
  });
}

/**
 * Create one repository cube through the narrow owner capability. The retry
 * key is persisted in the OS keychain before network I/O and reused exactly
 * after an ambiguous transport result. Ordinary clients are denied locally
 * before any create request is sent.
 */
export async function createBorgServerCube(
  origin: string,
  trustIdentity: string,
  parentCredential: string,
  input: { projectRoot: string; name: string },
  deps: {
    fetchImpl?: FetchLike;
    loadCredentialRecord?: typeof getServerCredentialRecord;
    prepareCubeCreation?: typeof getOrCreatePendingServerCubeCreation;
    clearCubeCreation?: typeof clearPendingServerCubeCreation;
  } = {},
): Promise<CreateCubeResponse> {
  const active = await (deps.loadCredentialRecord ?? getServerCredentialRecord)(
    origin,
    trustIdentity,
  );
  if (!active || active.credential !== parentCredential) {
    throw new BorgServerError('CREDENTIAL_REJECTED', 'stored Borg server credential was rejected');
  }
  if (!active.clientId || !active.serverCapabilities.includes('create_cube')) {
    throw new BorgServerError(
      'CREATE_CUBE_DENIED',
      'This Borg server client is not authorized to create cubes',
    );
  }
  const pending = await (deps.prepareCubeCreation ?? getOrCreatePendingServerCubeCreation)({
    origin,
    trustIdentity,
    clientId: active.clientId,
    projectRoot: input.projectRoot,
    name: input.name,
    template: 'default',
  });
  const request = decodeCreateCubeRequest({
    retry_key: pending.retryKey,
    name: pending.name,
    template: pending.template,
  });

  const fetchImpl = deps.fetchImpl ?? fetch;
  let response: Response | null = null;
  let lastTransportError: unknown;
  for (let attempt = 0; attempt < 2 && response === null; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      response = await fetchImpl(handshakeUrl(origin, CUBES_PATH), {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${parentCredential}`,
        },
        body: JSON.stringify(createProtocolEnvelope(randomUUID(), request)),
      });
    } catch (error) {
      lastTransportError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  if (!response) throw lastTransportError;
  if (response.status === 401 || response.status === 403) {
    throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
  }
  if (response.status === 404) {
    throw new BorgServerError(
      'CREATE_CUBE_DENIED',
      'This Borg server client is not authorized to create cubes',
    );
  }
  if (response.status === 409) {
    throw new Error('Borg server cube creation retry state conflicted');
  }
  if (response.status !== 201) {
    throw new Error(`Borg server cube creation failed (HTTP ${response.status})`);
  }
  let decoded: ReturnType<typeof decodeCreateCubeResponseEnvelope>;
  try {
    decoded = decodeCreateCubeResponseEnvelope(
      JSON.parse(await readHandshakeBodyWithTimeout(response)),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes('response limit')) throw error;
    throw new Error('Borg server returned an invalid cube creation envelope');
  }
  await (deps.clearCubeCreation ?? clearPendingServerCubeCreation)(
    pending as PendingServerCubeCreationRecord,
  );
  return decoded.payload;
}

export async function createLocalBorgServerCube(
  origin: string,
  trustIdentity: string,
  parentCredential: string,
  input: { projectRoot: string; name: string },
  deps: { loadTrust?: typeof loadBorgServerTrust } = {},
): Promise<CreateCubeResponse> {
  const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
  if (trust.identity !== trustIdentity) {
    throw new Error('Borg server trust identity changed; refusing cube creation');
  }
  return createBorgServerCube(origin, trustIdentity, parentCredential, input, {
    fetchImpl: trust.fetchImpl,
  });
}

/**
 * Swappable Part-4 integration seam. Trust verification supplies the server/CA
 * identity; this function then reads only the credential bound to that exact
 * origin+identity pair and negotiates the authenticated shared contract.
 */
export async function connectEnrolledBorgServer(
  origin: string,
  trustIdentity: string,
  deps: {
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
    fetchImpl?: FetchLike;
  } = {},
): Promise<EnrolledServerConnection> {
  const active = deps.loadCredentialRecord
    ? await deps.loadCredentialRecord(origin, trustIdentity)
    : deps.loadCredential
      ? null
      : await getServerCredentialRecord(origin, trustIdentity);
  const token = active?.credential ?? await (deps.loadCredential ?? getServerCredential)(
    origin,
    trustIdentity,
  );
  if (!token) {
    throw new BorgServerError(
      'NOT_ENROLLED',
      'no enrolled credential is stored for this Borg server identity',
    );
  }
  const protocol = await preflightBorgServerTag(origin, deps.fetchImpl ?? fetch);
  return {
    token,
    trustIdentity,
    protocol,
    ...(active === null ? {} : {
      clientId: active.clientId,
      serverCapabilities: active.serverCapabilities,
    }),
  };
}

/** Resolve the same-user server CA and its authority-bound keychain credential. */
export async function resolveBorgServerAuthority(
  origin: string,
  deps: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
  } = {},
): Promise<ResolvedServerAuthority> {
  const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
  const active = deps.loadCredentialRecord
    ? await deps.loadCredentialRecord(origin, trust.identity)
    : deps.loadCredential
      ? null
      : await getServerCredentialRecord(origin, trust.identity);
  const token = active?.credential ?? await (deps.loadCredential ?? getServerCredential)(
    origin,
    trust.identity,
  );
  if (!token) {
    throw new BorgServerError(
      'NOT_ENROLLED',
      'no enrolled credential is stored for this Borg server identity',
    );
  }
  return { ...trust, token };
}

/** Load pinned trust, then prove the stored credential against /api/protocol. */
export async function connectLocalBorgServer(
  origin: string,
  deps: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
  } = {},
): Promise<EnrolledServerConnection> {
  const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
  return connectEnrolledBorgServer(origin, trust.identity, {
    fetchImpl: trust.fetchImpl,
    ...(deps.loadCredential === undefined ? {} : { loadCredential: deps.loadCredential }),
    ...(deps.loadCredentialRecord === undefined
      ? {}
      : { loadCredentialRecord: deps.loadCredentialRecord }),
  });
}

/** Load and verify the local CA before sending an enrollment invitation. */
export async function enrollLocalBorgServer(
  origin: string,
  invitation: string,
  deps: {
    loadTrust?: typeof loadBorgServerTrust;
    prepareEnrollment?: typeof getOrCreatePendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    clientName?: string;
  } = {},
): Promise<NewServerEnrollment> {
  const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
  return enrollBorgServer(origin, trust.identity, invitation, {
    fetchImpl: trust.fetchImpl,
    ...(deps.prepareEnrollment === undefined ? {} : { prepareEnrollment: deps.prepareEnrollment }),
    ...(deps.activateEnrollment === undefined ? {} : { activateEnrollment: deps.activateEnrollment }),
    ...(deps.clearPendingEnrollment === undefined
      ? {}
      : { clearPendingEnrollment: deps.clearPendingEnrollment }),
    ...(deps.clientName === undefined ? {} : { clientName: deps.clientName }),
  });
}

/** Load verified trust and resume a prior ambiguous enrollment before prompting. */
export async function resumeLocalBorgServerEnrollment(
  origin: string,
  deps: {
    loadTrust?: typeof loadBorgServerTrust;
    loadPendingEnrollment?: typeof getPendingServerEnrollment;
    onPending?: () => void;
  } = {},
): Promise<NewServerEnrollment | null> {
  const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
  return resumeBorgServerEnrollment(origin, trust.identity, {
    fetchImpl: trust.fetchImpl,
    ...(deps.loadPendingEnrollment === undefined
      ? {}
      : { loadPendingEnrollment: deps.loadPendingEnrollment }),
    ...(deps.onPending === undefined ? {} : { onPending: deps.onPending }),
  });
}

/** Advisory discovery that still verifies the server-owned CA. */
export async function probeLocalBorgServer(origin: string): Promise<boolean> {
  try {
    const trust = await loadBorgServerTrust(origin);
    return await probeBorgServer(origin, trust.fetchImpl);
  } catch {
    return false;
  }
}
