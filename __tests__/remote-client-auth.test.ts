import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  class MockRefreshTokenInvalidError extends Error {}
  class MockRefreshTransientError extends Error {}
  return {
    state: {
      idToken: null as string | null,
      refreshToken: 'refresh-token' as string | null,
      clearCalls: 0,
    },
    refreshIdToken: vi.fn(),
    MockRefreshTokenInvalidError,
    MockRefreshTransientError,
  };
});

vi.mock('../src/config.js', () => ({
  getIdToken: vi.fn(async () => mock.state.idToken),
  getRefreshToken: vi.fn(async () => mock.state.refreshToken),
  clearTokens: vi.fn(async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = null;
    mock.state.clearCalls++;
  }),
}));

vi.mock('../src/auth.js', () => ({
  refreshIdToken: mock.refreshIdToken,
  RefreshTokenInvalidError: mock.MockRefreshTokenInvalidError,
  RefreshTransientError: mock.MockRefreshTransientError,
}));

describe('remote-client auth refresh handling', () => {
  beforeEach(() => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    mock.state.clearCalls = 0;
    mock.refreshIdToken.mockReset();
  });

  it('surfaces transient refresh failures without clearing tokens or forcing re-auth', async () => {
    const transient = new mock.MockRefreshTransientError('Google token endpoint unavailable');
    mock.refreshIdToken.mockRejectedValue(transient);
    const { getValidToken } = await import('../src/remote-client.js');

    await expect(getValidToken()).rejects.toBe(transient);
    expect(mock.state.refreshToken).toBe('refresh-token');
    expect(mock.state.clearCalls).toBe(0);
  });

  it('gh#858: an UNKNOWN refresh failure is NOT mis-surfaced as "expired/re-consent" — tokens preserved', async () => {
    // A non-Invalid, non-Transient throw (e.g. an unclassified keychain-layer
    // error escaping the refresh) must NOT fall through to the "Authentication
    // expired — re-consent / borg setup" path: the refresh_token is valid and
    // re-consent is the wrong advice. Surface it accurately + preserve tokens.
    mock.refreshIdToken.mockRejectedValue(new Error('keychain is locked'));
    const { getValidToken } = await import('../src/remote-client.js');

    let caught: unknown;
    try {
      await getValidToken();
      throw new Error('expected getValidToken to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(mock.MockRefreshTransientError);
    expect((caught as Error).message).not.toMatch(/expired|re-consent|borg setup/i);
    expect(mock.state.clearCalls).toBe(0); // tokens preserved
    expect(mock.state.refreshToken).toBe('refresh-token');
  });

  it('clears tokens and throws the DEAD-login recovery on terminal invalid refresh_token (gh#794)', async () => {
    mock.refreshIdToken.mockRejectedValue(new mock.MockRefreshTokenInvalidError('invalid_grant'));
    const { getValidToken } = await import('../src/remote-client.js');

    // gh#780: re-consent advice is `borg setup`. gh#794: a saved login that
    // existed but is now dead → the DEAD-specific message (not never-signed-in).
    await expect(getValidToken()).rejects.toThrow(
      'Authentication expired — your saved login has expired. Run: borg setup'
    );
    expect(mock.state.refreshToken).toBeNull();
    expect(mock.state.clearCalls).toBe(1);
  });

  // ───────────── gh#794: differentiated message + copy↔matcher (CR be72b00d) ─────────────

  it('gh#794: a NEVER-signed-in user (no refresh_token) gets the not-signed-in message', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = null; // never set up
    const { getValidToken } = await import('../src/remote-client.js');

    await expect(getValidToken()).rejects.toThrow(
      'Authentication required — you are not signed in. Run: borg setup'
    );
    // No refresh attempted (nothing to refresh); keychain untouched.
    expect(mock.refreshIdToken).not.toHaveBeenCalled();
    expect(mock.state.clearCalls).toBe(0);
  });

  it('gh#794 COPY↔MATCHER PIN: BOTH differentiated messages still satisfy the in-session re-auth matcher', async () => {
    // The substring predicate assimilate-cmd.ts:233 + auth-recovery.ts:41 use.
    const matches = (m: string) =>
      m.includes('Authentication required') || m.includes('Authentication expired');
    const { getValidToken } = await import('../src/remote-client.js');

    // dead-login message
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    mock.refreshIdToken.mockRejectedValue(new mock.MockRefreshTokenInvalidError('invalid_grant'));
    const dead = await getValidToken().catch((e) => (e as Error).message);
    expect(matches(dead)).toBe(true);

    // never-signed-in message
    mock.state.idToken = null;
    mock.state.refreshToken = null;
    const never = await getValidToken().catch((e) => (e as Error).message);
    expect(matches(never)).toBe(true);
  });

  it('gh#794 messages carry NO token material (SR#1 secret-free)', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'super-secret-refresh-token-value';
    mock.refreshIdToken.mockRejectedValue(new mock.MockRefreshTokenInvalidError('invalid_grant'));
    const { getValidToken } = await import('../src/remote-client.js');
    const msg = await getValidToken().catch((e) => (e as Error).message);
    expect(msg).not.toContain('super-secret-refresh-token-value');
    expect(msg).not.toContain('invalid_grant');
  });

  // ───────────── gh#794: probeSession tri-state (SR#3) + clearTokens-dead-only ─────────────

  it('probeSession → valid when a fresh id_token is present (no refresh)', async () => {
    mock.state.idToken = 'fresh-id-token';
    const { probeSession } = await import('../src/remote-client.js');
    expect(await probeSession()).toBe('valid');
    expect(mock.refreshIdToken).not.toHaveBeenCalled();
  });

  it('probeSession → valid after a silent refresh (expired id_token, live refresh_token)', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    mock.refreshIdToken.mockImplementation(async () => {
      mock.state.idToken = 'refreshed-id-token'; // refresh persists a fresh token
    });
    const { probeSession } = await import('../src/remote-client.js');
    expect(await probeSession()).toBe('valid');
    expect(mock.state.clearCalls).toBe(0);
  });

  it('probeSession → dead (clearTokens) on invalid_grant', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    mock.refreshIdToken.mockRejectedValue(new mock.MockRefreshTokenInvalidError('invalid_grant'));
    const { probeSession } = await import('../src/remote-client.js');
    expect(await probeSession()).toBe('dead');
    expect(mock.state.clearCalls).toBe(1); // cleared
  });

  it('probeSession → dead when there is no refresh_token at all (never set up)', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = null;
    const { probeSession } = await import('../src/remote-client.js');
    expect(await probeSession()).toBe('dead');
    expect(mock.refreshIdToken).not.toHaveBeenCalled();
  });

  it('probeSession → transient on a network/5xx blip, WITHOUT clearing the keychain (gh#34 pin)', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    mock.refreshIdToken.mockRejectedValue(new mock.MockRefreshTransientError('Google 503'));
    const { probeSession } = await import('../src/remote-client.js');
    expect(await probeSession()).toBe('transient');
    expect(mock.state.clearCalls).toBe(0); // NEVER clear on transient
    expect(mock.state.refreshToken).toBe('refresh-token'); // keychain intact
  });

  // ───────────── gh#794: single-flight refresh (CR note-3) ─────────────

  it('single-flights the refresh: N concurrent near-expiry calls fire ONE refreshIdToken', async () => {
    mock.state.idToken = null;
    mock.state.refreshToken = 'refresh-token';
    // Build the gate BEFORE the calls so the resolver is set synchronously
    // (the executor runs at construction); the mock returns this same pending
    // promise — single-flight means only the first call invokes it.
    let settleRefresh!: () => void;
    const refreshGate = new Promise<void>((res) => {
      settleRefresh = () => {
        mock.state.idToken = 'refreshed-id-token';
        res();
      };
    });
    mock.refreshIdToken.mockReturnValue(refreshGate);
    const { getValidToken } = await import('../src/remote-client.js');

    const calls = [getValidToken(), getValidToken(), getValidToken()];
    // Let the three callers reach the shared in-flight refresh, then settle it.
    await new Promise((r) => setTimeout(r, 0));
    settleRefresh();
    const tokens = await Promise.all(calls);

    expect(tokens).toEqual(['refreshed-id-token', 'refreshed-id-token', 'refreshed-id-token']);
    expect(mock.refreshIdToken).toHaveBeenCalledTimes(1); // ONE refresh shared
  });
});
