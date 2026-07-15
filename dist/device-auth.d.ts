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
export declare class DeviceAuthError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
export interface DeviceAuthConfig {
    clientId: string;
    /** Limited-Input clients are issued a secret; included in the token poll. */
    clientSecret?: string;
    scopes: string[];
    /** Overridable for tests; defaults to Google's production endpoints. */
    deviceCodeUrl?: string;
    tokenUrl?: string;
}
export interface DeviceAuthDeps {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    /** Monotonic-ish clock for the local expiry deadline; defaults to Date.now. */
    now?: () => number;
}
export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    /** Google returns `verification_url` (not the RFC's `verification_uri`). */
    verification_url: string;
    expires_in: number;
    interval: number;
}
export interface DeviceTokenResult {
    id_token: string;
    refresh_token?: string;
    expires_in: number;
}
/**
 * Step 1 — request a device_code + user_code from Google.
 */
export declare function requestDeviceCode(config: DeviceAuthConfig, deps: DeviceAuthDeps): Promise<DeviceCodeResponse>;
/**
 * Step 2 — poll Google's token endpoint until the user authorizes the
 * device_code, honoring the RFC 8628 poll semantics.
 *
 * Sleeps `interval` BEFORE each poll (never hammers immediately). A local
 * deadline derived from `expires_in` bounds the loop so a code the user
 * abandons can't poll forever even if Google never returns expired_token.
 */
export declare function pollForDeviceToken(deviceCode: DeviceCodeResponse, config: DeviceAuthConfig, deps: DeviceAuthDeps): Promise<DeviceTokenResult>;
//# sourceMappingURL=device-auth.d.ts.map