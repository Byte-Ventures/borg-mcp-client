const LAST_CONFIRMED = ' (last confirmed)';
let state = null;
function seatKey(active) {
    return `${active.cubeId}\0${active.droneId}`;
}
function initialState(active) {
    return {
        seatKey: seatKey(active),
        cubeName: { value: active.name, uncertain: false },
        droneLabel: { value: active.droneLabel, uncertain: false },
        roleName: { value: active.roleName ?? null, uncertain: false },
    };
}
function ensureState(active) {
    const key = seatKey(active);
    if (state === null || state.seatKey !== key) {
        state = initialState(active);
    }
    return state;
}
function confirmField(field, value) {
    if (value === undefined || value === null)
        return;
    field.value = value;
    field.uncertain = false;
}
function renderField(field) {
    if (field.value === null)
        return null;
    return field.uncertain ? `${field.value}${LAST_CONFIRMED}` : field.value;
}
/** Seed the invocation-local display source from the exact seat selected by #63. */
export function seedDisplayIdentity(active) {
    ensureState(active);
}
/** Apply server-authoritative fields and clear uncertainty only for those fields. */
export function confirmDisplayIdentity(active, identity) {
    const current = ensureState(active);
    confirmField(current.cubeName, identity.cubeName);
    confirmField(current.droneLabel, identity.droneLabel);
    confirmField(current.roleName, identity.roleName);
    return renderDisplayIdentity(active);
}
/** Mark the current seat identity as last-confirmed after an identity read fails. */
export function markDisplayIdentityReadFailed(active) {
    const current = ensureState(active);
    current.cubeName.uncertain = true;
    current.droneLabel.uncertain = true;
    if (current.roleName.value !== null)
        current.roleName.uncertain = true;
}
export function renderDisplayIdentity(active) {
    const current = ensureState(active);
    return {
        cubeName: renderField(current.cubeName),
        droneLabel: renderField(current.droneLabel),
        roleName: renderField(current.roleName),
    };
}
/** Synchronous view for console-prefix after initConsolePrefix seeds the seat. */
export function currentDisplayIdentity() {
    if (state === null)
        return null;
    return {
        cubeName: renderField(state.cubeName),
        droneLabel: renderField(state.droneLabel),
        roleName: renderField(state.roleName),
    };
}
export function identityFromRegen(result) {
    return {
        cubeName: result.cube?.name ?? undefined,
        droneLabel: result.drone?.label ?? undefined,
        roleName: result.role?.name ?? undefined,
    };
}
export function withRenderedRegenIdentity(result, identity) {
    return {
        ...result,
        cube: { ...result.cube, name: identity.cubeName },
        drone: { ...result.drone, label: identity.droneLabel },
        role: { ...result.role, name: identity.roleName },
    };
}
export function _resetDisplayIdentityForTests() {
    state = null;
}
//# sourceMappingURL=display-identity.js.map