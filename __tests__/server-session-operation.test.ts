import { afterEach, describe, expect, it, vi } from 'vitest';

// The client bearer digest is the sole server correlator, so distinct seats must
// mint distinct bearers. A deliberate sibling attach therefore has to namespace
// its pending bearer apart from the durable in-place seat of the same
// (origin, trust, cube, role) via the operation dimension.
describe('server pending-session operation namespacing', () => {
  const origin = 'https://127.0.0.1:7091';
  const trustIdentity = 'spki-sha256:test-server';
  const cubeId = '11111111-1111-4111-8111-111111111111';
  const roleId = '22222222-2222-4222-8222-222222222222';
  const expiresAt = '2026-07-15T20:30:00.000Z';
  const seatOperation = { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' };
  const siblingOperation = { projectRoot: '/work/repo', kind: 'sibling' as const, operationKey: 'named-sibling:review-1' };

  afterEach(() => {
    vi.resetModules();
  });

  async function setup() {
    vi.resetModules();
    const store = new Map<string, string>();
    const config = await import('../src/config.js');
    config.__setServerCredentialBackendForTest({
      name: 'keychain',
      get: async (account: string) => store.get(account) ?? null,
      set: async (account: string, value: string) => { store.set(account, value); },
      delete: async (account: string) => { store.delete(account); },
    });
    return { config, store };
  }

  it('mints distinct bearers and references for a seat vs a sibling of the same role', async () => {
    const { config } = await setup();

    const seat = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
    });
    const sibling = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: siblingOperation,
    });
    expect(seat.credential).not.toBe(sibling.credential);

    const seatRef = await config.activatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
      droneId: '33333333-3333-4333-8333-333333333333',
      sessionId: '44444444-4444-4444-8444-444444444444',
      expiresAt,
    });
    const siblingRef = await config.activatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: siblingOperation,
      droneId: '55555555-5555-4555-8555-555555555555',
      sessionId: '66666666-6666-4666-8666-666666666666',
      expiresAt,
    });
    // Distinct accounts: the sibling never collides onto the seat's bearer.
    expect(seatRef).not.toBe(siblingRef);

    // Each opaque reference resolves ONLY its own bearer.
    await expect(config.getActiveServerSessionCredential(seatRef, { origin, trustIdentity, cubeId }))
      .resolves.toBe(seat.credential);
    await expect(config.getActiveServerSessionCredential(siblingRef, { origin, trustIdentity, cubeId }))
      .resolves.toBe(sibling.credential);
  });

  it('re-returns the exact same pending bearer for the same seat operation (retry-safe)', async () => {
    const { config } = await setup();
    const first = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
    });
    const again = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
    });
    // A lost attach response re-sends the identical bearer the server already
    // digest-bound — no new seat, no rotation.
    expect(again.credential).toBe(first.credential);
    expect(again.operation).toEqual(seatOperation);
  });

  it('clears one seat operation without disturbing a sibling of the same role', async () => {
    const { config } = await setup();
    const seat = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
    });
    const sibling = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: siblingOperation,
    });

    await config.clearPendingServerSession({ origin, trustIdentity, cubeId, roleId, operation: seatOperation });

    // The seat is force-freshened (new bearer); the sibling is untouched.
    const reseat = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: seatOperation,
    });
    const resibling = await config.getOrCreatePendingServerSession({
      origin, trustIdentity, cubeId, roleId, operation: siblingOperation,
    });
    expect(reseat.credential).not.toBe(seat.credential);
    expect(resibling.credential).toBe(sibling.credential);
  });
});
