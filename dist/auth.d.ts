/**
 * Google OAuth 2.0 Authorization Code Flow with PKCE
 * For Desktop/CLI applications
 *
 * Flow:
 * 1. Generate PKCE code_verifier and code_challenge
 * 2. Start local HTTP server for callback
 * 3. Open browser to Google authorization URL
 * 4. User authorizes in browser
 * 5. Receive authorization code via localhost callback
 * 6. Exchange code for tokens
 * 7. Store tokens securely in OS keychain
 */
import { type DeviceAuthConfig, type DeviceAuthDeps } from './device-auth.js';
/**
 * Refresh-token-revoked / expired — the user must re-run `borg setup`
 * to recover. Anchored on Google's canonical signal: HTTP 400 + JSON
 * body `{"error": "invalid_grant", ...}` from the OAuth token
 * endpoint. Callers should `clearTokens()` on this class only —
 * preserving keychain state on the transient class.
 *
 * Constructor stores parsed `error` + `error_description` fields
 * only — never the request body (which contains the refresh_token)
 * or the raw response body verbatim (per drone-8 SR axis b on
 * token-material non-leakage in error messages).
 */
export declare class RefreshTokenInvalidError extends Error {
    readonly errorCode: string;
    readonly errorDescription?: string | undefined;
    constructor(errorCode: string, errorDescription?: string | undefined);
}
/**
 * Transient failure of the refresh path — network failure, Google
 * 5xx, malformed response, non-`invalid_grant` 4xx, etc. The
 * refresh_token in keychain is presumed still valid; callers MUST
 * NOT `clearTokens()` on this class.
 *
 * The pre-gh#34 implementation classified all refresh failures
 * uniformly and called `clearTokens()` unconditionally; a single
 * transient blip would destroy the durable session. This typed
 * class is the discrimination axis.
 */
export declare class RefreshTransientError extends Error {
    constructor(message: string);
}
/**
 * Decide whether to use the no-browser device-grant flow. An explicit
 * `--no-browser`/`--device` (surfaced as opts.noBrowser) wins; otherwise
 * auto-detect via isNoBrowserEnv (SSH session, container, headless Linux).
 */
export declare function shouldUseDeviceFlow(opts?: {
    noBrowser?: boolean;
}): boolean;
/**
 * Assemble the device-grant OAuth config from the environment. Enforces the
 * gh#557 ESCALATION-1 gate: a "TVs & Limited Input devices" client id must be
 * available (baked-in once the operator creates it, or via GOOGLE_DEVICE_CLIENT_ID).
 * Without one we fail with an actionable error instead of hitting Google with
 * the Desktop client, which rejects /device/code as invalid_client.
 */
export declare function buildDeviceAuthConfig(env?: NodeJS.ProcessEnv): DeviceAuthConfig;
/**
 * The RFC 8628 device-grant flow (no browser). Prints a verification URL +
 * user_code for the human to open on ANY device, polls Google until they
 * authorize, then stores tokens in the selected backend. Network deps are
 * injectable for tests; the device-poll state machine itself lives in
 * device-auth.ts (fully unit-tested).
 */
export declare function authenticateWithDeviceFlow(deps?: DeviceAuthDeps, env?: NodeJS.ProcessEnv): Promise<void>;
/**
 * Perform the complete OAuth flow, choosing the browser/loopback flow or the
 * no-browser device-grant flow based on the environment (gh#557). Stores
 * tokens in the selected backend on success.
 *
 * @param opts.noBrowser  force the device flow (`--no-browser`/`--device`);
 *                        when omitted, the environment is auto-detected.
 */
export declare function authenticateWithGoogle(opts?: {
    noBrowser?: boolean;
}): Promise<void>;
/**
 * Refresh the stored id_token, redeeming the refresh_token against the
 * OAuth client that ISSUED it (gh#691).
 *
 * A refresh_token can only be redeemed by its issuing client. The browser
 * flow issues tokens under the web client (GOOGLE_CLIENT_ID); the device
 * flow (`borg setup --no-browser`, gh#557) issues them under the device
 * client (buildDeviceAuthConfig). We don't persist which flow minted the
 * stored token, so try the web client first, then the device client.
 *
 * Before this fix the refresh hard-coded the web client, so every
 * device-flow user's silent refresh failed at id_token expiry — forcing a
 * full re-auth (which revokes the working refresh_token to force fresh
 * consent) on the next command. That was the friction in gh#691.
 *
 * Keychain safety: clear-on-revocation (RefreshTokenInvalidError, which
 * callers gate `clearTokens()` on) is surfaced ONLY when BOTH clients
 * reject the token with invalid_grant. Any inconclusive/transient outcome
 * on either attempt preserves the keychain for retry — a wrong-client
 * invalid_grant must not be mistaken for a genuine revocation.
 */
export declare function refreshIdToken(refreshToken: string): Promise<void>;
//# sourceMappingURL=auth.d.ts.map