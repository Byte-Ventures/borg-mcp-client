import { ATTACH_PATH, CUBES_PATH, ENROLLMENT_EXCHANGE_PATH, HEALTH_PATH, PROTOCOL_INFO_PATH, createAttachRequestEnvelope, createProtocolEnvelope, decodeAttachResponseEnvelope, decodeCreateCubeRequest, decodeCreateCubeResponseEnvelope, decodeEnrollmentExchangeRequest, decodeEnrollmentExchangeResponseEnvelope, decodeProtocolErrorEnvelope, decodeProtocolTagPreflight, ErrorCode, } from 'borgmcp-shared/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { activatePendingServerEnrollment, activatePendingServerSession, clearPendingServerCubeCreation, clearPendingServerEnrollment, compareAndClearPendingServerSession, getServerCredential, getServerCredentialRecord, getPendingServerEnrollment, getOrCreatePendingServerCubeCreation, getOrCreatePendingServerEnrollment, getOrCreatePendingServerSession, serverSessionCredentialRef, } from './config.js';
import { BorgServerError } from './server-errors.js';
import { readBoundedResponseBody } from './server-response.js';
import { loadBorgServerTrust, } from './server-trust.js';
const HANDSHAKE_BODY_LIMIT = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ATTACH_PATH = '/api/client/attach';
export const DEFAULT_LOCAL_SERVER_ORIGIN = 'https://127.0.0.1:7091';
function handshakeUrl(origin, path) {
    return new URL(path, `${origin}/`).toString();
}
/** Bodyless, non-identifying liveness probe from the shared contract. */
export async function probeBorgServer(origin, fetchImpl = fetch, timeoutMs = 750) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(handshakeUrl(origin, HEALTH_PATH), {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
        });
        return response.status === 204;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
