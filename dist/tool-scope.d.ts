/**
 * gh#899: role-scope the NATIVE MCP tool surface to cut the per-call tool tax
 * for simpler models. This is a token-surface UX / context optimization ONLY —
 * it carries ZERO authorization semantics. Server enforcement is USER/OWNER-
 * level (RLS + cube ownership), independent of which tool SCHEMAS are pre-loaded
 * at connect: a NON-OWNER is rejected regardless of role, and an OWNER's own
 * drone is NOT — so reaching a "management" tool via the dispatcher is correct
 * when the caller owns the cube, never a "worker is server-rejected" case. The
 * dispatcher bypasses NO server check that exists (identical CallTool path).
 * Never treat this filter as a security boundary.
 *
 * Deferred (filtered-out) tools are never lost — they remain reachable through
 * the always-present dispatcher (`borg_tool` / `borg_describe-tool`), so a
 * scoped role can never dead-end.
 */
/** Always-present escape hatch — reaches any borg tool regardless of scope. */
export declare const DISPATCHER_TOOLS: readonly ["borg_tool", "borg_describe-tool"];
/** Every role needs these; pre-loaded natively for all roles. */
export declare const UNIVERSAL_TOOLS: readonly ["borg_regen", "borg_log", "borg_read-log", "borg_roster", "borg_stream-status", "borg_whoami", "borg_ack", "borg_version", "borg_cube", "borg_role", "borg_role-rationale", "borg_assimilate", "borg_playbook", "borg_docs", "borg_tool", "borg_describe-tool"];
/** Cube/role/drone management — native for management seats, deferred for workers. */
export declare const MANAGEMENT_TOOLS: readonly ["borg_create-cube", "borg_update-cube", "borg_delete-cube", "borg_create-role", "borg_update-role", "borg_delete-role", "borg_patch-role-section", "borg_patch-taxonomy-class", "borg_reassign-drone", "borg_evict-drone", "borg_sync-roles", "borg_apply-template", "borg_list-cubes", "borg_list-drones", "borg_list-roles", "borg_list-templates", "borg_remove-decision"];
/**
 * Highest-stakes subset of the management set — filtered from a worker's native
 * surface for context economy only. NOT an auth list: server enforcement is
 * owner-level (RLS + cube ownership) and independent of this client-side filter
 * (a non-owner is rejected regardless of role; an owner's own drone is not).
 * Named here only to focus reviewer attention.
 */
export declare const AUTH_SENSITIVE_TOOLS: readonly ["borg_evict-drone", "borg_delete-cube", "borg_delete-role", "borg_reassign-drone"];
export interface RoleScope {
    /** The drone's role name, as persisted at assimilate. Absent → role unknown. */
    roleName?: string | null;
    roleClass?: 'queen' | 'worker' | null;
    isHumanSeat?: boolean | null;
}
/** Management seats (human-seat roles + queen-class) get the full surface. */
export declare function isManagementSeat(scope: RoleScope): boolean;
/**
 * Names to HIDE from the native surface for this scope. Empty (hide nothing)
 * when the role is unknown (no roleName — old cubes.json entry or pre-assimilate)
 * or the caller is a management seat. Only a known worker role defers the
 * management + billing sets. Fail-safe: anything not explicitly in a deferred
 * set stays native.
 */
export declare function deferredToolNames(scope: RoleScope | null): Set<string>;
/**
 * Filter a tool-definition array down to the native surface for this scope.
 * Tools whose name is in the deferred set are removed; everything else
 * (universal, dispatcher, unmapped) stays. The deferred tools remain reachable
 * via the dispatcher.
 */
export declare function filterToolsForRole<T extends {
    name: string;
}>(tools: T[], scope: RoleScope | null): T[];
//# sourceMappingURL=tool-scope.d.ts.map