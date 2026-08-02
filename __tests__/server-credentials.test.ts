import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFileBackend } from '../src/token-store.js';
import {
  __setServerCredentialBackendForTest,
  activatePendingServerEnrollment,
  clearPendingServerCubeCreation,
  clearServerCredential,
  getOrCreatePendingServerCubeCreation,
  getOrCreatePendingServerEnrollment,
  getPendingServerEnrollment,
  getServerCredential,
  getServerCredentialRecord,
  storeServerCredential,
} from '../src/config.js';
import type { TokenBackend } from '../src/token-store.js';

function memoryBackend(): { backend: TokenBackend; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    backend: {
      name: 'file',
      entries: async () => Object.fromEntries(values),
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

  it('requires writer-bound consent before replacing a different trust identity for one origin', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    await storeServerCredential({ origin, trustIdentity, credential });
    await expect(storeServerCredential({
      origin,
      trustIdentity: 'sha256:server-b',
      credential: 'd'.repeat(43),
    })).rejects.toThrow(/replacement was not confirmed/i);
    await storeServerCredential({
      origin,
      trustIdentity: 'sha256:server-b',
      credential: 'd'.repeat(43),
    }, { allowReplacement: true });
    await expect(getServerCredential(origin, trustIdentity)).resolves.toBeNull();
    await expect(getServerCredential(origin, 'sha256:server-b')).resolves.toBe('d'.repeat(43));
  });

  it('requires writer-bound consent before replacing the exact origin and identity', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    await storeServerCredential({ origin, trustIdentity, credential });

    await expect(storeServerCredential({
      origin,
      trustIdentity,
      credential: 'd'.repeat(43),
    })).rejects.toThrow(/replacement was not confirmed/i);
    await expect(getServerCredential(origin, trustIdentity)).resolves.toBe(credential);
  });

  it('preserves the old credential when a confirmed replacement write fails', async () => {
    const { values } = memoryBackend();
    const stable = 'o'.repeat(43);
    const replacement = 'n'.repeat(43);
    let failWrites = false;
    const backend: TokenBackend = {
      name: 'file',
      entries: async () => Object.fromEntries(values),
      get: async (account) => values.get(account) ?? null,
      set: async (account, value) => {
        if (failWrites) throw new Error('injected replacement write failure');
        values.set(account, value);
      },
      delete: async (account) => { values.delete(account); },
    };
    __setServerCredentialBackendForTest(backend);
    await storeServerCredential({ origin, trustIdentity, credential: stable });
    const account = [...values.keys()][0]!;
    failWrites = true;

    await expect(storeServerCredential({
      origin,
      trustIdentity,
      credential: replacement,
    }, { allowReplacement: true })).rejects.toThrow(/injected replacement/i);
    expect(values.get(account)).toContain(stable);
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

  it('CR3b: concurrent credential writers on a REAL file backend all persist (locked RCW; no lost account)', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'borg-cred-concurrency-')));
    try {
      __setServerCredentialBackendForTest(makeFileBackend(join(dir, 'credentials.json')));
      // Distinct origins → distinct accounts in ONE file. Without the store
      // lock, each unlocked load→set→rename races and loses unrelated accounts.
      const authorities = Array.from({ length: 8 }, (_, i) => ({
        origin: `https://server-${i}.example:7091`,
        trustIdentity: `sha256:server-${i}`,
      }));
      await Promise.all(
        authorities.map((authority) => storeServerCredential({ ...authority, credential })),
      );
      for (const authority of authorities) {
        expect(await getServerCredential(authority.origin, authority.trustIdentity)).toBe(credential);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

    await storeServerCredential({ origin, trustIdentity, credential: 'o'.repeat(43) });
    await expect(activatePendingServerEnrollment({
      origin,
      trustIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
    })).rejects.toThrow(/already exists/i);
    await expect(getServerCredential(origin, trustIdentity)).resolves.toBe('o'.repeat(43));
    await expect(getPendingServerEnrollment(origin, trustIdentity)).resolves.toEqual(pending);

    await activatePendingServerEnrollment({
      origin,
      trustIdentity,
      retryKey: pending.retryKey,
      credential: pending.credential,
      clientId: '11111111-1111-4111-8111-111111111111',
      serverCapabilities: ['create_cube'],
      allowReplacement: true,
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
      name: 'file',
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
      name: 'project-concurrent',
      workingRepoName: 'project-concurrent',
      repository: { kind: 'local' as const, value: '22222222-2222-4222-8222-222222222222' },
      template: 'software-dev' as const,
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
      workingRepoName: 'project-one',
      repository: { kind: 'local' as const, value: '22222222-2222-4222-8222-222222222222' },
      template: 'software-dev' as const,
    };
    const first = await getOrCreatePendingServerCubeCreation({
      ...binding,
    });
    await expect(getOrCreatePendingServerCubeCreation({
      ...binding,
    })).resolves.toEqual(first);
    const second = await getOrCreatePendingServerCubeCreation({
      ...binding,
      name: 'project-two',
      workingRepoName: 'project-two',
      repository: { kind: 'local', value: '33333333-3333-4333-8333-333333333333' },
    });
    expect(second.retryKey).not.toBe(first.retryKey);
    await expect(getOrCreatePendingServerCubeCreation({
      ...binding,
      name: 'changed-name',
    })).rejects.toThrow(/does not match/i);
    await clearPendingServerCubeCreation(first);
    const replacement = await getOrCreatePendingServerCubeCreation({
      ...binding,
    });
    expect(replacement.retryKey).not.toBe(first.retryKey);
  });
});
