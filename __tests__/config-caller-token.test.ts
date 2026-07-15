/**
 * Tests for gh#557 caller-managed token precedence in config.ts.
 *
 * When BORG_TOKEN (or BORG_TOKEN_FILE) supplies an id_token, config.ts must
 * serve it VERBATIM — bypassing both the persistent backend (keychain/file)
 * AND the expiry check, because the caller owns the token's lifecycle. This
 * also means there is no refresh_token in caller-managed mode.
 *
 * These exercise the config.ts precedence directly: with BORG_TOKEN set the
 * code short-circuits before any keychain access, so the test never touches
 * the real OS keychain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getIdToken, getRefreshToken, isAuthenticated } from '../src/config.js';

describe('config.ts caller-managed token precedence (gh#557)', () => {
  const savedToken = process.env.BORG_TOKEN;
  const savedFile = process.env.BORG_TOKEN_FILE;

  beforeEach(() => {
    delete process.env.BORG_TOKEN;
    delete process.env.BORG_TOKEN_FILE;
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.BORG_TOKEN;
    else process.env.BORG_TOKEN = savedToken;
    if (savedFile === undefined) delete process.env.BORG_TOKEN_FILE;
    else process.env.BORG_TOKEN_FILE = savedFile;
  });

  it('getIdToken returns BORG_TOKEN verbatim (no expiry check, no keychain)', async () => {
    process.env.BORG_TOKEN = 'externally-provided-id-token';
    expect(await getIdToken()).toBe('externally-provided-id-token');
  });

  it('trims surrounding whitespace from BORG_TOKEN', async () => {
    process.env.BORG_TOKEN = '  padded-token\n';
    expect(await getIdToken()).toBe('padded-token');
  });

  it('getRefreshToken returns null in caller-managed mode (no refresh concept)', async () => {
    process.env.BORG_TOKEN = 'externally-provided-id-token';
    expect(await getRefreshToken()).toBeNull();
  });

  it('isAuthenticated is true whenever a caller-managed token is present', async () => {
    process.env.BORG_TOKEN = 'externally-provided-id-token';
    expect(await isAuthenticated()).toBe(true);
  });
});
