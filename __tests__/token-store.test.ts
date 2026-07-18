/**
 * Tests for the OS-keychain credential backend (token-store.ts).
 *
 * The encrypted-file fallback, backend selection, and caller-managed token
 * paths were removed with the cloud severance; only the keychain backend
 * remains (local server credentials use the OS keychain exclusively).
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeFileBackend,
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

describe('makeFileBackend (0600 credential store — Queen rescope)', () => {
  const fixtures: string[] = [];
  afterEach(() => {
    for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  });
  const store = () => {
    const dir = mkdtempSync(join(tmpdir(), 'borg-file-backend-'));
    fixtures.push(dir);
    return join(dir, 'credentials.json');
  };

  it('round-trips set/get/delete against the real 0600 file, several accounts in one file', async () => {
    const path = store();
    const backend = makeFileBackend(path);
    await backend.set('borg-server-credential:aaa', 'ENROLL');
    await backend.set('borg-server-session:bbb', 'BEARER');
    expect(await backend.get('borg-server-credential:aaa')).toBe('ENROLL');
    expect(await backend.get('borg-server-session:bbb')).toBe('BEARER');
    // Both accounts live in ONE 0600 file.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await backend.delete('borg-server-credential:aaa');
    expect(await backend.get('borg-server-credential:aaa')).toBeNull();
    expect(await backend.get('borg-server-session:bbb')).toBe('BEARER');
  });

  it('get on a missing account is null; delete on a missing account is a silent no-op', async () => {
    const backend = makeFileBackend(store());
    expect(await backend.get('nope')).toBeNull();
    await expect(backend.delete('nope')).resolves.toBeUndefined();
  });

  it('persists across a fresh backend instance (survives process restart)', async () => {
    const path = store();
    await makeFileBackend(path).set('borg-server-session:k', 'V');
    expect(await makeFileBackend(path).get('borg-server-session:k')).toBe('V');
  });
});
