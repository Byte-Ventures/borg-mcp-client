/**
 * gh#860 SR HIGH (3bed8571) — atomic runtime migration.
 *
 * Exercises the REAL config.ts migrateToFileBackendWithTokens (the auth-refresh
 * suite mocks config wholesale; this proves the actual commit ordering): the
 * process backend (backendPromise) must be re-pointed to file ONLY after every
 * token write succeeds. A partial write must leave the process keychain-backed
 * and persist nothing, so no path silently downgrades to the obfuscation-grade
 * file backend without the caller's at-rest warning.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  migrateToFileBackendWithTokens,
  isUsingKeychainBackend,
  __setBackendForTest,
} from '../src/config.js';
import type { TokenBackend } from '../src/token-store.js';

const ID_TOKEN_ACCOUNT = 'google-id-token';
const REFRESH_TOKEN_ACCOUNT = 'google-refresh-token';
const TOKEN_EXPIRY_ACCOUNT = 'token-expiry';

function fakeKeychain(): TokenBackend {
  return {
    name: 'keychain',
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  };
}

afterEach(() => __setBackendForTest(null));

describe('gh#860 — atomic migrateToFileBackendWithTokens', () => {
  it('commits the file backend (process becomes file-backed) ONLY after all writes succeed', async () => {
    __setBackendForTest(fakeKeychain());
    const written: Array<[string, string]> = [];
    const file: TokenBackend = {
      name: 'encrypted-file',
      get: async () => null,
      set: async (account, value) => {
        written.push([account, value]);
      },
      delete: async () => {},
    };

    const ok = await migrateToFileBackendWithTokens(
      { idToken: 'id-1', expiresAt: 1234, refreshToken: 'refresh-1' },
      { fileBackend: file }
    );

    expect(ok).toBe(true);
    expect(await isUsingKeychainBackend()).toBe(false); // committed to file
    expect(written).toEqual([
      [REFRESH_TOKEN_ACCOUNT, 'refresh-1'],
      [ID_TOKEN_ACCOUNT, 'id-1'],
      [TOKEN_EXPIRY_ACCOUNT, '1234'],
    ]);
  });

  it('a PARTIAL write failure: NO commit (stays keychain) + rolls back ONLY what it wrote + PRESERVES a pre-existing token account it did NOT write (SA LOW 9f228d42)', async () => {
    __setBackendForTest(fakeKeychain());
    // A PRE-EXISTING file refresh_token (e.g. from a prior file-fallback session) that
    // THIS no-rotation migration does NOT write — it must survive a failed migration.
    const store = new Map<string, string>([[REFRESH_TOKEN_ACCOUNT, 'pre-existing-refresh']]);
    const file: TokenBackend = {
      name: 'encrypted-file',
      get: async (account) => store.get(account) ?? null,
      set: async (account, value) => {
        if (account === TOKEN_EXPIRY_ACCOUNT) throw new Error('disk full'); // id OK, expiry FAILS
        store.set(account, value);
      },
      delete: async (account) => {
        store.delete(account);
      },
    };

    // No rotation: writes ID then EXPIRY (no refresh write). EXPIRY throws → written=[ID].
    const ok = await migrateToFileBackendWithTokens(
      { idToken: 'id-1', expiresAt: 1234 },
      { fileBackend: file }
    );

    expect(ok).toBe(false);
    expect(await isUsingKeychainBackend()).toBe(true); // never left file-backed
    expect(store.has(ID_TOKEN_ACCOUNT)).toBe(false); // our partial write rolled back
    // The pre-existing refresh_token (NOT written by this migration) is PRESERVED —
    // a blind delete-all rollback would have clobbered it (the SA LOW bug).
    expect(store.get(REFRESH_TOKEN_ACCOUNT)).toBe('pre-existing-refresh');
  });

  it('a PARTIAL write failure RESTORES a pre-existing account this migration OVERWROTE (CR 3e3fb4df)', async () => {
    __setBackendForTest(fakeKeychain());
    // The file already has a refresh_token from a prior session. A rotation migration
    // OVERWRITES it, then a later write fails — the prior value must be RESTORED, not
    // deleted (a scoped-delete rollback would have destroyed it).
    const store = new Map<string, string>([[REFRESH_TOKEN_ACCOUNT, 'old-refresh']]);
    const file: TokenBackend = {
      name: 'encrypted-file',
      get: async (account) => store.get(account) ?? null,
      set: async (account, value) => {
        if (account === ID_TOKEN_ACCOUNT) throw new Error('disk full'); // refresh OK, id FAILS
        store.set(account, value);
      },
      delete: async (account) => {
        store.delete(account);
      },
    };

    const ok = await migrateToFileBackendWithTokens(
      { idToken: 'id-1', expiresAt: 1234, refreshToken: 'new-refresh' }, // rotation overwrites refresh
      { fileBackend: file }
    );

    expect(ok).toBe(false);
    expect(await isUsingKeychainBackend()).toBe(true); // not committed
    // The overwritten refresh_token is RESTORED to its prior value (not deleted).
    expect(store.get(REFRESH_TOKEN_ACCOUNT)).toBe('old-refresh');
    expect(store.has(ID_TOKEN_ACCOUNT)).toBe(false); // its write threw → never stored
  });

  it('no-rotation (no refresh_token): writes only id + expiry, commits on success', async () => {
    __setBackendForTest(fakeKeychain());
    const written: string[] = [];
    const file: TokenBackend = {
      name: 'encrypted-file',
      get: async () => null,
      set: async (account) => {
        written.push(account);
      },
      delete: async () => {},
    };

    const ok = await migrateToFileBackendWithTokens(
      { idToken: 'id-1', expiresAt: 1234 }, // no refreshToken
      { fileBackend: file }
    );

    expect(ok).toBe(true);
    expect(await isUsingKeychainBackend()).toBe(false);
    expect(written).toEqual([ID_TOKEN_ACCOUNT, TOKEN_EXPIRY_ACCOUNT]); // no refresh write
  });
});
