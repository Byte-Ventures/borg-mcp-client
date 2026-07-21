import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __renewLocalSessionForTest,
  __resetSessionContinuityForTest,
  SESSION_RENEWAL_LEAD_MS,
} from '../src/session-continuity.js';
import { BorgServerError } from '../src/server-errors.js';

const ORIGIN = 'https://127.0.0.1:7091';
const TRUST = 'spki-sha256:test-server';
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const DRONE_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const OPERATION = { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' };
const REF = `borg-server-session:${createHash('sha256')
  .update(ORIGIN).update('\0').update(TRUST).update('\0').update(CUBE_ID).update('\0')
  .update(ROLE_ID).update('\0').update(OPERATION.projectRoot).update('\0')
  .update(OPERATION.kind).update('\0').update(OPERATION.operationKey).digest('hex')}`;
const OLD = 'o'.repeat(43);
const FRESH = 'f'.repeat(43);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const active = {
  cubeId: CUBE_ID,
  droneId: DRONE_ID,
  name: 'cube',
  sessionToken: OLD,
  droneLabel: 'builder-1',
  apiUrl: ORIGIN,
  serverTrustIdentity: TRUST,
  localSessionCredentialRef: REF,
  localSessionExpiresAt: '2026-07-22T00:00:00.000Z',
};

const seat = {
  origin: ORIGIN,
  trustIdentity: TRUST,
  cubeId: CUBE_ID,
  roleId: ROLE_ID,
  operation: OPERATION,
  credential: OLD,
  state: 'active' as const,
  droneId: DRONE_ID,
  sessionId: SESSION_ID,
  expiresAt: active.localSessionExpiresAt,
  worktree: '/work/repo',
  name: 'cube',
  droneLabel: 'builder-1',
};

function deps(overrides: Record<string, unknown> = {}) {
  let current = { ...active };
  const values = {
    now: () => Date.parse('2026-07-21T00:00:00.000Z'),
    randomCredential: () => FRESH,
    getSeat: vi.fn(async () => ({ ...seat })),
    getActive: vi.fn(async () => current),
    getParentCredential: vi.fn(async () => 'p'.repeat(43)),
    sendAttach: vi.fn(async (_record: unknown, bearer: string) => ({
      result: bearer === OLD ? 'reused' : 'created',
      droneId: DRONE_ID,
      sessionId: bearer === OLD ? SESSION_ID : '55555555-5555-4555-8555-555555555555',
      expiresAt: '2026-07-23T00:00:00.000Z',
    })),
    prepareReplacement: vi.fn(async () => ({ ok: true, credential: FRESH, digest: digest(FRESH) })),
    refreshSession: vi.fn(async () => true),
    promoteReplacement: vi.fn(async () => {
      current = {
        ...active,
        sessionToken: FRESH,
        localSessionExpiresAt: '2026-07-23T00:00:00.000Z',
      };
      return 'promoted';
    }),
    scrubReplacement: vi.fn(async () => true),
    ...overrides,
  };
  return values;
}

afterEach(() => {
  __resetSessionContinuityForTest();
  vi.restoreAllMocks();
});

describe('local session continuity', () => {
  it('does not contact the server before the bounded renewal window', async () => {
    const d = deps();
    await expect(__renewLocalSessionForTest(active, 'proactive', d as any)).resolves.toEqual(active);
    expect(d.sendAttach).not.toHaveBeenCalled();
  });

  it('renews the same active bearer and session inside the bounded window', async () => {
    const d = deps({
      now: () => Date.parse(active.localSessionExpiresAt) - SESSION_RENEWAL_LEAD_MS,
    });
    await __renewLocalSessionForTest(active, 'proactive', d as any);
    expect(d.sendAttach).toHaveBeenCalledWith(expect.objectContaining({ droneId: DRONE_ID }), OLD, 'p'.repeat(43));
    expect(d.refreshSession).toHaveBeenCalledWith(expect.objectContaining({
      expectedDroneId: DRONE_ID,
      expectedSessionId: SESSION_ID,
      expectedActiveDigest: digest(OLD),
      expiresAt: '2026-07-23T00:00:00.000Z',
    }));
    expect(d.prepareReplacement).not.toHaveBeenCalled();
  });

  it('uses a fresh restore credential when the stored session is already expired', async () => {
    const d = deps({
      now: () => Date.parse(active.localSessionExpiresAt) + 1,
    });
    await __renewLocalSessionForTest(active, 'proactive', d as any);
    expect(d.sendAttach).toHaveBeenCalledWith(expect.objectContaining({ droneId: DRONE_ID }), FRESH, 'p'.repeat(43));
    expect(d.prepareReplacement).toHaveBeenCalledTimes(1);
    expect(d.refreshSession).not.toHaveBeenCalled();
  });

  it('falls through once to fresh restore when the server clock expires same-bearer renewal first', async () => {
    const sendAttach = vi.fn()
      .mockRejectedValueOnce(new BorgServerError('AUTH_EXPIRED', 'expired'))
      .mockResolvedValueOnce({
        result: 'created', droneId: DRONE_ID,
        sessionId: '55555555-5555-4555-8555-555555555555',
        expiresAt: '2026-07-23T00:00:00.000Z',
      });
    const d = deps({
      now: () => Date.parse(active.localSessionExpiresAt) - SESSION_RENEWAL_LEAD_MS,
      sendAttach,
    });
    await __renewLocalSessionForTest(active, 'proactive', d as any);
    expect(sendAttach.mock.calls.map(([, bearer]) => bearer)).toEqual([OLD, FRESH]);
    expect(d.promoteReplacement).toHaveBeenCalledTimes(1);
  });

  it('resumes a durable pending replacement before attempting proactive same-bearer renewal', async () => {
    const d = deps({
      getSeat: vi.fn(async () => ({ ...seat, replacement: { credential: FRESH } })),
    });
    await __renewLocalSessionForTest(active, 'proactive', d as any);
    expect(d.sendAttach).toHaveBeenCalledWith(expect.objectContaining({ droneId: DRONE_ID }), FRESH, 'p'.repeat(43));
    expect(d.refreshSession).not.toHaveBeenCalled();
  });

  it('single-flights an expired restore and atomically promotes the fresh same-drone session', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const d = deps({
      sendAttach: vi.fn(async () => {
        await blocked;
        return {
          result: 'created', droneId: DRONE_ID,
          sessionId: '55555555-5555-4555-8555-555555555555',
          expiresAt: '2026-07-23T00:00:00.000Z',
        };
      }),
    });
    const first = __renewLocalSessionForTest(active, 'expired', d as any);
    const second = __renewLocalSessionForTest(active, 'expired', d as any);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(left.sessionToken).toBe(FRESH);
    expect(right).toEqual(left);
    expect(d.sendAttach).toHaveBeenCalledTimes(1);
    expect(d.sendAttach).toHaveBeenCalledWith(expect.objectContaining({ droneId: DRONE_ID }), FRESH, 'p'.repeat(43));
    expect(d.promoteReplacement).toHaveBeenCalledWith(expect.objectContaining({
      expectedActiveDigest: digest(OLD),
      expectedReplacementDigest: digest(FRESH),
      expectedDroneId: DRONE_ID,
    }));
  });

  it('preserves the same seat through two successive TTL expiry recoveries', async () => {
    let currentActive = { ...active };
    let currentSeat = { ...seat };
    const credentials = ['a'.repeat(43), 'b'.repeat(43)];
    const sessionIds = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    let cycle = 0;
    const d = deps();
    d.getSeat = vi.fn(async () => currentSeat);
    d.getActive = vi.fn(async () => currentActive);
    d.randomCredential = () => credentials[cycle];
    d.prepareReplacement = vi.fn(async (input: any) => ({
      ok: true,
      credential: input.replacementCredential,
      digest: digest(input.replacementCredential),
    }));
    d.sendAttach = vi.fn(async (_record: unknown, bearer: string) => ({
      result: 'created',
      droneId: DRONE_ID,
      sessionId: sessionIds[cycle],
      expiresAt: new Date(Date.parse('2026-07-22T00:00:00.000Z') + cycle * 24 * 60 * 60_000).toISOString(),
      bearer,
    }));
    d.promoteReplacement = vi.fn(async (input: any) => {
      currentSeat = {
        ...currentSeat,
        credential: credentials[cycle],
        sessionId: input.sessionId,
        expiresAt: input.expiresAt,
      };
      currentActive = {
        ...currentActive,
        sessionToken: credentials[cycle],
        localSessionExpiresAt: input.expiresAt,
      };
      cycle += 1;
      return 'promoted' as const;
    });

    const afterFirstTtl = await __renewLocalSessionForTest(currentActive, 'expired', d as any);
    const afterSecondTtl = await __renewLocalSessionForTest(afterFirstTtl, 'expired', d as any);

    expect(afterSecondTtl).toMatchObject({
      apiUrl: ORIGIN,
      serverTrustIdentity: TRUST,
      cubeId: CUBE_ID,
      droneId: DRONE_ID,
      localSessionCredentialRef: REF,
      sessionToken: credentials[1],
    });
    expect(d.sendAttach).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['new drone', { droneId: '99999999-9999-4999-8999-999999999999' }],
    ['old session', { sessionId: SESSION_ID }],
    ['wrong result', { result: 'created', sessionId: SESSION_ID }],
    ['expired replacement', { expiresAt: '2026-07-20T00:00:00.000Z' }],
  ])('fails closed without promotion when restore returns a %s', async (_case, responsePatch) => {
    const d = deps({
      sendAttach: vi.fn(async () => ({
        result: 'created', droneId: DRONE_ID,
        sessionId: '55555555-5555-4555-8555-555555555555',
        expiresAt: '2026-07-23T00:00:00.000Z',
        ...responsePatch,
      })),
    });
    await expect(__renewLocalSessionForTest(active, 'expired', d as any)).rejects.toThrow(/same saved seat/i);
    expect(d.promoteReplacement).not.toHaveBeenCalled();
  });

  it('retains the durable replacement after transport ambiguity', async () => {
    const d = deps({ sendAttach: vi.fn(async () => { throw new Error('connection reset'); }) });
    await expect(__renewLocalSessionForTest(active, 'expired', d as any)).rejects.toThrow('connection reset');
    expect(d.scrubReplacement).not.toHaveBeenCalled();
  });

  it('scrubs only the pending replacement after a terminal attach rejection', async () => {
    const d = deps({
      sendAttach: vi.fn(async () => { throw new BorgServerError('SESSION_REJECTED', 'taken over'); }),
    });
    await expect(__renewLocalSessionForTest(active, 'expired', d as any))
      .rejects.toMatchObject({ code: 'SESSION_REJECTED' });
    expect(d.scrubReplacement).toHaveBeenCalledWith(expect.objectContaining({
      expectedActiveDigest: digest(OLD),
      expectedReplacementDigest: digest(FRESH),
    }));
  });
});