const readHandshakeBody = (response, signal) => readBoundedResponseBody(response, HANDSHAKE_BODY_LIMIT, 'Borg server protocol handshake exceeded the response limit', signal);
async function readHandshakeBodyWithTimeout(response) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort(new Error('Borg server protocol handshake timed out'));
    }, HANDSHAKE_TIMEOUT_MS);
    try {
        return await readHandshakeBody(response, controller.signal);
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Credential-free protocol-tag preflight. After the caller has verified pinned
 * TLS, confirm the server speaks the exact protocol tag BEFORE any bearer is
 * created, sent, or a seat attached. Sends NO Authorization header, cookie,
 * query, or body; rejects redirects; and bounds the response. A tag mismatch,
 * an extra field, or any transport anomaly fails closed here — no keychain
 * write, no attach, no Cloud fallback. The bearer is proven only at attach.
 */
export async function preflightBorgServerTag(origin, fetchImpl = fetch) {
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
        let decoded;
        try {
            decoded = JSON.parse(await readHandshakeBody(response, controller.signal));
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('response limit'))
                throw error;
            throw new Error('Borg server returned an invalid protocol preflight');
        }
        return decodeProtocolTagPreflight(decoded);
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function prepareBorgServerAttach(origin, trustIdentity, parentCredential, request, deps = {}) {
    if (!UUID_RE.test(request.cubeId) || !UUID_RE.test(request.roleId)) {
        throw new Error('Borg server attach requires valid cube and role identities');
    }
    if (request.priorDroneId !== undefined && !UUID_RE.test(request.priorDroneId)) {
        throw new Error('Borg server attach prior drone identity is invalid');
    }
    if (!/^[A-Za-z0-9_-]{43,1024}$/.test(parentCredential)) {
        throw new Error('stored Borg server enrollment credential is invalid');
    }
    // Generate + persist the client bearer before contact; a retry re-sends the
    // exact same pending bearer so the server resolves the identical session.
    const pending = await (deps.getPendingSession ?? getOrCreatePendingServerSession)({
        origin,
        trustIdentity,
        cubeId: request.cubeId,
        roleId: request.roleId,
        operation: request.operation,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
        const response = await (deps.fetchImpl ?? fetch)(handshakeUrl(origin, ATTACH_PATH), {
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
        if (response.status === 401 || response.status === 403) {
            // A typed SESSION_REJECTED body means the presented bearer targets a seat
            // already bound to a different session (takeover), distinct from a rejected
            // parent enrollment credential. Decode defensively; any anomaly falls back
            // to the generic credential rejection below. Never echo the response body.
            if (response.status === 401) {
                let rejectedCode;
                try {
                    rejectedCode = decodeProtocolErrorEnvelope(JSON.parse(await readHandshakeBody(response, controller.signal))).error.code;
                }
                catch {
                    rejectedCode = undefined;
                }
                if (rejectedCode === ErrorCode.SESSION_REJECTED) {
                    throw new BorgServerError('SESSION_REJECTED', 'Borg server rejected the session: the seat is already bound to another session');
                }
            }
            throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
        }
        if (response.status === 409) {
            throw new BorgServerError('ATTACH_CONFLICT', 'Borg server attach request conflicted');
        }
        if (!response.ok) {
            throw new Error(`Borg server attach failed (HTTP ${response.status})`);
        }
        let decoded;
        try {
            decoded = decodeAttachResponseEnvelope(JSON.parse(await readHandshakeBody(response, controller.signal))).payload;
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('response limit'))
                throw error;
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
        const credentialRef = (deps.sessionCredentialRef ?? serverSessionCredentialRef)(seatInput);
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
            // The single keychain pending→ACTIVE flip — invoked LAST by the FINALIZE
            // composite, after the cubes binding is persisted, under the cube lock.
            activate: () => (deps.activateSession ?? activatePendingServerSession)({
                ...seatInput,
                droneId: decoded.drone.id,
                sessionId: decoded.session.id,
                expiresAt: decoded.session.expires_at,
            }),
            // Abort-scrub of ONLY this own pending record (never an ACTIVE record, never
            // a same-ref replacement) — invoked by FINALIZE on an expectation mismatch.
            scrubPending: () => (deps.scrubPending ?? compareAndClearPendingServerSession)(credentialRef, { origin, trustIdentity, cubeId: request.cubeId }, pendingBearerDigest),
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * PREPARE + network + activate, as a single call (the pre-composite contract).
 * Retained for callers/tests that do not drive the cube-lock-held FINALIZE
 * themselves; the assimilate orchestration now uses prepareBorgServerAttach +
 * finalizeServerSeatAttachment so the binding lands BEFORE the pending→ACTIVE flip.
 */
export async function attachBorgServer(origin, trustIdentity, parentCredential, request, deps = {}) {
    const prepared = await prepareBorgServerAttach(origin, trustIdentity, parentCredential, request, deps);
    const credentialRef = await prepared.activate();
    return {
        cube: prepared.cube,
        role: prepared.role,
        drone: prepared.drone,
        session: {
            credentialRef,
            sessionId: prepared.session.sessionId,
            expiresAt: prepared.session.expiresAt,
        },
        result: prepared.result,
    };
}
/**
 * Redeem one invitation after the caller has verified TLS and derived the
 * stable server/CA identity. The client-generated bearer + retry key are
 * persisted PENDING in the OS keychain before the first request. A transport-
 * ambiguous exchange is retried with that exact tuple; only a decoded response
 * followed by an authenticated protocol proof activates the bearer.
 */
export async function enrollBorgServer(origin, trustIdentity, invitation, deps = {}) {
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
    let response = null;
    let lastTransportError;
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
        }
        catch (error) {
            lastTransportError = error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    if (!response)
        throw lastTransportError;
    if (response.status === 401 || response.status === 403) {
        await (deps.clearPendingEnrollment ?? clearPendingServerEnrollment)(origin, trustIdentity, pending.retryKey);
        throw new BorgServerError('INVITATION_REJECTED', 'the invitation was rejected or expired');
    }
    if (response.status !== 201) {
        throw new Error(`Borg server enrollment failed (HTTP ${response.status})`);
    }
    let decoded;
    try {
        decoded = decodeEnrollmentExchangeResponseEnvelope(JSON.parse(await readHandshakeBodyWithTimeout(response)));
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('response limit'))
            throw error;
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
export async function resumeBorgServerEnrollment(origin, trustIdentity, deps = {}) {
    const pending = await (deps.loadPendingEnrollment ?? getPendingServerEnrollment)(origin, trustIdentity);
    if (!pending)
        return null;
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
export async function createBorgServerCube(origin, trustIdentity, parentCredential, input, deps = {}) {
    const active = await (deps.loadCredentialRecord ?? getServerCredentialRecord)(origin, trustIdentity);
    if (!active || active.credential !== parentCredential) {
        throw new BorgServerError('CREDENTIAL_REJECTED', 'stored Borg server credential was rejected');
    }
    if (!active.clientId || !active.serverCapabilities.includes('create_cube')) {
        throw new BorgServerError('CREATE_CUBE_DENIED', 'This Borg server client is not authorized to create cubes');
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
    let response = null;
    let lastTransportError;
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
        }
        catch (error) {
            lastTransportError = error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    if (!response)
        throw lastTransportError;
    if (response.status === 401 || response.status === 403) {
        throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
    }
    if (response.status === 404) {
        throw new BorgServerError('CREATE_CUBE_DENIED', 'This Borg server client is not authorized to create cubes');
    }
    if (response.status === 409) {
        throw new Error('Borg server cube creation retry state conflicted');
    }
    if (response.status !== 201) {
        throw new Error(`Borg server cube creation failed (HTTP ${response.status})`);
    }
    let decoded;
    try {
        decoded = decodeCreateCubeResponseEnvelope(JSON.parse(await readHandshakeBodyWithTimeout(response)));
    }
    catch (error) {
        if (error instanceof Error && error.message.includes('response limit'))
            throw error;
        throw new Error('Borg server returned an invalid cube creation envelope');
    }
    await (deps.clearCubeCreation ?? clearPendingServerCubeCreation)(pending);
    return decoded.payload;
}
export async function createLocalBorgServerCube(origin, trustIdentity, parentCredential, input, deps = {}) {
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
export async function connectEnrolledBorgServer(origin, trustIdentity, deps = {}) {
    const active = deps.loadCredentialRecord
        ? await deps.loadCredentialRecord(origin, trustIdentity)
        : deps.loadCredential
            ? null
            : await getServerCredentialRecord(origin, trustIdentity);
    const token = active?.credential ?? await (deps.loadCredential ?? getServerCredential)(origin, trustIdentity);
    if (!token) {
        throw new BorgServerError('NOT_ENROLLED', 'no enrolled credential is stored for this Borg server identity');
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
export async function resolveBorgServerAuthority(origin, deps = {}) {
    const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
    const active = deps.loadCredentialRecord
        ? await deps.loadCredentialRecord(origin, trust.identity)
        : deps.loadCredential
            ? null
            : await getServerCredentialRecord(origin, trust.identity);
    const token = active?.credential ?? await (deps.loadCredential ?? getServerCredential)(origin, trust.identity);
    if (!token) {
        throw new BorgServerError('NOT_ENROLLED', 'no enrolled credential is stored for this Borg server identity');
    }
    return { ...trust, token };
}
/** Load pinned trust, then prove the stored credential against /api/protocol. */
export async function connectLocalBorgServer(origin, deps = {}) {
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
export async function enrollLocalBorgServer(origin, invitation, deps = {}) {
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
export async function resumeLocalBorgServerEnrollment(origin, deps = {}) {
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
export async function probeLocalBorgServer(origin) {
    try {
        const trust = await loadBorgServerTrust(origin);
        return await probeBorgServer(origin, trust.fetchImpl);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=server-handshake.js.map