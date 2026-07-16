import {
  CUBES_PATH,
  ENROLLMENT_EXCHANGE_PATH,
  HEALTH_PATH,
  PROTOCOL_INFO_PATH,
  createProtocolEnvelope,
  decodeCreateCubeRequest,
  decodeCreateCubeResponseEnvelope,
  decodeEnrollmentExchangeRequest,
  decodeEnrollmentExchangeResponseEnvelope,
  decodeProtocolEnvelope,
  negotiateProtocol,
  type CreateCubeResponse,
  type ProtocolInfo,
  type ServerCapability,
} from 'borgmcp-shared/protocol';
import { randomUUID } from 'node:crypto';
import {
  activatePendingServerEnrollment,
  clearPendingServerCubeCreation,
  clearPendingServerEnrollment,
  getServerCredential,
  getServerCredentialRecord,
  getPendingServerEnrollment,
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
  storeServerSessionCredential,
  type PendingServerCubeCreationRecord,
} from './config.js';
import { BorgServerError } from './server-errors.js';
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
 * Authenticate and negotiate the shared protocol without consulting Cloud.
 * The caller supplies an authority- and trust-bound credential from secure
 * storage; redirects are rejected so bearer credentials never cross origins.
 */
export async function negotiateBorgServer(
  origin: string,
  credential: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProtocolInfo> {
  if (!/^[A-Za-z0-9_-]{43,1024}$/.test(credential)) {
    throw new Error('stored Borg server credential is invalid; enroll this client again');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(handshakeUrl(origin, PROTOCOL_INFO_PATH), {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential}`,
      },
    });
    if (response.status === 401 || response.status === 403) {
      throw new BorgServerError(
        'CREDENTIAL_REJECTED',
        'stored Borg server credential was rejected',
      );
    }
    if (!response.ok) {
      throw new Error(`Borg server protocol handshake failed (HTTP ${response.status})`);
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(await readHandshakeBody(response, controller.signal));
    } catch (error) {
      if (error instanceof Error && error.message.includes('response limit')) throw error;
      throw new Error('Borg server returned an invalid protocol envelope');
    }
    return decodeProtocolEnvelope(decoded, (payload) => negotiateProtocol(payload)).payload;
  } finally {
    clearTimeout(timeout);
  }
}

export interface EnrolledServerConnection {
  token: string;
  trustIdentity: string;
  protocol: ProtocolInfo;
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
    generation: number;
    expiresAt: string | null;
  };
  reattached: boolean;
}

function decodeServerAttachResponse(value: unknown): Omit<ServerAttachResult, 'session'> & {
  session: { token: string; generation: number; expiresAt: string | null };
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Borg server returned an invalid attach response');
  }
  const record = value as Record<string, unknown>;
  const cube = record.cube as Record<string, unknown> | undefined;
  const role = record.role as Record<string, unknown> | undefined;
  const drone = record.drone as Record<string, unknown> | undefined;
  const session = record.session as Record<string, unknown> | undefined;
  const expiresAt = session?.expires_at;
  if (
    !cube || !UUID_RE.test(String(cube.id ?? '')) || typeof cube.name !== 'string' ||
    !role || !UUID_RE.test(String(role.id ?? '')) || typeof role.name !== 'string' ||
    !drone || !UUID_RE.test(String(drone.id ?? '')) || typeof drone.label !== 'string' ||
    !session || typeof session.token !== 'string' ||
    !/^[A-Za-z0-9_-]{43,1024}$/.test(session.token) ||
    !Number.isSafeInteger(session.generation) || Number(session.generation) < 1 ||
    (expiresAt !== null &&
      (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) ||
    typeof record.reattached !== 'boolean'
  ) {
    throw new Error('Borg server returned an invalid attach response');
  }
  const roleClass = role.role_class;
  if (roleClass !== undefined && roleClass !== 'queen' && roleClass !== 'worker') {
    throw new Error('Borg server returned an invalid attach response');
  }
  if (role.is_human_seat !== undefined && typeof role.is_human_seat !== 'boolean') {
    throw new Error('Borg server returned an invalid attach response');
  }
  return {
    cube: { id: String(cube.id), name: cube.name },
    role: {
      id: String(role.id),
      name: role.name,
      ...(roleClass === undefined ? {} : { role_class: roleClass }),
      ...(role.is_human_seat === undefined ? {} : { is_human_seat: role.is_human_seat }),
    },
    drone: { id: String(drone.id), label: drone.label },
    session: {
      token: session.token,
      generation: Number(session.generation),
      expiresAt: expiresAt as string | null,
    },
    reattached: record.reattached,
  };
}

/**
 * Attach an enrolled client principal to one granted cube/role. The response
 * bearer is written to a generation-specific keychain entry before this
 * function returns; only its opaque reference crosses into caller state.
 */
export async function attachBorgServer(
  origin: string,
  trustIdentity: string,
  parentCredential: string,
  request: { cubeId: string; roleId: string; retryKey: string },
  deps: {
    fetchImpl?: FetchLike;
    storeSessionCredential?: typeof storeServerSessionCredential;
  } = {},
): Promise<ServerAttachResult> {
  if (!UUID_RE.test(request.cubeId) || !UUID_RE.test(request.roleId)) {
    throw new Error('Borg server attach requires valid cube and role identities');
  }
  if (!UUID_RE.test(request.retryKey)) {
    throw new Error('Borg server attach retry state is invalid');
  }
  if (!/^[A-Za-z0-9_-]{43,1024}$/.test(parentCredential)) {
    throw new Error('stored Borg server enrollment credential is invalid');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(handshakeUrl(origin, CLIENT_ATTACH_PATH), {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${parentCredential}`,
      },
      body: JSON.stringify(createProtocolEnvelope(randomUUID(), {
        cube_id: request.cubeId,
        role_id: request.roleId,
        retry_key: request.retryKey,
      })),
    });
    if (response.status === 401 || response.status === 403) {
      throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
    }
    if (response.status === 409) {
      throw new BorgServerError('ATTACH_CONFLICT', 'Borg server attach request conflicted');
    }
    if (!response.ok) {
      throw new Error(`Borg server attach failed (HTTP ${response.status})`);
    }

    let decoded: ReturnType<typeof decodeServerAttachResponse>;
    try {
      decoded = decodeProtocolEnvelope(
        JSON.parse(await readHandshakeBody(response, controller.signal)),
        decodeServerAttachResponse,
      ).payload;
    } catch (error) {
      if (error instanceof Error && error.message.includes('response limit')) throw error;
      throw new Error('Borg server returned an invalid attach response');
    }
    if (decoded.cube.id !== request.cubeId || decoded.role.id !== request.roleId) {
      throw new Error('Borg server returned an attach identity outside the request');
    }

    const credentialRef = await (
      deps.storeSessionCredential ?? storeServerSessionCredential
    )({
      origin,
      trustIdentity,
      cubeId: decoded.cube.id,
      droneId: decoded.drone.id,
      generation: decoded.session.generation,
      credential: decoded.session.token,
      expiresAt: decoded.session.expiresAt,
    });
    return {
      cube: decoded.cube,
      role: decoded.role,
      drone: decoded.drone,
      session: {
        credentialRef,
        generation: decoded.session.generation,
        expiresAt: decoded.session.expiresAt,
      },
      reattached: decoded.reattached,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Redeem one invitation after the caller has verified TLS and derived the
 * stable server/CA identity. The client-generated bearer + retry key are
 * persisted PENDING in the OS keychain before the first request. A transport-
 * ambiguous exchange is retried with that exact tuple; only a decoded response
 * followed by an authenticated protocol proof activates the bearer.
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
  const fetchImpl = deps.fetchImpl ?? fetch;
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

  const protocol = await negotiateBorgServer(origin, pending.credential, fetchImpl);
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
  const protocol = await negotiateBorgServer(origin, token, deps.fetchImpl ?? fetch);
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
