import { createHash, randomBytes } from 'node:crypto';
import { getServerCredential } from './config.js';
import { getActiveCube, type ActiveCube } from './cubes.js';
import { DroneEvictedError } from './drone-lifecycle.js';
import { sendBorgServerAttach } from './server-handshake.js';
import { BorgServerError, BorgServerTrustError } from './server-errors.js';
import { loadBorgServerTrust } from './server-trust.js';
import {
  getActiveSeat,
  prepareSeatReplacement,
  promoteSeatReplacement,
  refreshActiveSeatSession,
  scrubSeatReplacement,
  seatRef,
  type SeatRecord,
} from './seats.js';

export const SESSION_RENEWAL_LEAD_MS = 5 * 60_000;

interface AttachOutcome {
  result: 'created' | 'reused';
  droneId: string;
  sessionId: string;
  expiresAt: string;
}

interface SessionContinuityDeps {
  now(): number;
  randomCredential(): string;
  getSeat(ref: string, binding: { origin: string; trustIdentity: string; cubeId: string }): Promise<SeatRecord | null>;
  getActive(): Promise<ActiveCube | null>;
  getParentCredential(origin: string, trustIdentity: string): Promise<string | null>;
  sendAttach(record: SeatRecord, bearer: string, parentCredential: string): Promise<AttachOutcome>;
  prepareReplacement: typeof prepareSeatReplacement;
  refreshSession: typeof refreshActiveSeatSession;
  promoteReplacement: typeof promoteSeatReplacement;
  scrubReplacement: typeof scrubSeatReplacement;
}

const defaultDeps: SessionContinuityDeps = {
  now: Date.now,
  randomCredential: () => randomBytes(32).toString('base64url'),
  getSeat: getActiveSeat,
  getActive: getActiveCube,
  getParentCredential: getServerCredential,
  async sendAttach(record, bearer, parentCredential) {
    const trust = await loadBorgServerTrust(record.origin);
    if (trust.identity !== record.trustIdentity) {
      throw new BorgServerTrustError('Borg server trust identity changed; refusing session renewal');
    }
    const attached = await sendBorgServerAttach(
      record.origin,
      record.trustIdentity,
      parentCredential,
      {
        cubeId: record.cubeId,
        roleId: record.roleId,
        operation: record.operation,
        priorDroneId: record.droneId,
      },
      bearer,
      { fetchImpl: trust.fetchImpl },
    );
    return {
      result: attached.result,
      droneId: attached.drone.id,
      sessionId: attached.session.sessionId,
      expiresAt: attached.session.expiresAt,
    };
  },
  prepareReplacement: prepareSeatReplacement,
  refreshSession: refreshActiveSeatSession,
  promoteReplacement: promoteSeatReplacement,
  scrubReplacement: scrubSeatReplacement,
};

const inflight = new Map<string, Promise<ActiveCube>>();
const digestOf = (value: string) => createHash('sha256').update(value).digest('hex');

function sameSeat(active: ActiveCube, candidate: ActiveCube | null): candidate is ActiveCube {
  return candidate !== null &&
    candidate.apiUrl === active.apiUrl &&
    candidate.serverTrustIdentity === active.serverTrustIdentity &&
    candidate.cubeId === active.cubeId &&
    candidate.droneId === active.droneId &&
    candidate.localSessionCredentialRef === active.localSessionCredentialRef;
}

function seatBinding(record: SeatRecord) {
  return {
    origin: record.origin,
    trustIdentity: record.trustIdentity,
    cubeId: record.cubeId,
  };
}

function validActiveRecord(active: ActiveCube, record: SeatRecord | null): record is SeatRecord {
  return record !== null &&
    record.state === 'active' &&
    record.origin === active.apiUrl &&
    record.trustIdentity === active.serverTrustIdentity &&
    record.cubeId === active.cubeId &&
    record.droneId === active.droneId &&
    seatRef(record) === active.localSessionCredentialRef;
}

function deterministicAttachFailure(error: unknown): boolean {
  return error instanceof BorgServerError ||
    error instanceof BorgServerTrustError ||
    error instanceof DroneEvictedError;
}

async function reloadSameSeat(
  active: ActiveCube,
  deps: SessionContinuityDeps,
  requireFreshCredential = false,
): Promise<ActiveCube> {
  const current = await deps.getActive();
  if (!sameSeat(active, current) || (requireFreshCredential && current.sessionToken === active.sessionToken)) {
    throw new Error('Session renewal no longer targets the same saved seat');
  }
  return current;
}

