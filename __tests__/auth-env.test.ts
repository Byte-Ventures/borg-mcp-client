/**
 * Tests for gh#557 environment/capability detection helpers.
 *
 * These pure helpers decide whether the loopback-browser OAuth flow is
 * viable in the current environment, or whether we must fall back to the
 * RFC 8628 device-grant flow (no browser) and/or a keychain-less token
 * store. Detection is split out so it can be unit-tested without a real
 * display, SSH session, or OS keychain.
 */
import { describe, it, expect } from 'vitest';
import { isKeyringAvailable } from '../src/auth-env.js';

describe('isKeyringAvailable (gh#557)', () => {
  it('returns true when the injected round-trip probe resolves', async () => {
    const probe = async () => {
      /* round-trip succeeded */
    };
    expect(await isKeyringAvailable(probe)).toBe(true);
  });

  it('returns false when the injected round-trip probe throws (no Secret Service)', async () => {
    const probe = async () => {
      throw new Error('Platform secure storage failure: no Secret Service available');
    };
    expect(await isKeyringAvailable(probe)).toBe(false);
  });
});
