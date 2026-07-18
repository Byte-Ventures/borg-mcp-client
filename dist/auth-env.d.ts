/**
 * Local environment / capability primitives.
 *
 * These pure helpers are kept free of side effects (env + platform are
 * injected) so the decision logic is unit-testable without a real keychain.
 */
/**
 * A BORG_* toggle is "on" only when present and not one of the falsy
 * spellings. Mirrors how the rest of the client reads boolean env vars:
 * an unset var and the explicit "0"/"false"/"" spellings are all off.
 * Used by the gh#673 launch-gate (BORG_SESSION) so every BORG_* boolean
 * reads through one convention.
 */
export declare function envToggleOn(value: string | undefined): boolean;
/**
 * Returns true when the OS keychain can be written to and read from. The
 * round-trip is injectable so callers/tests can supply a deterministic
 * probe; in production the default probe touches the real keychain.
 *
 * Any thrown error from the probe (no Secret Service, locked keychain,
 * permission denial) is treated as "unavailable" — local server credentials
 * then fail closed (there is no obfuscation-grade file fallback).
 */
export declare function isKeyringAvailable(roundTrip?: () => Promise<void>): Promise<boolean>;
//# sourceMappingURL=auth-env.d.ts.map