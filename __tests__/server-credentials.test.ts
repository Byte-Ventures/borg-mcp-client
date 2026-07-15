import { afterEach, describe, expect, it } from 'vitest';
import {
  __setServerCredentialBackendForTest,
  clearServerSessionCredential,
  clearServerCredential,
  getServerSessionCredential,
  getServerCredential,
  storeServerSessionCredential,
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
});

describe('self-hosted server session credential storage', () => {
  const binding = {
    origin: 'https://localhost:8787',
    trustIdentity: 'spki-sha256:server-a',
    cubeId: '11111111-1111-4111-8111-111111111111',
    droneId: '22222222-2222-4222-8222-222222222222',
    generation: 7,
  };
  const credential = 'd'.repeat(43);

  it('stores the bearer under an opaque generation-specific reference', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);

    const credentialRef = await storeServerSessionCredential({
      ...binding,
      credential,
      expiresAt: '2026-07-14T15:00:00.000Z',
    });

    expect(credentialRef).toMatch(/^borg-server-session:[a-f0-9]{64}$/);
    expect(credentialRef).not.toContain(binding.cubeId);
    expect(credentialRef).not.toContain(binding.droneId);
    await expect(getServerSessionCredential(credentialRef, binding)).resolves.toBe(credential);
    expect([...values.values()].join('')).toContain(credential);
  });

  it('fails closed when identity or generation does not match the reference', async () => {
    const { backend } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const credentialRef = await storeServerSessionCredential({ ...binding, credential });

    await expect(getServerSessionCredential(credentialRef, {
      ...binding,
      generation: binding.generation + 1,
    })).resolves.toBeNull();
    await expect(getServerSessionCredential(credentialRef, {
      ...binding,
      droneId: '33333333-3333-4333-8333-333333333333',
    })).resolves.toBeNull();
  });

  it('removes only the selected generation', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);
    const oldRef = await storeServerSessionCredential({ ...binding, credential });
    const newRef = await storeServerSessionCredential({
      ...binding,
      generation: binding.generation + 1,
      credential: 'e'.repeat(43),
    });

    await clearServerSessionCredential(oldRef);
    expect(values.has(oldRef)).toBe(false);
    expect(values.has(newRef)).toBe(true);
  });

  it('rejects malformed bindings before touching the keychain', async () => {
    const { backend, values } = memoryBackend();
    __setServerCredentialBackendForTest(backend);

    await expect(storeServerSessionCredential({
      ...binding,
      generation: 0,
      credential,
    })).rejects.toThrow(/generation/i);
    await expect(storeServerSessionCredential({
      ...binding,
      cubeId: '../cube',
      credential,
    })).rejects.toThrow(/identity/i);
    expect(values.size).toBe(0);
  });
});
