/**
 * Sprint 6 / gh#153 — pure render function for `borg_list-roles` MCP tool.
 *
 * Extracted from the inline `case 'borg_list-roles'` handler in
 * `index.ts` per drone-3's QA-FAIL 2026-05-18T13:27:53Z so the render
 * logic is unit-testable without exercising the full MCP tool dispatch
 * stack. The handler simply calls `renderRoleList(roles, cubeId)` and
 * returns its output.
 */
export interface RoleForRender {
    id: string;
    name: string;
    short_description?: string;
    is_default?: boolean;
    is_mandatory?: boolean;
    is_human_seat?: boolean;
    can_broadcast?: boolean;
    receives_all_direct?: boolean;
    role_class?: string;
}
/**
 * Render the role registry for a cube as a markdown list with role IDs
 * exposed for use with `borg_reassign-drone`. Returns the empty-roles
 * placeholder when the input array is empty.
 *
 * Each role line shape:
 *   - **<name>**(<tags>) `<uuid>` — <description>
 *
 * Tags collected in order: Queen, human-seat, default, mandatory, can-broadcast,
 * receives-all-direct. Joined with `, `; suffix omitted entirely when no tags apply.
 */
export declare function renderRoleList(roles: RoleForRender[], cubeId: string): string;
//# sourceMappingURL=list-roles-render.d.ts.map