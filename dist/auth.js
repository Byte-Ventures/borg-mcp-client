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
import { createServer } from 'http';
import { URL } from 'url';
import crypto from 'crypto';
import open from 'open';
import { storeIdToken, storeRefreshToken, getRefreshToken, isUsingKeychainBackend, migrateToFileBackendWithTokens, } from './config.js';
import { cerr } from './console-prefix.js';
import { isNoBrowserEnv } from './auth-env.js';
import { requestDeviceCode, pollForDeviceToken, } from './device-auth.js';
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
export class RefreshTokenInvalidError extends Error {
    errorCode;
    errorDescription;
    constructor(errorCode, errorDescription) {
        super(errorDescription
            ? `Refresh token invalid (${errorCode}): ${errorDescription}`
            : `Refresh token invalid (${errorCode})`);
        this.errorCode = errorCode;
        this.errorDescription = errorDescription;
        this.name = 'RefreshTokenInvalidError';
    }
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
export class RefreshTransientError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RefreshTransientError';
    }
}
// Google OAuth Client credentials for Borg MCP CLI (Desktop app)
// Per Google's documentation: "the client secret is obviously not treated as a secret"
// for installed/desktop applications. This follows industry standard (AWS CLI, gcloud, GitHub CLI)
const GOOGLE_CLIENT_ID = '675073910799-41pbe12rfhqemidh64h09s4q3e0udpgp.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = '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';
// gh#557 ESCALATION-1: the device-grant flow needs a SEPARATE Google OAuth
// client of type "TVs & Limited Input devices" — the Desktop/loopback client
// above rejects POST /device/code with invalid_client. The operator/Queen
// created that client in Cloud Console (project 675073910799) and its
// credentials are baked in below so published clients do headless auth
// out-of-box. For "TVs & Limited Input devices" clients Google designs the
// secret to ship inside distributed apps (RFC 8628 limited-input client) — it
// is NOT a confidential credential, so baking it into the published package is
// the intended pattern, not a leak. GOOGLE_DEVICE_CLIENT_ID /
// GOOGLE_DEVICE_CLIENT_SECRET stay as optional env overrides for operators who
// point the device flow at their own client.
const BAKED_IN_DEVICE_CLIENT_ID = '675073910799-6qmi73v5106dj1v0l22j2qnkh5r3e8fq.apps.googleusercontent.com';
const BAKED_IN_DEVICE_CLIENT_SECRET = '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';
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const SCOPES = ['openid', 'email', 'profile'];
// Port range for dynamic port selection (8000-9000)
const PORT_RANGE_START = 8000;
const PORT_RANGE_END = 9000;
// gh#653 B3: how long the local OAuth callback server waits for the browser
// redirect before giving up. Named so the user-facing "up to N minutes" copy
// and the actual timeout can't drift apart.
const AUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_CALLBACK_TIMEOUT_MIN = AUTH_CALLBACK_TIMEOUT_MS / 60_000;
/**
 * Generate PKCE code_verifier and code_challenge
 * Uses SHA256 hashing per OAuth 2.0 PKCE spec (RFC 7636)
 */
function generatePKCE() {
    // Generate random code_verifier (43-128 characters)
    const verifier = crypto.randomBytes(32).toString('base64url');
    // Generate code_challenge = BASE64URL(SHA256(code_verifier))
    const challenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
    return { verifier, challenge };
}
/**
 * Find an available port in the specified range
 */
async function findAvailablePort() {
    return new Promise((resolve, reject) => {
        // Try to bind to port 0 to let the OS assign a free port
        const testServer = createServer();
        testServer.listen(0, () => {
            const address = testServer.address();
            if (address && typeof address === 'object') {
                const port = address.port;
                testServer.close(() => resolve(port));
            }
            else {
                testServer.close(() => reject(new Error('Failed to get assigned port')));
            }
        });
        testServer.on('error', reject);
    });
}
/**
 * Start local HTTP server to receive OAuth callback
 * Returns { server, port, codePromise }
 */
