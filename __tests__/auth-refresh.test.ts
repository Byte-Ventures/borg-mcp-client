/**
 * Tests for `refreshIdToken` typed-error classification (gh#34 Bug 1) +
 * `refresh_token` rotation handling (gh#34 Bug 2).
 *
 * The pre-gh#34 shape threw a generic `Error` on every refresh failure,
 * and `remote-client.ts` called `clearTokens()` unconditionally in both
 * `forceRefreshToken` and `getValidToken` catch blocks. A single
 * transient blip (network, Google 5xx, DNS) would destroy the durable
 * session — gh#34 fixes the over-eager destruction by adding the typed-
 * error discrimination axis.
 *
 * These tests cover drone-3's 5 verification axes (14:07:48) + drone-8's
 * SR axis (a) (classification anchored on parsed body) + drone-8's SR
 * axis (c) (rotation atomicity with refresh_token-first ordering).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  refreshIdToken,
  RefreshTokenInvalidError,
  RefreshTransientError,
} from '../src/auth.js';

// Mock the config module so tests don't touch the real OS keychain.
vi.mock('../src/config.js', () => {
  const state = {
    idToken: null as string | null,
    refreshToken: null as string | null,
    expiresAt: 0,
    storeIdTokenCalls: [] as Array<{ token: string; expiresAt: number }>,
    storeRefreshTokenCalls: [] as Array<{ token: string }>,
    failNextStoreIdToken: false,
    failNextStoreRefreshToken: false,
    // gh#860 runtime-fallback knobs. usingKeychain defaults true (the keychain is
    // the default backend). fileFallbackEnabled defaults FALSE so an unmodified
    // keychain-write-failure test still surfaces #858's transient (migration
    // unavailable) — WI-2 tests opt in by setting it true. failFilePersist
    // simulates a partial file-persist failure AFTER opt-in: the atomic contract
    // must NOT commit (usingKeychain stays true) — gh#860 SR HIGH 3bed8571.
    usingKeychain: true,
    fileFallbackEnabled: false,
    failFilePersist: false,
    fileIdToken: null as string | null,
    fileRefreshToken: null as string | null,
    migrateCalls: 0,
  };
  return {
    __state: state,
    isUsingKeychainBackend: vi.fn(async () => state.usingKeychain),
    // Atomic contract (gh#860 SR HIGH): commit (usingKeychain=false + persist) ONLY
    // when the whole migration succeeds; on unavailability/partial-failure return
    // false WITHOUT committing or persisting.
    migrateToFileBackendWithTokens: vi.fn(
      async (tokens: { idToken: string; expiresAt: number; refreshToken?: string }) => {
        state.migrateCalls += 1;
        if (!state.fileFallbackEnabled) return false; // file backend unavailable
        if (state.failFilePersist) return false; // partial write failed → NOT committed
        state.usingKeychain = false; // committed → process now file-backed
        state.fileIdToken = tokens.idToken;
        state.idToken = tokens.idToken;
        if (tokens.refreshToken !== undefined) {
          state.fileRefreshToken = tokens.refreshToken;
          state.refreshToken = tokens.refreshToken;
        }
        return true;
      }
    ),
    storeIdToken: vi.fn(async (token: string, expiresAt: number) => {
      if (state.failNextStoreIdToken) {
        state.failNextStoreIdToken = false;
        throw new Error('mock: keychain write failure (id_token)');
      }
      state.idToken = token;
      state.expiresAt = expiresAt;
      state.storeIdTokenCalls.push({ token, expiresAt });
    }),
    storeRefreshToken: vi.fn(async (token: string) => {
      if (state.failNextStoreRefreshToken) {
        state.failNextStoreRefreshToken = false;
        throw new Error('mock: keychain write failure (refresh_token)');
      }
      state.refreshToken = token;
      state.storeRefreshTokenCalls.push({ token });
    }),
    getRefreshToken: vi.fn(async () => state.refreshToken),
    getIdToken: vi.fn(async () => state.idToken),
    clearTokens: vi.fn(async () => {
      state.idToken = null;
      state.refreshToken = null;
      state.expiresAt = 0;
    }),
  };
});

// Helper to get the mocked module's internal state.
async function getMockState() {
  const mod = (await import('../src/config.js')) as any;
  return mod.__state as {
    idToken: string | null;
    refreshToken: string | null;
    expiresAt: number;
    storeIdTokenCalls: Array<{ token: string; expiresAt: number }>;
    storeRefreshTokenCalls: Array<{ token: string }>;
    failNextStoreIdToken: boolean;
    failNextStoreRefreshToken: boolean;
    usingKeychain: boolean;
    fileFallbackEnabled: boolean;
    failFilePersist: boolean;
    fileIdToken: string | null;
    fileRefreshToken: string | null;
    migrateCalls: number;
  };
}

describe('refreshIdToken — typed-error classification (gh#34 Bug 1)', () => {
  const REFRESH_TOKEN_VALUE = 'refresh-token-fixture';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const state = await getMockState();
    state.idToken = null;
    state.refreshToken = REFRESH_TOKEN_VALUE;
    state.expiresAt = 0;
    state.storeIdTokenCalls = [];
    state.storeRefreshTokenCalls = [];
    state.failNextStoreIdToken = false;
    state.failNextStoreRefreshToken = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws RefreshTokenInvalidError on HTTP 400 + body {"error":"invalid_grant"} (canonical revocation signal)', async () => {
    // gh#691: refreshIdToken now tries web THEN device client on failure.
    // Return a FRESH Response on every call (a Response body is single-read)
    // so both attempts classify identically → both invalid_grant.
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTokenInvalidError
    );

    // Refresh_token in keychain should NOT have been touched —
    // `refreshIdToken` doesn't clear anything; callers gate clearTokens.
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('preserves error_description on RefreshTokenInvalidError without echoing the request body (drone-8 SR axis b)', async () => {
    // gh#691: refreshIdToken now tries web THEN device client on failure.
    // Return a FRESH Response on every call (a Response body is single-read)
    // so both attempts classify identically → both invalid_grant.
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
    );

    try {
      await refreshIdToken(REFRESH_TOKEN_VALUE);
      throw new Error('expected RefreshTokenInvalidError');
    } catch (err) {
      expect(err).toBeInstanceOf(RefreshTokenInvalidError);
      const invalid = err as RefreshTokenInvalidError;
      expect(invalid.errorCode).toBe('invalid_grant');
      expect(invalid.errorDescription).toBe('Token has been expired or revoked.');
      // Token-material non-leakage: the refresh_token value must NOT
      // appear in the error message (the request body contains it,
      // but the error message must not echo it).
      expect(invalid.message).not.toContain(REFRESH_TOKEN_VALUE);
    }
  });

  it('throws RefreshTransientError on HTTP 500 (Google 5xx — preserve tokens)', async () => {
    // gh#691: both web + device attempts see HTTP 500 → both transient.
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('throws RefreshTransientError on HTTP 400 + body {"error":"invalid_request"} (NOT invalid_grant — anchors on body, not status)', async () => {
    // Drone-8 SR axis (a): status-code-alone is insufficient.
    // Google returns 400 for `invalid_request` / `unauthorized_client`
    // / `invalid_client` etc. which are NOT refresh_token revocation;
    // misclassifying any of these as Invalid would destroy keychain
    // state on every malformed-request bug.
    // gh#691: both web + device attempts see 400 invalid_request → transient.
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
  });

  it('throws RefreshTransientError on network failure (fetch rejects)', async () => {
    // gh#691: both web + device attempts hit the network failure → transient.
    fetchSpy.mockRejectedValue(new TypeError('fetch failed: getaddrinfo ENOTFOUND'));

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('throws RefreshTransientError on non-JSON error response body (HTML proxy error, etc.)', async () => {
    // When we can't tell what Google said (or it wasn't Google at
    // all — a proxy/firewall returned HTML), the safer default is
    // Transient.
    // gh#691: both web + device attempts get the non-JSON body → transient.
    fetchSpy.mockImplementation(
      async () =>
        new Response('<html><body>Bad Gateway</body></html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
  });

  it('throws RefreshTransientError when success response body is malformed/missing id_token', async () => {
    // gh#691: both web + device attempts get the malformed 200 (no
    // id_token) → both transient.
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
  });
});

describe('refreshIdToken — refresh_token rotation handling (gh#34 Bug 2)', () => {
  const REFRESH_TOKEN_OLD = 'refresh-token-old';
  const REFRESH_TOKEN_NEW = 'refresh-token-new-rotated';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const state = await getMockState();
    state.idToken = null;
    state.refreshToken = REFRESH_TOKEN_OLD;
    state.expiresAt = 0;
    state.storeIdTokenCalls = [];
    state.storeRefreshTokenCalls = [];
    state.failNextStoreIdToken = false;
    state.failNextStoreRefreshToken = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('stores rotated refresh_token + id_token when Google returns a new refresh_token', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: 'new-id-token',
          refresh_token: REFRESH_TOKEN_NEW,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await refreshIdToken(REFRESH_TOKEN_OLD);

    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_NEW);
    expect(state.idToken).toBe('new-id-token');
    // refresh_token-FIRST ordering (drone-8 SR axis c): the refresh_token
    // write must precede the id_token write so a subsequent id_token
    // write failure leaves us with (new refresh_token, stale id_token)
    // rather than (new id_token, invalidated old refresh_token).
    expect(state.storeRefreshTokenCalls.length).toBe(1);
    expect(state.storeIdTokenCalls.length).toBe(1);
    expect(state.storeRefreshTokenCalls[0].token).toBe(REFRESH_TOKEN_NEW);
  });

  it('stores only id_token when Google omits refresh_token (no rotation)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: 'new-id-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await refreshIdToken(REFRESH_TOKEN_OLD);

    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_OLD);
    expect(state.idToken).toBe('new-id-token');
    expect(state.storeRefreshTokenCalls.length).toBe(0);
    expect(state.storeIdTokenCalls.length).toBe(1);
  });

  it('rolls back refresh_token write on subsequent id_token write failure, surfaced as TRANSIENT (gh#858 — never "expired")', async () => {
    // Failure mode: rotation succeeded server-side; refresh_token
    // keychain write succeeded; id_token keychain write FAILED. The
    // rollback restores the old refresh_token so the keychain isn't
    // half-rotated — though the actual semantic recovery on next
    // refresh depends on whether Google has already invalidated the
    // old refresh_token server-side (it eagerly does on rotation).
    // The rollback is best-effort consistency with caller perception.
    //
    // gh#858: the Google exchange SUCCEEDED — only the local SAVE failed —
    // so this is a TRANSIENT (preserve tokens, retry), NOT an unclassified
    // raw throw that getValidToken would mis-surface as "Authentication
    // expired — re-consent". The message must NOT advise re-consent.
    const state = await getMockState();
    state.failNextStoreIdToken = true;

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id_token: 'new-id-token',
          refresh_token: REFRESH_TOKEN_NEW,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    let caught: unknown;
    try {
      await refreshIdToken(REFRESH_TOKEN_OLD);
      throw new Error('expected refreshIdToken to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RefreshTransientError);
    // Accurate, save-focused message — NOT "expired"/"re-consent"/"borg setup".
    expect((caught as Error).message).toMatch(/sav|credential store|keychain/i);
    expect((caught as Error).message).not.toMatch(/expired|re-consent|borg setup/i);

    // Rollback still happened: refresh_token restored to its previous value.
    expect(state.refreshToken).toBe(REFRESH_TOKEN_OLD);
    expect(state.storeRefreshTokenCalls.length).toBe(2);
    expect(state.storeRefreshTokenCalls[0].token).toBe(REFRESH_TOKEN_NEW);
    expect(state.storeRefreshTokenCalls[1].token).toBe(REFRESH_TOKEN_OLD);
    // A persist failure is client-agnostic (same keychain), so the device
    // client is NOT re-tried — only the single web exchange ran.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('no-rotation id_token write failure → TRANSIENT, tokens preserved (gh#858)', async () => {
    // Google returns NO refresh_token (no rotation); only the id_token save
    // fails. Must surface as transient (retry), never an unclassified throw.
    const state = await getMockState();
    state.refreshToken = REFRESH_TOKEN_OLD; // a valid saved login exists
    state.failNextStoreIdToken = true;

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id_token: 'fresh-id', expires_in: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    let caught: unknown;
    try {
      await refreshIdToken(REFRESH_TOKEN_OLD);
      throw new Error('expected refreshIdToken to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RefreshTransientError);
    expect((caught as Error).message).not.toMatch(/expired|re-consent|borg setup/i);
    // refresh_token untouched (no rotation), so the valid saved login is preserved.
    expect(state.refreshToken).toBe(REFRESH_TOKEN_OLD);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // persist-fail short-circuits the device retry
  });
});

describe('refreshIdToken — issuing-client cascade (gh#691)', () => {
  const REFRESH_TOKEN_VALUE = 'refresh-token-fixture';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const state = await getMockState();
    state.idToken = null;
    state.refreshToken = REFRESH_TOKEN_VALUE;
    state.expiresAt = 0;
    state.storeIdTokenCalls = [];
    state.storeRefreshTokenCalls = [];
    state.failNextStoreIdToken = false;
    state.failNextStoreRefreshToken = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function clientIdOf(call: any): string | null {
    const body = call?.[1]?.body as URLSearchParams | undefined;
    return body?.get('client_id') ?? null;
  }

  function successResponse() {
    return new Response(
      JSON.stringify({ id_token: 'fresh-id-token', expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  function invalidGrantResponse() {
    return new Response(
      JSON.stringify({
        error: 'invalid_grant',
        error_description: 'wrong client or revoked',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  it('device-flow token: web client rejects (invalid_grant) → device client succeeds → resolves without re-auth', async () => {
    // The BUG-2 (gh#691) repro: a device-flow refresh_token is rejected by
    // the web client but redeemed by the device client. Pre-fix this threw
    // and forced a full device-flow re-auth (+ working refresh_token revoke).
    fetchSpy
      .mockResolvedValueOnce(invalidGrantResponse()) // web attempt
      .mockResolvedValueOnce(successResponse()); // device attempt

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The second attempt used a DIFFERENT OAuth client than the first.
    const webClient = clientIdOf(fetchSpy.mock.calls[0]);
    const deviceClient = clientIdOf(fetchSpy.mock.calls[1]);
    expect(webClient).toBeTruthy();
    expect(deviceClient).toBeTruthy();
    expect(deviceClient).not.toBe(webClient);

    const state = await getMockState();
    expect(state.idToken).toBe('fresh-id-token');
    // Working refresh_token preserved — never cleared/revoked.
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('genuine revocation: BOTH clients reject with invalid_grant → throws RefreshTokenInvalidError', async () => {
    fetchSpy
      .mockResolvedValueOnce(invalidGrantResponse()) // web
      .mockResolvedValueOnce(invalidGrantResponse()); // device

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTokenInvalidError
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // refreshIdToken itself never clears — callers gate clearTokens().
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('web-flow token: web client succeeds → device client is NOT tried (single fetch)', async () => {
    fetchSpy.mockResolvedValueOnce(successResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const state = await getMockState();
    expect(state.idToken).toBe('fresh-id-token');
  });

  it('web client transient (500) → device client succeeds → resolves (transient does not block the device attempt)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(successResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const state = await getMockState();
    expect(state.idToken).toBe('fresh-id-token');
  });

  it('keychain invariant: web invalid_grant + device TRANSIENT → throws RefreshTransientError (NOT Invalid) so the keychain is preserved', async () => {
    // The subtlest case (CR #694 pin): a single invalid_grant — here from the
    // WRONG client (web) for a device-flow token — must NOT surface as
    // RefreshTokenInvalidError. Only RefreshTokenInvalidError makes callers
    // clearTokens(); a wrong-client invalid_grant paired with any non-invalid
    // device outcome must surface as RefreshTransientError → keychain preserved.
    fetchSpy
      .mockResolvedValueOnce(invalidGrantResponse()) // web: invalid_grant (wrong client)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      ); // device: transient (500)

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });

  it('keychain invariant: BOTH clients transient → throws RefreshTransientError → keychain preserved', async () => {
    const transient = () =>
      new Response(JSON.stringify({ error: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    fetchSpy
      .mockResolvedValueOnce(transient()) // web
      .mockResolvedValueOnce(transient()); // device

    await expect(refreshIdToken(REFRESH_TOKEN_VALUE)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const state = await getMockState();
    expect(state.refreshToken).toBe(REFRESH_TOKEN_VALUE);
  });
});

describe('refreshIdToken — gh#860 runtime file fallback on keychain WRITE failure', () => {
  const REFRESH_TOKEN_OLD = 'refresh-token-old';
  const REFRESH_TOKEN_NEW = 'refresh-token-new-rotated';
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const state = await getMockState();
    state.idToken = null;
    state.refreshToken = REFRESH_TOKEN_OLD;
    state.expiresAt = 0;
    state.storeIdTokenCalls = [];
    state.storeRefreshTokenCalls = [];
    state.failNextStoreIdToken = false;
    state.failNextStoreRefreshToken = false;
    state.usingKeychain = true;
    state.fileFallbackEnabled = false;
    state.failFilePersist = false;
    state.fileIdToken = null;
    state.fileRefreshToken = null;
    state.migrateCalls = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    // cerr → console.error; capture so the at-rest warning is assertable + quiet.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    errSpy.mockRestore();
  });

  const rotationResponse = () =>
    new Response(
      JSON.stringify({ id_token: 'new-id-token', refresh_token: REFRESH_TOKEN_NEW, expires_in: 3600 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  it('keychain id_token write fails + file fallback available → migrates, persists to file, refresh RESOLVES', async () => {
    const state = await getMockState();
    state.failNextStoreIdToken = true; // keychain id_token write fails
    state.fileFallbackEnabled = true; // a file backend is available to migrate to
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).resolves.toBeUndefined(); // no throw

    expect(state.migrateCalls).toBe(1); // migrated exactly once
    expect(state.usingKeychain).toBe(false); // now on the file backend
    expect(state.idToken).toBe('new-id-token'); // persisted to file
    expect(state.refreshToken).toBe(REFRESH_TOKEN_NEW); // rotated token persisted to file
    expect(fetchSpy).toHaveBeenCalledTimes(1); // persist failure is client-agnostic — no device retry
  });

  it('migration warning NAMES the at-rest tradeoff (obfuscation-grade, weaker than keychain — SA labeling)', async () => {
    const state = await getMockState();
    state.failNextStoreIdToken = true;
    state.fileFallbackEnabled = true;
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await refreshIdToken(REFRESH_TOKEN_OLD);

    const warning = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warning).toMatch(/obfuscation-grade/i);
    expect(warning).toMatch(/weaker at-rest|weaker.*keychain/i);
    expect(warning).toMatch(/NOT equivalent|not equivalent/i);
    // Must NOT mislabel it as equivalent encryption.
    expect(warning).not.toMatch(/equivalent (encryption|to the keychain at-rest)/i);
  });

  it('NO-REGRESS #858: keychain write fails AND file migration also fails → TRANSIENT, never "expired"', async () => {
    const state = await getMockState();
    state.failNextStoreIdToken = true;
    state.fileFallbackEnabled = false; // file backend unavailable → migration fails
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    let caught: unknown;
    try {
      await refreshIdToken(REFRESH_TOKEN_OLD);
      throw new Error('expected refreshIdToken to reject');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RefreshTransientError);
    expect((caught as Error).message).toMatch(/sav|credential store|keychain/i);
    expect((caught as Error).message).not.toMatch(/expired|re-consent|borg setup/i);
    expect(state.migrateCalls).toBe(1); // attempted migration, but it failed → #858 surface
  });

  it('already on the FILE backend: a write failure does NOT attempt migration (no loop) → TRANSIENT', async () => {
    const state = await getMockState();
    state.usingKeychain = false; // already migrated / explicit BORG_TOKEN_STORE=file
    state.failNextStoreIdToken = true;
    state.fileFallbackEnabled = true;
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(state.migrateCalls).toBe(0); // never tried to migrate (not on keychain)
  });

  // CR coverage (entry 82a7ce46): gh#860 is "keychain WRITE failure during refresh"
  // — the rotation refresh_token-write and the no-rotation id_token-write are equal
  // keychain-write failure points, not just id_token-after-rotation.
  it('keychain REFRESH_TOKEN write fails (rotation) + file fallback → migrates once, persists to file, no device retry, warns', async () => {
    const state = await getMockState();
    state.failNextStoreRefreshToken = true; // keychain refresh_token write fails FIRST
    state.fileFallbackEnabled = true;
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).resolves.toBeUndefined();

    expect(state.migrateCalls).toBe(1);
    expect(state.usingKeychain).toBe(false);
    expect(state.fileIdToken).toBe('new-id-token'); // minted id persisted to file
    expect(state.fileRefreshToken).toBe(REFRESH_TOKEN_NEW); // minted refresh persisted to file
    expect(fetchSpy).toHaveBeenCalledTimes(1); // persist failure is client-agnostic → no device retry
    const warning = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warning).toMatch(/obfuscation-grade/i);
  });

  it('keychain ID_TOKEN write fails (NO rotation) + file fallback → migrates once, carries the EXISTING refresh_token to file, no device retry, warns', async () => {
    const state = await getMockState();
    state.refreshToken = REFRESH_TOKEN_OLD; // the still-valid existing refresh (in keychain)
    state.failNextStoreIdToken = true; // keychain id_token write fails (no refresh_token in response)
    state.fileFallbackEnabled = true;
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id_token: 'fresh-id', expires_in: 3600 }), // no refresh_token → no rotation
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).resolves.toBeUndefined();

    expect(state.migrateCalls).toBe(1);
    expect(state.usingKeychain).toBe(false);
    expect(state.fileIdToken).toBe('fresh-id'); // minted id persisted to file
    // CR/QA 3rd round (167a3437/7d62435a): the EXISTING refresh_token must be carried
    // to file — else the file-backed process is refresh-less and wedges after id expiry.
    expect(state.fileRefreshToken).toBe(REFRESH_TOKEN_OLD);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // no device retry
    const warning = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warning).toMatch(/obfuscation-grade/i);
  });

  it('CR/QA 3rd round: NO resolvable refresh_token (no rotation + keychain read returns null) → NO commit, #858 transient (never refresh-less)', async () => {
    const state = await getMockState();
    state.refreshToken = null; // keychain read yields no existing refresh_token
    state.failNextStoreIdToken = true;
    state.fileFallbackEnabled = true;
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ id_token: 'fresh-id', expires_in: 3600 }), // no rotation
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(refreshIdToken('some-refresh')).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(state.migrateCalls).toBe(0); // refresh-less guard fired BEFORE migration
    expect(state.usingKeychain).toBe(true); // stays keychain — never file-backed refresh-less
  });

  it('SR HIGH (3bed8571): a PARTIAL file persist does NOT silently downgrade — stays keychain, no warning, #858 transient', async () => {
    const state = await getMockState();
    state.failNextStoreIdToken = true; // keychain id_token write fails → migration attempted
    state.fileFallbackEnabled = true; // file backend available...
    state.failFilePersist = true; // ...but a write to it fails partway → atomic NON-commit
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(state.migrateCalls).toBe(1); // migration attempted...
    expect(state.usingKeychain).toBe(true); // ...but NOT committed → process stays keychain-backed
    expect(state.fileIdToken).toBeNull(); // nothing persisted to file
    expect(state.fileRefreshToken).toBeNull();
    const warning = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warning).not.toMatch(/obfuscation-grade/i); // NO at-rest warning on a non-migration
  });

  // Coordinator invariant-workflow mutation assertions (entry 9fc12915), adapted
  // to the atomic (commit-only-on-success) structure.
  it('MEDIUM#1: a SUCCESSFUL keychain refresh NEVER invokes migration (no spurious downgrade of a healthy keychain)', async () => {
    const state = await getMockState();
    state.fileFallbackEnabled = true; // available — but a healthy refresh must not use it
    fetchSpy.mockResolvedValueOnce(rotationResponse());

    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).resolves.toBeUndefined();

    expect(state.migrateCalls).toBe(0); // healthy keychain write → migration never attempted
    expect(state.usingKeychain).toBe(true); // stays keychain
    const warning = errSpy.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(warning).not.toMatch(/obfuscation-grade/i);
  });

  it('LOW#4: same-process DOUBLE keychain failure — warning fires exactly ONCE, no re-migrate after the first', async () => {
    const state = await getMockState();
    state.fileFallbackEnabled = true;

    // Refresh 1: keychain id_token write fails → migrate to file → warn.
    state.failNextStoreIdToken = true;
    fetchSpy.mockResolvedValueOnce(rotationResponse());
    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).resolves.toBeUndefined();
    expect(state.migrateCalls).toBe(1);
    expect(state.usingKeychain).toBe(false); // now file-backed

    // Refresh 2 in the SAME process: already off keychain. A further store failure
    // must NOT re-migrate and must NOT re-warn (warn-once / re-entry guard).
    state.failNextStoreIdToken = true;
    fetchSpy.mockResolvedValueOnce(rotationResponse());
    await expect(refreshIdToken(REFRESH_TOKEN_OLD)).rejects.toBeInstanceOf(
      RefreshTransientError
    );
    expect(state.migrateCalls).toBe(1); // no re-migrate (gate: not on keychain)

    const warnCount = errSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((l) => /obfuscation-grade/i.test(l)).length;
    expect(warnCount).toBe(1); // warned exactly once across both refreshes
  });
});
