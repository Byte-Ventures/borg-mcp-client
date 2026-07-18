/**
 * Local environment / capability primitives.
 *
 * These pure helpers are kept free of side effects (env + platform are
 * injected) so the decision logic is unit-testable without a real keychain.
 */

import { AsyncEntry } from '@napi-rs/keyring';

/**
 * A BORG_* toggle is "on" only when present and not one of the falsy
 * spellings. Mirrors how the rest of the client reads boolean env vars:
 * an unset var and the explicit "0"/"false"/"" spellings are all off.
 * Used by the gh#673 launch-gate (BORG_SESSION) so every BORG_* boolean
 * reads through one convention.
 */
export function envToggleOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/**
 * The probe round-trip used to decide whether the OS keychain is usable.
 * Performs a real set/get/delete against a throwaway account so a missing
 * Secret Service (headless Linux), a locked keychain, or any other backend
 * failure surfaces as a thrown error rather than a later mid-operation crash.
 */
async function defaultKeyringRoundTrip(): Promise<void> {
  const PROBE_SERVICE = 'borg-mcp';
  const PROBE_ACCOUNT = '__borg_keyring_probe__';
  const entry = new AsyncEntry(PROBE_SERVICE, PROBE_ACCOUNT);
  await entry.setPassword('probe');
  await entry.getPassword();
  // Best-effort cleanup; a failed delete still proves the keychain works.
  try {
    await entry.deletePassword();
  } catch {
    /* leave the probe entry — its presence is harmless */
  }
}

/**
 * Returns true when the OS keychain can be written to and read from. The
 * round-trip is injectable so callers/tests can supply a deterministic
 * probe; in production the default probe touches the real keychain.
 *
 * Any thrown error from the probe (no Secret Service, locked keychain,
 * permission denial) is treated as "unavailable" — local server credentials
 * then fail closed (there is no obfuscation-grade file fallback).
 */
export async function isKeyringAvailable(
  roundTrip: () => Promise<void> = defaultKeyringRoundTrip
): Promise<boolean> {
  try {
    await roundTrip();
    return true;
  } catch {
    return false;
  }
}
