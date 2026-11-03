/** Canonical MCP identifiers and the closed, temporary legacy alias set. */
export declare const MAIN_TOOL_NAMES: readonly ["borg_regen", "borg_assimilate", "borg_cube", "borg_role", "borg_version", "borg_playbook", "borg_docs", "borg_whoami", "borg_role_rationale", "borg_roster", "borg_stream_status", "borg_read_log", "borg_read_entry", "borg_ack", "borg_ack_status", "borg_decide", "borg_decisions", "borg_remove_decision", "borg_put_document", "borg_get_document", "borg_list_documents", "borg_remove_document", "borg_log", "borg_list_cubes", "borg_create_cube", "borg_update_cube", "borg_patch_taxonomy_class", "borg_delete_cube", "borg_create_role", "borg_update_role", "borg_patch_role_section", "borg_delete_role", "borg_reassign_drone", "borg_evict_drone", "borg_list_drones", "borg_list_roles", "borg_list_templates", "borg_apply_template", "borg_sync_roles", "borg_tool", "borg_describe_tool"];
export declare const REPRESENTATIVE_CANONICAL_TOOL_NAMES: readonly ["borg_representative_status", "borg_representative_send", "borg_representative_read", "borg_representative_deliver", "borg_representative_ack"];
export type CanonicalToolName = typeof MAIN_TOOL_NAMES[number] | typeof REPRESENTATIVE_CANONICAL_TOOL_NAMES[number];
export declare const LEGACY_TOOL_ALIASES: Readonly<{
    readonly 'borg_role-rationale': "borg_role_rationale";
    readonly 'borg_stream-status': "borg_stream_status";
    readonly 'borg_read-log': "borg_read_log";
    readonly 'borg_read-entry': "borg_read_entry";
    readonly 'borg_ack-status': "borg_ack_status";
    readonly 'borg_remove-decision': "borg_remove_decision";
    readonly 'borg_put-document': "borg_put_document";
    readonly 'borg_get-document': "borg_get_document";
    readonly 'borg_list-documents': "borg_list_documents";
    readonly 'borg_remove-document': "borg_remove_document";
    readonly 'borg_list-cubes': "borg_list_cubes";
    readonly 'borg_create-cube': "borg_create_cube";
    readonly 'borg_update-cube': "borg_update_cube";
    readonly 'borg_patch-taxonomy-class': "borg_patch_taxonomy_class";
    readonly 'borg_delete-cube': "borg_delete_cube";
    readonly 'borg_create-role': "borg_create_role";
    readonly 'borg_update-role': "borg_update_role";
    readonly 'borg_patch-role-section': "borg_patch_role_section";
    readonly 'borg_delete-role': "borg_delete_role";
    readonly 'borg_reassign-drone': "borg_reassign_drone";
    readonly 'borg_evict-drone': "borg_evict_drone";
    readonly 'borg_list-drones': "borg_list_drones";
    readonly 'borg_list-roles': "borg_list_roles";
    readonly 'borg_list-templates': "borg_list_templates";
    readonly 'borg_apply-template': "borg_apply_template";
    readonly 'borg_sync-roles': "borg_sync_roles";
    readonly 'borg_describe-tool': "borg_describe_tool";
    readonly 'borg_representative-status': "borg_representative_status";
    readonly 'borg_representative-send': "borg_representative_send";
    readonly 'borg_representative-read': "borg_representative_read";
    readonly 'borg_representative-deliver': "borg_representative_deliver";
    readonly 'borg_representative-ack': "borg_representative_ack";
}>;
/** Unknown names pass through to the receiving facade's normal rejection. */
export declare function canonicalToolName(name: string): string;
export declare function toolNameSpellings(name: string): string[];
//# sourceMappingURL=tool-names.d.ts.map