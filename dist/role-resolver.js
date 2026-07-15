/**
 * Build the advisory occupancy set used only by role-less assimilation.
 * Explicit role selection and server authorization do not consult it.
 */
export function occupiedRoleIdsForAutoRole(drones) {
    return new Set(drones
        .filter((drone) => drone.presumed_abandoned !== true)
        .map((drone) => drone.role_id));
}
/**
 * Normalize a role-name argument or stored name into a slug used for
 * both worktree-path construction and role lookup. Single source of
 * truth so the path and the matched role always agree.
 *
 * Path-safe: strips characters outside `[a-z0-9-]` after the
 * underscore/whitespace collapse. The no-arg path bypasses
 * validateName (the matched role's name comes from the DB, which
 * has no charset constraint on role names — CreateRoleSchema is
 * `min(1).max(64)` only), so the safety has to live here.
 */
export function roleSlug(raw) {
    return raw.toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}
/**
 * Case- and separator-insensitive lookup against the cube's roles.
 */
export function matchRoleByName(roles, query) {
    const slug = roleSlug(query);
    return roles.find((r) => roleSlug(r.name) === slug);
}
/**
 * Role picker for the no-arg `borg assimilate` case:
 *   - First drone in cube + a human-seat role exists → that role.
 *   - Otherwise → the first UNOCCUPIED mandatory non-queen role in list
 *     order. This includes a mandatory human-seat role such as Coordinator;
 *     its active seat remains the occupancy guard against a double-fill.
 *   - Otherwise → the first UNOCCUPIED eligible worker role in list order
 *     (eligible = not queen-class, not human-seat). The default role is an
 *     equal candidate in this pass.
 *   - If every eligible worker role is occupied → the is_default role.
 *   - Neither available → undefined (caller errors out).
 *
 * `occupiedRoleIds` is the set of role_ids that still hold a live-enough active
 * seat for automatic selection. Omitted → treated as empty (all roles
 * unoccupied), which degrades to "first eligible worker role, else default".
 */
export function pickDefaultRole(roles, opts) {
    if (opts.isFirstDrone) {
        const humanSeat = roles.find((r) => r.is_human_seat);
        if (humanSeat)
            return humanSeat;
    }
    const occupied = opts.occupiedRoleIds ?? new Set();
    const mandatory = roles.filter((r) => r.is_mandatory === true && r.role_class !== 'queen');
    const eligible = roles.filter((r) => r.role_class !== 'queen' && !r.is_human_seat);
    return mandatory.find((r) => !occupied.has(r.id))
        ?? eligible.find((r) => !occupied.has(r.id))
        ?? roles.find((r) => r.is_default);
}
//# sourceMappingURL=role-resolver.js.map