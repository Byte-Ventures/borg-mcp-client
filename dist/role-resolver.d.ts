export interface Role {
    id: string;
    name: string;
    is_default: boolean;
    is_mandatory?: boolean;
    is_human_seat: boolean;
    role_class?: 'queen' | 'worker';
    default_model?: string | null;
}
export interface RoleOccupant {
    role_id: string;
    /** Server-derived advisory; absent remains occupied for rollout safety. */
    presumed_abandoned?: boolean;
}
/**
 * Build the advisory occupancy set used only by role-less assimilation.
 * Explicit role selection and server authorization do not consult it.
 */
export declare function occupiedRoleIdsForAutoRole(drones: readonly RoleOccupant[]): Set<string>;
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
export declare function roleSlug(raw: string): string;
/**
 * Case- and separator-insensitive lookup against the cube's roles.
 */
export declare function matchRoleByName(roles: Role[], query: string): Role | undefined;
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
export declare function pickDefaultRole(roles: Role[], opts: {
    isFirstDrone: boolean;
    occupiedRoleIds?: ReadonlySet<string>;
}): Role | undefined;
//# sourceMappingURL=role-resolver.d.ts.map