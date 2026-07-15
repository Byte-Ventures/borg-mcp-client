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
import { isNoBrowserEnv, isKeyringAvailable } from '../src/auth-env.js';

describe('isNoBrowserEnv (gh#557)', () => {
  it('returns false for a desktop macOS session (browser available)', () => {
    expect(isNoBrowserEnv({ env: {}, platform: 'darwin' })).toBe(false);
  });

  it('returns false for a desktop Windows session', () => {
    expect(isNoBrowserEnv({ env: {}, platform: 'win32' })).toBe(false);
  });

  it('returns false for Linux with an X11 DISPLAY', () => {
    expect(isNoBrowserEnv({ env: { DISPLAY: ':0' }, platform: 'linux' })).toBe(false);
  });

  it('returns false for Linux with a Wayland display', () => {
    expect(isNoBrowserEnv({ env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toBe(false);
  });

  it('returns true for headless Linux (no DISPLAY, no WAYLAND_DISPLAY)', () => {
    expect(isNoBrowserEnv({ env: {}, platform: 'linux' })).toBe(true);
  });

  it('returns true inside an SSH session even on macOS (remote terminal)', () => {
    expect(isNoBrowserEnv({ env: { SSH_TTY: '/dev/pts/0' }, platform: 'darwin' })).toBe(true);
    expect(isNoBrowserEnv({ env: { SSH_CONNECTION: '10.0.0.1 222 10.0.0.2 22' }, platform: 'darwin' })).toBe(true);
    expect(isNoBrowserEnv({ env: { SSH_CLIENT: '10.0.0.1 222 22' }, platform: 'linux' })).toBe(true);
  });

  it('returns true inside a container (container= env marker)', () => {
    expect(isNoBrowserEnv({ env: { container: 'docker', DISPLAY: ':0' }, platform: 'linux' })).toBe(true);
  });

  it('honors BORG_NO_BROWSER=1 even on a desktop with a display', () => {
    expect(isNoBrowserEnv({ env: { BORG_NO_BROWSER: '1', DISPLAY: ':0' }, platform: 'linux' })).toBe(true);
    expect(isNoBrowserEnv({ env: { BORG_NO_BROWSER: '1' }, platform: 'darwin' })).toBe(true);
  });

  it('treats BORG_NO_BROWSER=0/false/empty as not set', () => {
    expect(isNoBrowserEnv({ env: { BORG_NO_BROWSER: '0' }, platform: 'darwin' })).toBe(false);
    expect(isNoBrowserEnv({ env: { BORG_NO_BROWSER: 'false' }, platform: 'darwin' })).toBe(false);
    expect(isNoBrowserEnv({ env: { BORG_NO_BROWSER: '' }, platform: 'darwin' })).toBe(false);
  });

  it('BORG_FORCE_BROWSER=1 overrides every no-browser signal (escape hatch)', () => {
    // Even inside SSH + headless-Linux + container, the operator can force the
    // loopback flow (e.g. they have an SSH-forwarded browser / X forwarding).
    expect(
      isNoBrowserEnv({
        env: { BORG_FORCE_BROWSER: '1', SSH_TTY: '/dev/pts/0', container: 'docker' },
        platform: 'linux',
      })
    ).toBe(false);
  });
});

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
