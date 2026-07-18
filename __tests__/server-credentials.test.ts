import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  __setServerCredentialBackendForTest,
  activatePendingServerEnrollment,
  activatePendingServerSession,
  clearPendingServerCubeCreation,
  clearServerSessionCredential,
  clearServerCredential,
  compareAndClearPendingServerSession,
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
  getOrCreatePendingServerSession,
  getPendingServerEnrollment,
  getServerCredential,
  getServerCredentialRecord,
  serverSessionCredentialRef,
  storeServerCredential,
} from '../src/config.js';
import type { TokenBackend } from '../src/token-store.js';

function memoryBackend(): { backend: TokenBackend; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backend: {
      name: 'keychain',
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => { values.set(account, value); },
      delete: async (account) => { values.delete(account); },
    },
  };
}

afterEach(() => __setServerCredentialBackendForTest(null));

describe('self-hosted server credential storage', () => {
  const origin = 'https://localhost:8787';
  const trustIdentity = 'sha256:server-a';
  const credential = 'c'.repeat(43);

  it('round-trips only for the same canonical origin and verified identity', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);

    await storeServerCredential({ origin, trustIdentity, credential });

    await expect(getServerCredential(origin, trustIdentity)).resolves.toBe(credential);
    await expect(getServerCredential(origin, 'sha256:server-b')).resolves.toBeNull();
    await expect(getServerCredential('https://localhost:8788', trustIdentity)).resolves.toBeNull();
  });

  it('does not expose the authority or trust identity in keychain account metadata', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);

    await storeServerCredential({ origin, trustIdentity, credential });

    const [account] = [...values.keys()];
    expect(account).toMatch(/^borg-server-credential:[a-f0-9]{64}$/);
    expect(account).not.toContain('localhost');
    expect(account).not.toContain('server-a');
  });

  it('fails closed on a corrupt stored record and supports explicit removal', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    await storeServerCredential({ origin, trustIdentity, credential });
    const [account] = [...values.keys()];
    values.set(account, '{not-json');

    await expect(getServerCredential(origin, trustIdentity)).resolves.toBeNull();
    await clearServerCredential(origin, trustIdentity);
    expect(values).toHaveLength(0);
  });

  it('rejects non-canonical origins, control-bearing identities, and weak credentials', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);

    await expect(storeServerCredential({
      origin: `${origin}/`, trustIdentity, credential,
    })).rejects.toThrow(/canonical/i);
    await expect(storeServerCredential({
      origin, trustIdentity: 'bad\nidentity', credential,
    })).rejects.toThrow(/trust identity/i);
    await expect(storeServerCredential({
      origin, trustIdentity, credential: 'weak',
    })).rejects.toThrow(/credential/i);
  });

  it('persists enrollment PENDING before activation and reuses only the exact tuple', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const invitation = 'i'.repeat(43);
    const pending = await getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation,
      clientName: 'operator-laptop',
    });

    expect(pending.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.retryKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect([...values.keys()]).toEqual([
      expect.stringMatching(/^borg-server-enrollment-pending:[a-f0-9]{64}$/),
    ]);
    await expect(getServerCredential(origin, trustIdentity)).resolves.toBeNull();
    await expect(getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation,
      clientName: 'operator-laptop',
    })).resolves.toEqual(pending);
    await expect(getOrCreatePendingServerEnrollment({
      origin,
      trustIdentity,
      invitation: 'j'.repeat(43),
      clientName: 'operator-laptop',
    })).rejects.toThrow(/does not match/i);

    await activatePendingServerEnrollment({
      origin,
      trustIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
    });
    await expect(getServerCredentialRecord(origin, trustIdentity)).resolves.toMatchObject({
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
    });
    expect([...values.keys()].some((key) => key.includes('enrollment-pending'))).toBe(false);
  });

  it('serializes N concurrent enrollment and cube-create tuple initializations', async () => {
    const values = new Map<string, string>();
    const backend: TokenBackend = {
      name: 'keychain',
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 2));
        values.set(account, value);
      },
      delete: async (account) => { values.delete(account); },
    };
    __setServerCredentialBackendForTest(backend);
    const enrollmentInput = {
      origin,
      trustIdentity,
      invitation: 'i'.repeat(43),
      clientName: 'operator-laptop',
    };
    const enrollments = await Promise.all(Array.from({ length: 16 }, () =>
      getOrCreatePendingServerEnrollment(enrollmentInput)));
    expect([...new Set(enrollments.map((record) => record.retryKey))]).toHaveLength(1);
    expect([...new Set(enrollments.map((record) => record.credential))]).toHaveLength(1);
    await expect(getPendingServerEnrollment(origin, trustIdentity)).resolves
      .toEqual(enrollments[0]);

    const cubeInput = {
      origin,
      trustIdentity,
      clientId: '11111111-1111-4111-8111-111111111111',
      projectRoot: '/work/project-concurrent',
      name: 'project-concurrent',
      template: 'default' as const,
    };
    const creations = await Promise.all(Array.from({ length: 16 }, () =>
      getOrCreatePendingServerCubeCreation(cubeInput)));
    expect([...new Set(creations.map((record) => record.retryKey))]).toHaveLength(1);
    expect(creations.every((record) => record.repositoryBinding === creations[0].repositoryBinding))
      .toBe(true);
  });

  it('keeps repository cube retry keys stable and isolates multiple repositories', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const binding = {
      origin,
      trustIdentity,
      clientId: '11111111-1111-4111-8111-111111111111',
      name: 'project-one',
      template: 'default' as const,
    };
    const first = await getOrCreatePendingServerCubeCreation({
      ...binding,
      projectRoot: '/work/project-one',
    });
    await expect(getOrCreatePendingServerCubeCreation({
      ...binding,
      projectRoot: '/work/project-one',
    })).resolves.toEqual(first);
    const second = await getOrCreatePendingServerCubeCreation({
      ...binding,
      projectRoot: '/work/project-two',
      name: 'project-two',
    });
    expect(second.retryKey).not.toBe(first.retryKey);
    await expect(getOrCreatePendingServerCubeCreation({
      ...binding,
      projectRoot: '/work/project-one',
      name: 'changed-name',
    })).rejects.toThrow(/does not match/i);
    await clearPendingServerCubeCreation(first);
    const replacement = await getOrCreatePendingServerCubeCreation({
      ...binding,
      projectRoot: '/work/project-one',
    });
    expect(replacement.retryKey).not.toBe(first.retryKey);
  });
});

