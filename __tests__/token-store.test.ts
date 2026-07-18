/**
 * Tests for the OS-keychain credential backend (token-store.ts).
 *
 * The encrypted-file fallback, backend selection, and caller-managed token
 * paths were removed with the cloud severance; only the keychain backend
 * remains (local server credentials use the OS keychain exclusively).
 */
import { describe, it, expect } from 'vitest';
import {
  makeKeychainBackend,
  type KeyringEntry,
} from '../src/token-store.js';

function fakeKeyring() {
  const store = new Map<string, string>();
  const factory = (account: string): KeyringEntry => ({
    setPassword: async (v: string) => {
      store.set(account, v);
    },
    getPassword: async () => (store.has(account) ? store.get(account)! : null),
    deletePassword: async () => {
      if (!store.has(account)) throw new Error('No matching entry found in secure storage');
      store.delete(account);
    },
  });
  return { store, factory };
}

describe('makeKeychainBackend', () => {
  it('round-trips set/get/delete through the keyring entry', async () => {
    const { factory } = fakeKeyring();
    const backend = makeKeychainBackend(factory);
    await backend.set('google-id-token', 'ID');
    expect(await backend.get('google-id-token')).toBe('ID');
    await backend.delete('google-id-token');
    expect(await backend.get('google-id-token')).toBeNull();
  });

  it('delete on a missing account is silent (idempotent)', async () => {
    const { factory } = fakeKeyring();
    const backend = makeKeychainBackend(factory);
    await expect(backend.delete('never-stored')).resolves.toBeUndefined();
  });
});