async function startCallbackServer() {
    // Find available port first
    const port = await findAvailablePort();
    const codePromise = new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname === '/callback') {
                const code = url.searchParams.get('code');
                const error = url.searchParams.get('error');
                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(`
            <html>
              <body>
                <h1>◼ Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
                    server.close();
                    reject(new Error(`OAuth error: ${error}`));
                    return;
                }
                if (code) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
            <html>
              <body>
                <h1>◼ Authentication Successful!</h1>
                <p>You can close this window and return to your terminal.</p>
              </body>
            </html>
          `);
                    server.close();
                    resolve(code);
                    return;
                }
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body>
              <h1>◼ Invalid Request</h1>
              <p>Missing authorization code.</p>
            </body>
          </html>
        `);
                server.close();
                reject(new Error('Missing authorization code'));
            }
        });
        server.listen(port, () => {
            cerr(`Callback server listening on http://localhost:${port}`);
        });
        // Timeout after AUTH_CALLBACK_TIMEOUT_MS. .unref() so the timer doesn't
        // keep the Node event loop alive after auth succeeds — without it,
        // borg-setup appears to hang for 5 minutes after printing "Setup
        // complete!" even though all real work is done.
        setTimeout(() => {
            server.close();
            // gh#653 B3: actionable timeout — name the cause + the recovery path
            // instead of a bare "no response received".
            reject(new Error(`Authentication timed out after ${AUTH_CALLBACK_TIMEOUT_MIN} minutes — ` +
                `no authorization received from the browser. Re-run \`borg setup\` and ` +
                `complete the Google sign-in in the page that opens.`));
        }, AUTH_CALLBACK_TIMEOUT_MS).unref();
    });
    return { port, codePromise };
}
/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(code, codeVerifier, port) {
    const redirectUri = `http://localhost:${port}/callback`;
    const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code,
            code_verifier: codeVerifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
        }),
    });
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to exchange code for tokens: ${error}`);
    }
    return (await response.json());
}
/**
 * Best-effort revocation of a refresh_token at Google's revocation endpoint
 * (RFC 7009). Failures are intentionally swallowed — revocation is opportunistic
 * cleanup of Google's session-side state before requesting fresh consent. If the
 * network is down or the token is already revoked, the subsequent consent flow
 * still runs. The only consequence of skipping revocation is that Google MAY
 * dedupe the new consent and decline to return a fresh refresh_token (the bug
 * class this revocation step exists to prevent).
 */
async function revokeRefreshTokenAtGoogle(refreshToken) {
    try {
        // gh#55: per RFC 7009 §2.1, the token MUST be sent in the request
        // body (application/x-www-form-urlencoded), not the query string.
        // Google accepts both shapes in practice, but the prior query-string
        // transport contradicted the declared `Content-Type` header and was
        // a code-clarity issue drone-2 flagged in PR #38 retrospective.
        await fetch(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `token=${encodeURIComponent(refreshToken)}`,
        });
    }
    catch {
        // Intentional swallow — see docstring above. Revocation is opportunistic.
    }
}
/**
 * The browser/loopback OAuth flow (PKCE authorization-code). The DEFAULT
 * path on a desktop with a browser; gh#557 dispatches here from
 * `authenticateWithGoogle` unless the environment is browserless.
 *
 * Opens a browser for user authorization and stores tokens in the selected
 * token backend on success.
 *
 * Force-fresh-consent discipline: before requesting new consent, this function
 * revokes any existing refresh_token at Google's revocation endpoint AND uses
 * `prompt=consent select_account` (multi-value prompt) to force both the
 * consent screen and account picker. Together, these clear Google's
 * session-side memory of prior consent, ensuring Google issues a fresh
 * `refresh_token` rather than deduping the consent and returning only an
 * id_token. (Without this, Google's dedup behavior can leave the user with
 * an id_token but no refresh_token, forcing manual re-setup after the ~1h
 * id_token TTL expires.)
 */
async function authenticateWithBrowser() {
    cerr('\n◼ Borg MCP Authentication');
    cerr('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    // Step 0: revoke any existing refresh_token to force Google to re-issue
    // one in the fresh consent flow below (defeats Google's consent dedup
    // behavior that leaves clients in a no-refresh-token state).
    const existingRefreshToken = await getRefreshToken();
    if (existingRefreshToken) {
        cerr('Revoking previous refresh_token to force fresh consent...');
        await revokeRefreshTokenAtGoogle(existingRefreshToken);
    }
    // Step 1: Generate PKCE pair
    cerr('Generating PKCE challenge...');
    const pkce = generatePKCE();
    // Step 2: Start local callback server (gets dynamic port)
    cerr('Starting local callback server...');
    const { port, codePromise } = await startCallbackServer();
    // Step 3: Build authorization URL with dynamic redirect URI
    const redirectUri = `http://localhost:${port}/callback`;
    const authUrl = new URL(GOOGLE_AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token
    // Multi-value prompt forces both consent screen AND account picker. Combined
    // with the pre-revocation step above, this reliably forces Google to issue
    // a fresh refresh_token instead of deduping the consent.
    authUrl.searchParams.set('prompt', 'consent select_account');
    // Step 4: Open browser
    cerr('\n📱 Opening browser for authorization...');
    cerr('If browser does not open, visit:');
    cerr(`${authUrl.toString()}\n`);
    try {
        await open(authUrl.toString());
    }
    catch (err) {
        cerr(`Could not open a browser automatically: ${err?.message ?? 'unknown'}`);
        cerr('Continue by opening the URL above manually.');
    }
    // Step 5: Wait for authorization code
    // gh#653 B3: tell the user WHAT to do and that the terminal resumes on its
    // own, so the wait doesn't read as a hang (browser-flow stall point).
    cerr(`Waiting for you to finish signing in (up to ${AUTH_CALLBACK_TIMEOUT_MIN} ` +
        `minutes)... this terminal continues automatically once you approve.`);
    const code = await codePromise;
    // Step 6: Exchange code for tokens
    cerr('Exchanging authorization code for tokens...');
    const tokenData = await exchangeCodeForTokens(code, pkce.verifier, port);
    // Step 7: Store tokens securely
    const expiresAt = Date.now() + tokenData.expires_in * 1000;
    await storeIdToken(tokenData.id_token, expiresAt);
    if (tokenData.refresh_token) {
        await storeRefreshToken(tokenData.refresh_token);
    }
    else {
        // No refresh_token means auto-refresh-on-expiry will fail and force
        // the user back through `borg setup` after ~1 hour. Google
        // sometimes dedupes consent and skips the refresh_token even when
        // prompt=consent is set. Surface this so the user can revoke and
        // reconsent if they want durable sessions.
        cerr('\n⚠  No refresh_token returned by Google.');
        cerr('   Your session will expire after ~1 hour and require');
        cerr('   re-running `borg setup`. To enable auto-refresh:');
        cerr('   1. Visit https://myaccount.google.com/permissions');
        cerr('   2. Find "Borg MCP" and click "Remove access"');
        cerr('   3. Re-run `borg setup`');
        cerr('   (Google will then issue a fresh refresh_token.)\n');
    }
    cerr('\n◼ Authentication successful!\n');
}
/**
 * Decide whether to use the no-browser device-grant flow. An explicit
 * `--no-browser`/`--device` (surfaced as opts.noBrowser) wins; otherwise
 * auto-detect via isNoBrowserEnv (SSH session, container, headless Linux).
 */
