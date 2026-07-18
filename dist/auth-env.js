/**
 * Local environment / capability primitives.
 *
 * Pure helpers kept free of side effects (env is injected) so the decision logic
 * is unit-testable. (The OS-keychain availability probe was removed with the
 * Queen rescope — credentials now rest in the 0600 file store, so there is no
 * keychain to probe.)
 */
/**
 * A BORG_* toggle is "on" only when present and not one of the falsy
 * spellings. Mirrors how the rest of the client reads boolean env vars:
 * an unset var and the explicit "0"/"false"/"" spellings are all off.
 * Used by the gh#673 launch-gate (BORG_SESSION) so every BORG_* boolean
 * reads through one convention.
 */
export function envToggleOn(value) {
    if (value === undefined)
        return false;
    const v = value.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}
//# sourceMappingURL=auth-env.js.map