describe('compareAndClearPendingServerSession (composite abort-scrub, part C)', () => {
  const seat = {
    origin: 'https://localhost:8787',
    trustIdentity: 'sha256:server-a',
    cubeId: '11111111-1111-4111-8111-111111111111',
    roleId: '44444444-4444-4444-8444-444444444444',
    operation: { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' },
  };
  const binding = { origin: seat.origin, trustIdentity: seat.trustIdentity, cubeId: seat.cubeId };

  it('deletes ONLY the own pending record when the bearer digest matches', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const rec = await getOrCreatePendingServerSession(seat);
    const ref = serverSessionCredentialRef(seat);
    const digest = createHash('sha256').update(rec.credential).digest('hex');

    // Wrong digest (a competing fresh enroll wrote a different bearer under the
    // same deterministic ref) → NO delete; the record is preserved.
    expect(await compareAndClearPendingServerSession(ref, binding, 'deadbeef')).toBe(false);
    expect(values.has(ref)).toBe(true);

    // Correct digest + still pending → deleted.
    expect(await compareAndClearPendingServerSession(ref, binding, digest)).toBe(true);
    expect(values.has(ref)).toBe(false);
  });

  it('NEVER deletes an ACTIVE record (a concurrent winner activated it; a binding references it)', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const rec = await getOrCreatePendingServerSession(seat);
    const ref = serverSessionCredentialRef(seat);
    const digest = createHash('sha256').update(rec.credential).digest('hex');
    // The record is activated (pending→active) by the winner.
    await activatePendingServerSession({
      ...seat,
      droneId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      expiresAt: '2026-07-20T00:00:00.000Z',
    });
    // Scrub with the matching digest is a NO-OP because state=='active'.
    expect(await compareAndClearPendingServerSession(ref, binding, digest)).toBe(false);
    expect(values.has(ref)).toBe(true);
  });

  it('is a no-op on a missing record or a malformed ref', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const ref = serverSessionCredentialRef(seat);
    expect(await compareAndClearPendingServerSession(ref, binding, 'x')).toBe(false);
    expect(await compareAndClearPendingServerSession('not-a-ref', binding, 'x')).toBe(false);
  });
});

describe('self-hosted server session credential deletion', () => {
  const credentialRef = `borg-server-session:${'a'.repeat(64)}`;

  it('deletes the exact reference (under the per-account keychain lock)', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    values.set(credentialRef, JSON.stringify({ state: 'active' }));

    await clearServerSessionCredential(credentialRef);
    expect(values.has(credentialRef)).toBe(false);
  });

  it('rejects a malformed reference before touching the keychain', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    await expect(clearServerSessionCredential('not-a-session-ref')).rejects.toThrow(/reference/i);
  });
});