export function shouldUseDeviceFlow(opts) {
    return opts?.noBrowser ?? isNoBrowserEnv();
}
/**
 * Assemble the device-grant OAuth config from the environment. Enforces the
 * gh#557 ESCALATION-1 gate: a "TVs & Limited Input devices" client id must be
 * available (baked-in once the operator creates it, or via GOOGLE_DEVICE_CLIENT_ID).
 * Without one we fail with an actionable error instead of hitting Google with
 * the Desktop client, which rejects /device/code as invalid_client.
 */
export function buildDeviceAuthConfig(env = process.env) {
    // Pair the secret with the id SOURCE so an env override never inherits the
    // baked-in client's secret: an operator pointing GOOGLE_DEVICE_CLIENT_ID at
    // their own client supplies their own (optional) secret; the baked-in secret
    // applies only to the baked-in id.
    const envClientId = env.GOOGLE_DEVICE_CLIENT_ID?.trim();
    const envClientSecret = env.GOOGLE_DEVICE_CLIENT_SECRET?.trim() || undefined;
    let clientId;
    let clientSecret;
    if (envClientId) {
        clientId = envClientId;
        clientSecret = envClientSecret;
    }
    else {
        // Baked-in id ALWAYS pairs with the baked-in secret. A stray
        // GOOGLE_DEVICE_CLIENT_SECRET set WITHOUT an id override must NOT re-pair
        // the baked id with a foreign secret ({baked id, wrong secret} →
        // invalid_client). Override is all-or-nothing with the id.
        clientId = BAKED_IN_DEVICE_CLIENT_ID;
        clientSecret = BAKED_IN_DEVICE_CLIENT_SECRET || undefined;
    }
    if (!clientId) {
        throw new Error('No-browser (device-grant) auth needs a Google "TVs & Limited Input devices" ' +
            'OAuth client. Set GOOGLE_DEVICE_CLIENT_ID in the environment, or run ' +
            '`borg setup` on a machine with a browser. See docs/REMOTE_TERMINAL_AUTH.md.');
    }
    return { clientId, clientSecret, scopes: SCOPES };
}
/** Real sleep for the production device-poll loop. */
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * The RFC 8628 device-grant flow (no browser). Prints a verification URL +
 * user_code for the human to open on ANY device, polls Google until they
 * authorize, then stores tokens in the selected backend. Network deps are
 * injectable for tests; the device-poll state machine itself lives in
 * device-auth.ts (fully unit-tested).
 */
