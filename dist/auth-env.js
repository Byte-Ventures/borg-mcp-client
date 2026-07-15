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
import { AsyncEntry } from '@napi-rs/keyring';
/**
 * A BORG_* toggle is "on" only when present and not one of the falsy
 * spellings. Mirrors how the rest of the client reads boolean env vars:
 * an unset var and the explicit "0"/"false"/"" spellings are all off.
 * Exported for the gh#673 launch-gate (BORG_SESSION) so every BORG_*
 * boolean reads through one convention.
 */
export function envToggleOn(value) {
    if (value === undefined)
        return false;
    const v = value.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}
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
export function isNoBrowserEnv(probe) {
    const env = probe?.env ?? process.env;
    const platform = probe?.platform ?? process.platform;
    // 1. Explicit force-browser escape hatch wins over every no-browser signal.
    if (envToggleOn(env.BORG_FORCE_BROWSER))
        return false;
    // 2. Explicit opt-in to the no-browser/device flow.
    if (envToggleOn(env.BORG_NO_BROWSER))
        return true;
    // 3. SSH session — the terminal is remote, so any browser we open is on
    //    the far end and the loopback redirect is unreachable to the user.
    if (env.SSH_TTY || env.SSH_CONNECTION || env.SSH_CLIENT)
        return true;
    // 4. Container (systemd/Docker/podman set `container=`); headless by build.
    if (env.container)
        return true;
    // 5. Headless Linux: no X11 and no Wayland display = no browser to open.
    if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
        return true;
    // 6. Desktop (macOS/Windows) or Linux-with-display: loopback flow is fine.
    return false;
}
/**
 * The probe round-trip used to decide whether the OS keychain is usable.
 * Performs a real set/get/delete against a throwaway account so a missing
 * Secret Service (headless Linux), a locked keychain, or any other backend
 * failure surfaces as a thrown error rather than a later mid-auth crash.
 */
async function defaultKeyringRoundTrip() {
    const PROBE_SERVICE = 'borg-mcp';
    const PROBE_ACCOUNT = '__borg_keyring_probe__';
    const entry = new AsyncEntry(PROBE_SERVICE, PROBE_ACCOUNT);
    await entry.setPassword('probe');
    await entry.getPassword();
    // Best-effort cleanup; a failed delete still proves the keychain works.
    try {
        await entry.deletePassword();
    }
    catch {
        /* leave the probe entry — its presence is harmless */
    }
}
/**
 * Returns true when the OS keychain can be written to and read from. The
 * round-trip is injectable so callers/tests can supply a deterministic
 * probe; in production the default probe touches the real keychain.
 *
 * Any thrown error from the probe (no Secret Service, locked keychain,
 * permission denial) is treated as "unavailable" — the caller then selects
 * the encrypted-file fallback store.
 */
export async function isKeyringAvailable(roundTrip = defaultKeyringRoundTrip) {
    try {
        await roundTrip();
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=auth-env.js.map