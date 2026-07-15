/**
 * Sprint 6 / gh#153 — pure render function for `borg_list-roles` MCP tool.
 *
 * Extracted from the inline `case 'borg_list-roles'` handler in
 * `index.ts` per drone-3's QA-FAIL 2026-05-18T13:27:53Z so the render
 * logic is unit-testable without exercising the full MCP tool dispatch
 * stack. The handler simply calls `renderRoleList(roles, cubeId)` and
 * returns its output.
 */
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
export function renderRoleList(roles, cubeId) {
    if (!roles.length) {
        return 'No roles in this cube yet.';
    }
    const lines = roles.map((r) => {
        const tags = [
            r.role_class === 'queen' ? 'Queen' : null,
            r.is_human_seat ? 'human-seat' : null,
            r.is_default ? 'default' : null,
            r.is_mandatory ? 'mandatory' : null,
            r.can_broadcast ? 'can-broadcast' : null,
            r.receives_all_direct ? 'receives-all-direct' : null,
        ].filter(Boolean).join(', ');
        const tagSuffix = tags ? ` (${tags})` : '';
        const desc = r.short_description || '_(no description)_';
        return `- **${r.name}**${tagSuffix} \`${r.id}\` — ${desc}`;
    });
    return `Roles in cube ${cubeId} (${roles.length}):\n\n${lines.join('\n')}\n\nUse the role IDs above with \`borg_reassign-drone\` to change a drone's role.`;
}
//# sourceMappingURL=list-roles-render.js.map