export async function authenticateWithDeviceFlow(deps = { fetch, sleep: defaultSleep }, env = process.env) {
    cerr('\n◼ Borg MCP Authentication (no-browser mode)');
    cerr('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    const config = buildDeviceAuthConfig(env);
    // Same force-fresh-consent discipline as the browser flow: revoke any
    // existing refresh_token so Google re-issues one in the new grant.
    const existingRefreshToken = await getRefreshToken();
    if (existingRefreshToken) {
        cerr('Revoking previous refresh_token to force fresh consent...');
        await revokeRefreshTokenAtGoogle(existingRefreshToken);
    }
    const deviceCode = await requestDeviceCode(config, deps);
    cerr('To authorize Borg MCP on this machine:');
    cerr(`  1. On any device with a browser, open:  ${deviceCode.verification_url}`);
    cerr(`  2. Enter this code:  ${deviceCode.user_code}\n`);
    cerr('Waiting for authorization (this page can be open on your phone or laptop)...');
    const tokens = await pollForDeviceToken(deviceCode, config, deps);
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await storeIdToken(tokens.id_token, expiresAt);
    if (tokens.refresh_token) {
        await storeRefreshToken(tokens.refresh_token);
    }
    else {
        cerr('\n⚠  No refresh_token returned by Google.');
        cerr('   Your session will expire after ~1 hour and require re-running');
        cerr('   `borg setup`. Re-consent at https://myaccount.google.com/permissions');
        cerr('   (remove "Borg MCP") then re-run setup to restore automatic token refresh.\n');
    }
    cerr('\n◼ Authentication successful!\n');
}
/**
 * Perform the complete OAuth flow, choosing the browser/loopback flow or the
 * no-browser device-grant flow based on the environment (gh#557). Stores
 * tokens in the selected backend on success.
 *
 * @param opts.noBrowser  force the device flow (`--no-browser`/`--device`);
 *                        when omitted, the environment is auto-detected.
 */
export async function authenticateWithGoogle(opts) {
    if (shouldUseDeviceFlow(opts)) {
        return authenticateWithDeviceFlow();
    }
    return authenticateWithBrowser();
}
/**
 * Attempt a single refresh_token → id_token exchange against ONE OAuth
 * client (gh#34 hardened). The exported `refreshIdToken` below orchestrates
 * the web-then-device cascade over this helper (gh#691); a refresh_token can
 * only be redeemed by its issuing client and we don't persist which flow
 * minted the stored token.
 *
 * Returns a RefreshAttemptResult (never throws on a classified failure) so
 * the orchestrator can weigh BOTH client attempts before deciding whether
 * the token is genuinely revoked (clear keychain) or should be retried.
 *
 * Three substantive properties carried from the pre-gh#34 shape:
 *
 *  1. **Typed discrimination.** Classifies as `kind:'invalid'` (carrying
 *     `RefreshTokenInvalidError`) only when Google's response is the
 *     canonical revoked/expired signal (HTTP 400 + JSON body
 *     `{"error": "invalid_grant"}`). Every other failure mode
 *     (network/DNS/timeout, Google 5xx, malformed response, other
 *     4xx error codes like `invalid_request` or `unauthorized_client`,
 *     non-JSON body) becomes `kind:'transient'`. The orchestrator gates
 *     `clearTokens()` on BOTH attempts returning Invalid — transient
 *     (or single-client invalid) outcomes preserve the keychain so a
 *     network blip or wrong-client rejection doesn't destroy a durable
 *     session.
 *
 *  2. **refresh_token rotation handling.** If Google's response
 *     includes a new `refresh_token` (token rotation feature),
 *     store the new value before storing the id_token. Ordering
 *     matters: refresh_token write FIRST so a subsequent id_token
 *     write failure leaves us with `(new refresh_token, stale
 *     id_token)` — a recoverable state where the next refresh
 *     attempt uses the new refresh_token to fetch a fresh id_token.
 *     The reverse ordering would leave `(new id_token, stale
 *     refresh_token)`, and Google's rotation eagerly invalidates
 *     the stale refresh_token server-side, so the next refresh
 *     fails with `invalid_grant` and locks the user out (drone-8 SR
 *     axis c, 14:07:28).
 *
 *  3. **Classification anchored on the parsed body**, not on the
 *     HTTP status alone or substring-matched against a thrown JS
 *     error string. Per drone-8 SR axis (a): status-code-alone is
 *     fragile (Google can return 400 for `invalid_request` /
 *     `unauthorized_client` which are NOT revocation); substring
 *     matching is spoofable. We parse the JSON `error` field and
 *     match on its exact value.
 */
async function attemptRefreshWithClient(refreshToken, clientId, clientSecret) {
    const refreshParams = {
        client_id: clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
    };
    // Device-code clients ("TVs & Limited Input devices") may be configured
    // without a secret; only send one when we have it (mirrors the device
    // token request in device-auth.ts).
    if (clientSecret) {
        refreshParams.client_secret = clientSecret;
    }
    let response;
    try {
        response = await fetch(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams(refreshParams),
        });
    }
    catch (err) {
        // Network-layer failure: DNS, connection refused, TLS handshake
        // failure, timeout, etc. None of these signal refresh_token
        // revocation — treat as transient.
        return {
            ok: false,
            kind: 'transient',
            error: new RefreshTransientError(`Network failure during token refresh: ${err?.message ?? 'unknown'}`),
        };
    }
    if (!response.ok) {
        // Parse the response body. Fall back to Transient on non-JSON
        // (proxy error page, HTML error from misrouted request, etc.) —
        // when we can't tell, preserve tokens (safer default).
        let errBody = null;
        try {
            errBody = (await response.json());
        }
        catch {
            return {
                ok: false,
                kind: 'transient',
                error: new RefreshTransientError(`Token refresh failed with HTTP ${response.status} (non-JSON body)`),
            };
        }
        // Canonical Google OAuth revocation signal: HTTP 400 + parsed
        // body `error === 'invalid_grant'`. Everything else (other 4xx
        // error codes, 5xx, missing/unexpected error field) is Transient.
        // NB: a refresh_token redeemed against the WRONG client can also
        // yield invalid_grant — the orchestrator only treats it as terminal
        // when BOTH clients reject it (gh#691).
        if (response.status === 400 && errBody?.error === 'invalid_grant') {
            return {
                ok: false,
                kind: 'invalid',
                error: new RefreshTokenInvalidError('invalid_grant', errBody.error_description),
            };
        }
        return {
            ok: false,
            kind: 'transient',
            error: new RefreshTransientError(`Token refresh failed with HTTP ${response.status}${errBody?.error ? ` (${errBody.error})` : ''}`),
        };
    }
    let data;
    try {
        data = (await response.json());
    }
    catch (err) {
        return {
            ok: false,
            kind: 'transient',
            error: new RefreshTransientError(`Token refresh response unparseable: ${err?.message ?? 'unknown'}`),
        };
    }
    if (!data.id_token || typeof data.expires_in !== 'number') {
        return {
            ok: false,
            kind: 'transient',
            error: new RefreshTransientError('Token refresh response missing id_token or expires_in'),
        };
    }
    const expiresAt = Date.now() + data.expires_in * 1000;
    // Persist the freshly-minted tokens. gh#858: the Google exchange has already
    // SUCCEEDED — a failure HERE is a local credential-store WRITE failure (e.g. a
    // locked OS keychain in a long-running background process), NOT a credential
    // problem. Classify it `transient` + `persistFailed` (preserve tokens, retry)
    // with a save-focused message, so it NEVER escapes as an unclassified throw
    // that getValidToken mis-surfaces as "Authentication expired — re-consent /
    // run borg setup". (That misclassification wedged long-running MCP children on
    // a locked keychain, repeatedly advising a re-consent that fixes nothing.)
    try {
        if (data.refresh_token) {
            // Rotation: store the new refresh_token FIRST so a subsequent id_token
            // write failure leaves us recoverable (new refresh_token + stale id_token)
            // rather than locked-out (new id_token + invalidated old refresh_token).
            // The previous-token snapshot lets us roll back the refresh_token write if
            // the id_token write fails, keeping the keychain consistent with what the
            // caller perceives.
            const previousRefreshToken = await getRefreshToken();
            await storeRefreshToken(data.refresh_token);
            try {
                await storeIdToken(data.id_token, expiresAt);
            }
            catch (err) {
                // Best-effort rollback: if it itself fails, the original error still
                // wins and the new-refresh-token-only state is recoverable next refresh.
                if (previousRefreshToken) {
                    try {
                        await storeRefreshToken(previousRefreshToken);
                    }
                    catch {
                        // intentional swallow — original error takes precedence
                    }
                }
                throw err;
            }
        }
        else {
            // No rotation — just refresh the id_token.
            await storeIdToken(data.id_token, expiresAt);
        }
        return { ok: true };
    }
    catch (err) {
        // gh#860: the Google exchange SUCCEEDED but the keychain WRITE failed. Before
        // surfacing #858's transient, try to RESOLVE the availability problem: migrate
        // THIS process to the encrypted-file backend and re-persist there, so the
        // already-minted tokens are saved despite an unwritable keychain (keychain
        // stays the default for every other install + the next fresh process).
        if (await migrateToFileBackendAndPersist(data, expiresAt)) {
            return { ok: true };
        }
        // File fallback unavailable/also-failed → preserve #858: classify transient +
        // persistFailed (tokens preserved, retry), NEVER an unclassified throw that
        // getValidToken mis-surfaces as "Authentication expired — re-consent".
        return {
            ok: false,
            kind: 'transient',
            persistFailed: true,
            error: new RefreshTransientError(`Token refresh succeeded but saving it to the credential store failed ` +
                `(the keychain may be locked, or a background process can't write it): ` +
                `${err?.message ?? 'unknown'}`),
        };
    }
}
/**
 * gh#860: on a keychain WRITE failure, migrate THIS process to the encrypted-file
 * backend and re-persist the freshly-minted tokens there. Returns true when the
 * tokens are safely saved to file (refresh resolved), false when migration isn't
 * applicable or also failed (caller falls back to #858's transient surface).
 *
 * Gated on the keychain backend: a write failure ALREADY on the file backend is a
 * real disk problem, not a locked keychain — migrating would loop. Any error in
 * the migration/persist path returns false (→ #858 transient), never throws.
 */
