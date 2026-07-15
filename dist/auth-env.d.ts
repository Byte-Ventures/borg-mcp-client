/**
 * gh#557 — environment / capability detection for remote-terminal auth.
 *
 * The default OAuth path (auth.ts) opens a browser and listens on a
 * localhost-loopback callback server. Both assumptions break on a remote
 * terminal: there's no browser to open, and the loopback URL Google would
 * redirect to is unreachable from the user's actual browser on another
 * machine. These pure helpers decide when to fall back to the RFC 8628
 * device-grant flow (no browser) and when the OS keychain is unavailable
 * (so a keychain-less token store must be used instead).
 *
 * Kept free of side effects (env + platform are injected) so the decision
 * logic is unit-testable without a real display / SSH session / keychain.
 */
export interface BrowserEnvProbe {
    /** A snapshot of the relevant environment variables (defaults to process.env). */
    env: NodeJS.ProcessEnv;
    /** The platform string (defaults to process.platform). */
    platform: NodeJS.Platform;
}
/**
 * A BORG_* toggle is "on" only when present and not one of the falsy
 * spellings. Mirrors how the rest of the client reads boolean env vars:
 * an unset var and the explicit "0"/"false"/"" spellings are all off.
 * Exported for the gh#673 launch-gate (BORG_SESSION) so every BORG_*
 * boolean reads through one convention.
 */
export declare function envToggleOn(value: string | undefined): boolean;
/**
 * Decide whether the current environment lacks a usable local browser, so
 * the loopback OAuth flow can't work and the device-grant flow should be
 * used instead.
 *
 * Decision order (first match wins):
 *  1. BORG_FORCE_BROWSER on  → false  (escape hatch: operator has an
 *     SSH-forwarded / X-forwarded browser and wants the loopback flow)
 *  2. BORG_NO_BROWSER on     → true   (explicit opt-in to device flow)
 *  3. SSH session            → true   (remote terminal — even on a Mac the
 *     browser that opens is on the *server*, unreachable to the user)
 *  4. container marker        → true  (headless by construction)
 *  5. Linux without any display (no DISPLAY, no WAYLAND_DISPLAY) → true
 *  6. otherwise              → false  (desktop macOS/Windows, or Linux with
 *     a display — the loopback flow works)
 *
 * The `--no-browser` / `--device` CLI flag is surfaced by the caller as
 * BORG_NO_BROWSER (or by passing an env with it set) so there's a single
 * decision funnel.
 */
export declare function isNoBrowserEnv(probe?: Partial<BrowserEnvProbe>): boolean;
/**
 * Returns true when the OS keychain can be written to and read from. The
 * round-trip is injectable so callers/tests can supply a deterministic
 * probe; in production the default probe touches the real keychain.
 *
 * Any thrown error from the probe (no Secret Service, locked keychain,
 * permission denial) is treated as "unavailable" — the caller then selects
 * the encrypted-file fallback store.
 */
export declare function isKeyringAvailable(roundTrip?: () => Promise<void>): Promise<boolean>;
//# sourceMappingURL=auth-env.d.ts.map