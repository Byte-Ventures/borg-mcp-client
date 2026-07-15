/**
 * gh#557 — Google OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * The no-browser counterpart to the loopback flow in auth.ts. Instead of
 * opening a browser and listening on localhost, the device flow:
 *   1. asks Google for a device_code + a short human-typable user_code,
 *   2. prints a verification URL + the user_code for the human to open on
 *      ANY device (their phone, a laptop with a browser), and
 *   3. polls Google's token endpoint until the human authorizes (or the
 *      code expires / is denied).
 *
 * This module is decoupled from the live Google client: `fetch`, `sleep`,
 * and `now` are injected, and the client_id / client_secret / endpoints
 * come from the caller. The live device flow needs a Google OAuth client
 * of type "TVs & Limited Input devices" (a separate GOOGLE_DEVICE_CLIENT_ID
 * — Desktop/loopback clients reject /device/code with invalid_client); the
 * wiring layer supplies those credentials. Everything here is unit-tested
 * against a mocked Google.
 */
const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
/**
 * Failure of the device-grant flow. `code` is Google's OAuth error code
 * where one exists (`access_denied`, `expired_token`, `invalid_client`,
 * `slow_down`, `authorization_pending`) or a synthetic code for
 * transport/shape failures (`device_code_request_failed`,
 * `device_token_request_failed`, `malformed_token_response`).
 *
 * Token material is never placed in the message — only Google's error
 * code + description, mirroring RefreshTokenInvalidError's discipline.
 */
export class DeviceAuthError extends Error {
    code;
    constructor(code, message) {
        super(message ?? code);
        this.code = code;
        this.name = 'DeviceAuthError';
    }
}
/**
 * Step 1 — request a device_code + user_code from Google.
 */
export async function requestDeviceCode(config, deps) {
    const url = config.deviceCodeUrl ?? GOOGLE_DEVICE_CODE_URL;
    let response;
    try {
        response = await deps.fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: config.clientId,
                scope: config.scopes.join(' '),
            }),
        });
    }
    catch (err) {
        throw new DeviceAuthError('device_code_request_failed', `Could not reach Google device endpoint: ${err?.message ?? 'unknown'}`);
    }
    if (!response.ok) {
        const code = await readErrorCode(response);
        throw new DeviceAuthError(code ?? 'device_code_request_failed', `Device-code request failed (HTTP ${response.status}${code ? `, ${code}` : ''})`);
    }
    let data;
    try {
        data = (await response.json());
    }
    catch {
        throw new DeviceAuthError('malformed_token_response', 'Device-code response was not JSON');
    }
    if (!data.device_code || !data.user_code || !data.verification_url) {
        throw new DeviceAuthError('malformed_token_response', 'Device-code response missing device_code/user_code/verification_url');
    }
    return {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_url: data.verification_url,
        expires_in: typeof data.expires_in === 'number' ? data.expires_in : 1800,
        interval: typeof data.interval === 'number' ? data.interval : DEFAULT_INTERVAL_SECONDS,
    };
}
/**
 * Step 2 — poll Google's token endpoint until the user authorizes the
 * device_code, honoring the RFC 8628 poll semantics.
 *
 * Sleeps `interval` BEFORE each poll (never hammers immediately). A local
 * deadline derived from `expires_in` bounds the loop so a code the user
 * abandons can't poll forever even if Google never returns expired_token.
 */
export async function pollForDeviceToken(deviceCode, config, deps) {
    const tokenUrl = config.tokenUrl ?? GOOGLE_TOKEN_URL;
    const now = deps.now ?? Date.now;
    const deadline = now() + deviceCode.expires_in * 1000;
    let intervalSeconds = deviceCode.interval > 0 ? deviceCode.interval : DEFAULT_INTERVAL_SECONDS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (now() >= deadline) {
            throw new DeviceAuthError('expired_token', 'Device code expired before the authorization was completed');
        }
        await deps.sleep(intervalSeconds * 1000);
        let response;
        try {
            response = await deps.fetch(tokenUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: config.clientId,
                    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
                    device_code: deviceCode.device_code,
                    grant_type: DEVICE_GRANT_TYPE,
                }),
            });
        }
        catch (err) {
            throw new DeviceAuthError('device_token_request_failed', `Could not reach Google token endpoint: ${err?.message ?? 'unknown'}`);
        }
        if (response.ok) {
            let data;
            try {
                data = (await response.json());
            }
            catch {
                throw new DeviceAuthError('malformed_token_response', 'Token response was not JSON');
            }
            if (!data.id_token || typeof data.expires_in !== 'number') {
                throw new DeviceAuthError('malformed_token_response', 'Token response missing id_token or expires_in');
            }
            return {
                id_token: data.id_token,
                refresh_token: data.refresh_token,
                expires_in: data.expires_in,
            };
        }
        const code = await readErrorCode(response);
        switch (code) {
            case 'authorization_pending':
                // The user hasn't finished yet — keep polling at the same interval.
                continue;
            case 'slow_down':
                // Google asks us to back off; RFC 8628 §3.5 → bump the interval.
                intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
                continue;
            case 'access_denied':
                throw new DeviceAuthError('access_denied', 'Authorization was denied by the user');
            case 'expired_token':
                throw new DeviceAuthError('expired_token', 'Device code expired before authorization');
            default:
                throw new DeviceAuthError(code ?? 'device_token_request_failed', `Device token poll failed (HTTP ${response.status}${code ? `, ${code}` : ''})`);
        }
    }
}
/**
 * Extract Google's OAuth `error` code from a non-2xx response body without
 * throwing. Returns null when the body isn't JSON or has no error field.
 */
async function readErrorCode(response) {
    try {
        const body = (await response.json());
        return typeof body?.error === 'string' ? body.error : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=device-auth.js.map