async function migrateToFileBackendAndPersist(data, expiresAt) {
    if (!data.id_token)
        return false; // nothing to persist (TS narrowing is reset in catch)
    let migrated = false;
    try {
        if (!(await isUsingKeychainBackend()))
            return false;
        // gh#860 (CR/QA 3rd round, 167a3437/7d62435a): carry a WORKING refresh_token
        // into the file backend. A no-rotation refresh returns no NEW refresh_token, so
        // the still-valid existing one must come from the current (keychain) backend —
        // read it BEFORE the switch (the keychain WRITE failed; READs typically still
        // work). A file-backed process must NEVER be left refresh-less: if neither a
        // minted nor a readable existing refresh_token resolves, do NOT commit → fall
        // through to #858 transient (stay keychain). The #858 TARGET is a long-running
        // child that does not restart, so "next fresh process re-probes" cannot recover it.
        const effectiveRefresh = data.refresh_token ?? (await getRefreshToken());
        if (!effectiveRefresh)
            return false;
        // gh#860 SR HIGH (3bed8571): ATOMIC — the file backend is committed (and the
        // process becomes file-backed) ONLY if every write succeeds. A partial failure
        // leaves the process on keychain → #858 transient below, and the warning fires
        // ONLY on a true (fully-committed) migration. The gate: the process never ends
        // up file-backed without the at-rest warning, and never refresh-less.
        migrated = await migrateToFileBackendWithTokens({
            idToken: data.id_token,
            expiresAt,
            refreshToken: effectiveRefresh,
        });
    }
    catch {
        return false;
    }
    if (!migrated)
        return false;
    warnFileFallbackTradeoff();
    return true;
}
/**
 * gh#860: surface the at-rest tradeoff of the runtime file fallback. Per the
 * Security Auditor labeling requirement (SA memo 37d48b11): the file backend is
 * obfuscation-grade — NOT equivalent to the OS keychain. Fires once per process
 * naturally (the backend is keychain only until the first migration; afterward
 * isUsingKeychainBackend() is false, so this path is never re-entered).
 */