async function performRenewal(
  active: ActiveCube,
  mode: 'proactive' | 'expired',
  deps: SessionContinuityDeps,
): Promise<ActiveCube> {
  if (!active.serverTrustIdentity || !active.localSessionCredentialRef) {
    throw new Error('Selected Borg server authority state is missing or unreadable');
  }
  const binding = {
    origin: active.apiUrl,
    trustIdentity: active.serverTrustIdentity,
    cubeId: active.cubeId,
  };
  const record = await deps.getSeat(active.localSessionCredentialRef, binding);
  if (!validActiveRecord(active, record)) {
    throw new Error('Session renewal no longer targets the same saved seat');
  }
  const activeDigest = digestOf(active.sessionToken);
  if (digestOf(record.credential) !== activeDigest) {
    return reloadSameSeat(active, deps, true);
  }
  const expiresIn = Date.parse(record.expiresAt!) - deps.now();
  if (mode === 'proactive' && expiresIn > SESSION_RENEWAL_LEAD_MS && record.replacement === undefined) {
    return active;
  }
  const parentCredential = await deps.getParentCredential(record.origin, record.trustIdentity);
  if (!parentCredential) throw new Error('Selected Borg server parent credential is missing or unreadable');
  const recordBinding = seatBinding(record);

  let restoreRequired = mode === 'expired' || expiresIn <= 0 || record.replacement !== undefined;
  if (!restoreRequired) {
    let attached: AttachOutcome | null = null;
    try {
      attached = await deps.sendAttach(record, record.credential, parentCredential);
    } catch (error) {
      if (error instanceof BorgServerError && error.code === 'AUTH_EXPIRED') {
        restoreRequired = true;
      } else {
        throw error;
      }
    }
    if (!restoreRequired) {
      if (!attached) throw new Error('Session renewal returned no result');
      const renewedExpiry = Date.parse(attached.expiresAt);
      if (
        attached.result !== 'reused' ||
        attached.droneId !== record.droneId ||
        attached.sessionId !== record.sessionId ||
        !Number.isFinite(renewedExpiry) ||
        renewedExpiry <= Date.parse(record.expiresAt!)
      ) {
        throw new Error('Session renewal did not preserve the same saved seat');
      }
      const refreshed = await deps.refreshSession({
        ref: active.localSessionCredentialRef,
        binding: recordBinding,
        expectedDroneId: record.droneId!,
        expectedActiveDigest: activeDigest,
        expectedSessionId: record.sessionId!,
        expiresAt: attached.expiresAt,
      });
      if (!refreshed) return reloadSameSeat(active, deps);
      return reloadSameSeat(active, deps);
    }
  }

  const replacement = await deps.prepareReplacement({
    ref: active.localSessionCredentialRef,
    binding: recordBinding,
    expectedDroneId: record.droneId!,
    expectedActiveDigest: activeDigest,
    replacementCredential: deps.randomCredential(),
  });
  if (!replacement.ok) return reloadSameSeat(active, deps, true);

  let attached: AttachOutcome;
  try {
    attached = await deps.sendAttach(record, replacement.credential, parentCredential);
  } catch (error) {
    if (deterministicAttachFailure(error)) {
      await deps.scrubReplacement({
        ref: active.localSessionCredentialRef,
        binding: recordBinding,
        expectedActiveDigest: activeDigest,
        expectedReplacementDigest: replacement.digest,
      });
    }
    throw error;
  }
  const restoredExpiry = Date.parse(attached.expiresAt);
  if (
    (attached.result !== 'created' && attached.result !== 'reused') ||
    attached.droneId !== record.droneId ||
    attached.sessionId === record.sessionId ||
    !Number.isFinite(restoredExpiry) ||
    restoredExpiry <= deps.now()
  ) {
    await deps.scrubReplacement({
      ref: active.localSessionCredentialRef,
      binding: recordBinding,
      expectedActiveDigest: activeDigest,
      expectedReplacementDigest: replacement.digest,
    });
    throw new Error('Session renewal did not preserve the same saved seat');
  }
  const promoted = await deps.promoteReplacement({
    ref: active.localSessionCredentialRef,
    binding: recordBinding,
    expectedDroneId: record.droneId!,
    expectedActiveDigest: activeDigest,
    expectedReplacementDigest: replacement.digest,
    sessionId: attached.sessionId,
    expiresAt: attached.expiresAt,
  });
  if (promoted !== 'promoted') return reloadSameSeat(active, deps, true);
  return reloadSameSeat(active, deps, true);
}

function renewLocalSession(
  active: ActiveCube,
  mode: 'proactive' | 'expired',
  deps: SessionContinuityDeps,
): Promise<ActiveCube> {
  const key = active.localSessionCredentialRef;
  if (!key) return Promise.reject(new Error('Selected Borg server authority state is missing or unreadable'));
  const existing = inflight.get(key);
  if (existing) return existing;
  const renewal = performRenewal(active, mode, deps);
  inflight.set(key, renewal);
  void renewal.finally(() => {
    if (inflight.get(key) === renewal) inflight.delete(key);
  }).catch(() => {});
  return renewal;
}

export function ensureLocalSessionFresh(active: ActiveCube): Promise<ActiveCube> {
  return renewLocalSession(active, 'proactive', defaultDeps);
}

export function recoverExpiredLocalSession(active: ActiveCube): Promise<ActiveCube> {
  return renewLocalSession(active, 'expired', defaultDeps);
}

/** @internal */
export function __renewLocalSessionForTest(
  active: ActiveCube,
  mode: 'proactive' | 'expired',
  deps: SessionContinuityDeps,
): Promise<ActiveCube> {
  return renewLocalSession(active, mode, deps);
}

/** @internal */
export function __resetSessionContinuityForTest(): void {
  inflight.clear();
}
