# MCP tool-name migration

Borg MCP tool catalogs now use underscores throughout: `borg_read_log`,
`borg_describe_tool`, and `borg_representative_send`, for example. The operation,
arguments, result schema, server authorization and protocol version (14) stay
unchanged. This catalog change requires a client major release.

## Before upgrading

1. Keep each legacy rule and add its canonical counterpart immediately beside it
   in tool-specific allow, ask and deny rules, enabled/disabled tool lists, agent
   policies and managed policies. Both entries must have the same action and
   resource scope. Keep their position relative to other rules. Generic patterns
   that match both spellings can stay. Do not replace a legacy restriction with
   a canonical-only restriction while aliases remain callable.
2. Upgrade the client and restart or reconnect its MCP servers. Force tool
   rediscovery in the host so cached declarations use the new catalog.
3. Update scripts and operator-maintained roles when convenient. Reinstall the
   bundled Hermes plugin so its calls use the canonical representative names.
   Borg does not rewrite saved roles, messages, logs or historical release documents.

For the default server name `borg`, host policy identifiers include:

| Host | Old selector | Canonical selector |
| --- | --- | --- |
| Claude Code | `mcp__borg__borg_read-log` | `mcp__borg__borg_read_log` |
| Codex per-tool approval | `borg:read-log` | `borg:read_log` |
| Codex enabled/disabled tools | `borg_read-log` | `borg_read_log` |
| OpenCode 1 or 2 | `borg_borg_read-log` | `borg_borg_read_log` |

The table shows each pair: retain both selectors with identical restrictions.
Use the identifiers your installed host reports. A custom MCP server name changes
its host prefix. Review globs against the complete alias table below; replacing a
glob without checking its match set can broaden or narrow a policy.

Borg launches check native effective configuration before applying coordination
approval overrides. Claude uses the native `get_settings` control request,
including per-source managed settings; a CLI without that capability is refused.
Codex uses its native effective configuration and selected profile. OpenCode 1
uses its effective config, and OpenCode 2 checks native config sources, effective
agent rules and session rules before updating session permissions. An exact selector without an adjacent equivalent counterpart, or a glob whose
match changes between spellings, stops launch with migration instructions.
Unavailable effective configuration also stops launch. The approval opt-out flag
`--no-borg-approval-override` does not bypass migration checks. Borg does not edit
these settings or automatically translate policy globs. Its own launch-only
approval additions cover canonical and legacy spellings equally.

These checks inspect the policies the installed host exposes at launch. Generic
MCP hosts, including hosts of the representative facade, must migrate their own
policies before reconnecting. Administrators must also update remote/managed
policy sources; a future policy change is outside the launch snapshot. The
`borg_tool` dispatcher retains its existing transitive scope: a host approval for
it covers the operation it dispatches. Tool-name migration does not turn it into
a host per-operation permission boundary.

## Old tool references

Only canonical names appear in tool discovery. A closed set of legacy names is
accepted temporarily inside Borg and reaches exactly the same handler and
validation. The main and representative MCP surfaces remain separate. An alias
does not bypass server grants, identity checks or representative binding checks.

A strict host may reject an unlisted legacy name before Borg receives the call.
Rediscover its canonical name. In a main Borg session, another supported path is
`borg_tool` with a quoted legacy `name`, for example:

```json
{"name":"borg_read-log","arguments":{"unread_only":true}}
```

OpenCode 2 Code Mode uses generated paths. Discover them, then use the reported
underscore name, such as `tools.borg.borg_read_log(...)`. A legacy name containing
`-` requires bracket access if a host exposes it; dot syntax parses subtraction.
Await dependent calls in order, such as role, playbook, then unread log. Continue
to use generated declarations when a custom namespace needs bracket syntax.

Aliases remain for this major release; their removal requires a later major
release. No database migration is needed.

## Complete legacy alias table

| Legacy raw MCP name | Canonical raw MCP name |
| --- | --- |
| `borg_role-rationale` | `borg_role_rationale` |
| `borg_stream-status` | `borg_stream_status` |
| `borg_read-log` | `borg_read_log` |
| `borg_read-entry` | `borg_read_entry` |
| `borg_ack-status` | `borg_ack_status` |
| `borg_remove-decision` | `borg_remove_decision` |
| `borg_put-document` | `borg_put_document` |
| `borg_get-document` | `borg_get_document` |
| `borg_list-documents` | `borg_list_documents` |
| `borg_remove-document` | `borg_remove_document` |
| `borg_list-cubes` | `borg_list_cubes` |
| `borg_create-cube` | `borg_create_cube` |
| `borg_update-cube` | `borg_update_cube` |
| `borg_patch-taxonomy-class` | `borg_patch_taxonomy_class` |
| `borg_delete-cube` | `borg_delete_cube` |
| `borg_create-role` | `borg_create_role` |
| `borg_update-role` | `borg_update_role` |
| `borg_patch-role-section` | `borg_patch_role_section` |
| `borg_delete-role` | `borg_delete_role` |
| `borg_reassign-drone` | `borg_reassign_drone` |
| `borg_evict-drone` | `borg_evict_drone` |
| `borg_list-drones` | `borg_list_drones` |
| `borg_list-roles` | `borg_list_roles` |
| `borg_list-templates` | `borg_list_templates` |
| `borg_apply-template` | `borg_apply_template` |
| `borg_sync-roles` | `borg_sync_roles` |
| `borg_describe-tool` | `borg_describe_tool` |
| `borg_representative-status` | `borg_representative_status` |
| `borg_representative-send` | `borg_representative_send` |
| `borg_representative-read` | `borg_representative_read` |
| `borg_representative-deliver` | `borg_representative_deliver` |
| `borg_representative-ack` | `borg_representative_ack` |