function warnFileFallbackTradeoff() {
    cerr('\n⚠  Keychain write failed — migrated this session to the encrypted-file token store (~/.borg/credentials).');
    cerr('   This is an AVAILABILITY fallback, NOT equivalent to the OS keychain.');
    cerr('   The file backend is obfuscation-grade: its key is derived from');
    cerr('   hostname+username+platform (non-secret), so it is WEAKER at-rest than');
    cerr('   the keychain — same-machine/root access can re-derive it and decrypt.');
    cerr('   To restore keychain storage, fix keychain write access and re-run `borg setup`.\n');
}
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
export async function refreshIdToken(refreshToken) {
    const web = await attemptRefreshWithClient(refreshToken, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    if (web.ok)
        return;
    // gh#858: a persist (credential-store WRITE) failure is client-agnostic — the
    // Google exchange already succeeded, so re-running it against the device
    // client cannot help. Surface the transient save error immediately.
    if (web.kind === 'transient' && web.persistFailed)
        throw web.error;
    const device = buildDeviceAuthConfig();
    const dev = await attemptRefreshWithClient(refreshToken, device.clientId, device.clientSecret);
    if (dev.ok)
        return;
    // Neither client could redeem the token. Surface the canonical
    // revocation signal (→ clearTokens) ONLY when BOTH clients rejected it
    // as invalid_grant; otherwise surface the transient error so the
    // keychain is preserved and the next attempt can retry.
    if (web.kind === 'invalid' && dev.kind === 'invalid') {
        throw dev.error;
    }
    throw web.kind === 'transient' ? web.error : dev.error;
}
//# sourceMappingURL=auth.js.map