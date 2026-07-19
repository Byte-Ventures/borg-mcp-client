export const TOOL_MANIFEST = [
    {
        name: 'borg_regen',
        description: "Refresh your context as a Drone. Returns the active cube's directive, " +
            "your role's detailed playbook, the drone roster, and recent activity log entries — " +
            'everything you need to be oriented. Call on session start, and again before each new ' +
            'task to stay in sync with the cube. Returns "not connected" if no active cube; use ' +
            'borg_assimilate first in that case. ' +
            'Optional `since` (entry-id UUID or ISO-8601 timestamp) trims the recent-log section ' +
            'to entries strictly after the anchor — pass your last-seen entry id to skip ' +
            'already-processed history on each refresh. If you know the current session model, pass ' +
            'optional `model` to self-report it as advisory metadata; unrecognized model strings are accepted.',
        inputSchema: {
            type: 'object',
            properties: {
                since: {
                    type: 'string',
                    description: 'Optional cursor. Either an activity_log entry id (UUID; server resolves to (created_at, id) tuple) OR an ISO-8601 timestamp. When provided, the recent-log section returns entries strictly after that anchor. Non-existent UUID falls back to default recent window.',
                },
                mode: {
                    type: 'string',
                    enum: ['full', 'lite'],
                    description: 'Optional output mode. Use full at session start and after context compaction. Lite omits unchanged role playbook/directive/boilerplate while always showing dynamic safety information and recent activity.',
                },
                model: {
                    type: 'string',
                    maxLength: 256,
                    description: 'Optional advisory self-report of the model running this agent session. Use the model identifier you know from session context; the server does not infer or validate it against an allowlist.',
                },
            },
            required: [],
        },
    },
    {
        name: 'borg_assimilate',
        description: "RE-ATTACH this session to the drone seat already saved for this worktree (gh#780: " +
            "this tool never creates seats). Provide the cube's name; on a match it returns the " +
            "cube directive, your role's instructions, and recent activity for the EXISTING seat. " +
            'To create a seat or switch cubes, run `borg assimilate` in a terminal instead.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_name: {
                    type: 'string',
                    description: 'The cube to connect to',
                },
            },
            required: ['cube_name'],
        },
    },
    {
        name: 'borg_cube',
        description: "Read the active Cube's directive and the registry of all roles in it " +
            "(each role's name + short description). Use to remind yourself of cube-wide context.",
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'borg_role',
        description: "Read a role's detailed playbook. With no arguments, returns YOUR " +
            'assigned role. Pass `role` (a role name, case-insensitive, or role id) ' +
            'to read any other role in the cube — role playbooks are cube-internal ' +
            'shared context, readable by any drone.',
        inputSchema: {
            type: 'object',
            properties: {
                role: {
                    type: 'string',
                    description: 'Optional. A role name (case-insensitive) or role id. Omit to read your own role.',
                },
            },
            required: [],
        },
    },
    {
        name: 'borg_version',
        description: 'Returns the installed borgmcp client version. Use to verify which version is running in this MCP session.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'borg_playbook',
        description: 'Load the full operating-playbook chapter — the detailed disciplines, rationale, and examples behind the rule-spine in your regen (verification discipline v1/v2/v3, concrete source-of-truth surfaces, four-surface propagation). This detail is kept OUT of the regen bootstrap to keep it light; fetch it ONCE per session when doing review/verify-class work. Static text — do NOT re-fetch on every wake.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'borg_docs',
        description: 'Look up the Borg MCP documentation. Call this when the user asks how borgmcp works, or any feature / usage / setup / concept / tool question. Returns the docs index — each section\'s repository documentation URL + a one-line summary. Pass `topic` (e.g. "worktree", "roles", "codex") to get the best-matching section(s) instead of the full index. Then WebFetch the returned URL to read the page — borg_docs returns the index only, it does not fetch the page for you.',
        inputSchema: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    description: 'Optional search topic — returns the best-matching docs section(s) instead of the full index.',
                },
            },
            required: [],
        },
    },
    {
        name: 'borg_whoami',
        description: 'Returns your identity in the current cube: cube name, drone label, and role name. Use to confirm which cube/role/drone you are.',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'borg_role-rationale',
        description: "Fetch an on-demand rationale/case-study section for a role playbook. " +
            "Pass a role name/id and a plain-label section key to read the rationale without expanding every regen.",
        inputSchema: {
            type: 'object',
            properties: {
                role: {
                    type: 'string',
                    description: 'Role name or role id to fetch rationale for, e.g. Builder.',
                },
                section: {
                    type: 'string',
                    description: 'Plain-label role section key, e.g. Workflow rationale.',
                },
            },
            required: ['role', 'section'],
        },
    },
    {
        name: 'borg_roster',
        description: "List all currently connected drones in your cube, with each drone's label, role, and last-seen time. Optional `since` argument adds a sender-side liveness column — pass either an activity_log entry id (e.g., from a dispatch you posted) or an ISO-8601 timestamp; each drone is marked `awake` if they've posted a log entry after that point, otherwise `stale-since-X`. Useful for confirming a dispatch reached its named recipients (catches the silent-wake-path-failure class where SSE delivered but the drone's /loop never woke).",
        inputSchema: {
            type: 'object',
            properties: {
                since: {
                    type: 'string',
                    description: 'Optional liveness reference point. Either an activity_log entry id (UUID; server resolves to its created_at) OR an ISO-8601 timestamp. When provided, each drone in the output is tagged awake/stale relative to that point.',
                },
            },
            required: [],
        },
    },
    {
        name: 'borg_stream-status',
        description: "Diagnostic probe of the local SSE log-stream consumer: returns `connected`, `lastContentEventAt`, `lastWireActivityAt`, `lastHeartbeatAt`, `lastPersistedEventId`, `reconnectAttempts`, plus a wake-path check that flags if SSE is attached but no inbox-Monitor is watching the file (the silent failure where `/loop` never wakes on incoming entries). Read-only in-process state; does NOT re-open the stream. Use when troubleshooting wake-ups or verifying the stream is alive.",
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'borg_read-log',
        description: "Read entries from the cube's activity log. Each entry is tagged " +
            "with the drone that wrote it and that drone's role. For wake triage, prefer " +
            '`unread_only=true` with a modest limit and drain until `has_more=false`; ' +
            'this reads oldest-unread-first from your server cursor and ' +
            'advances the watermark so bursts are not skipped. Optional `since` is a strict-after ' +
            'cursor for explicit bounded reads only; do not use it with the same timestamp as a ' +
            'notification preview because it can skip the boundary entry.',
        inputSchema: {
            type: 'object',
            properties: {
                since: {
                    type: 'string',
                    description: 'Optional strict-after cursor for explicit bounded reads. Either an activity_log entry id (UUID; server resolves to (created_at, id) tuple for deterministic tie-break) OR an ISO-8601 timestamp. Do not use for routine wake triage; prefer unread_only.',
                },
                limit: {
                    type: 'number',
                    description: 'max entries to return (1-500)',
                },
                unread_only: {
                    type: 'boolean',
                    description: 'When true, read only entries posted after this drone last called read-log, oldest-unread-first. Server advances the watermark to the newest returned entry on every call; if has_more=true, call again until has_more=false.',
                },
            },
        },
    },
    {
        name: 'borg_ack',
        description: 'Mark a log entry as explicitly acknowledged (kind="ack", default), or claim advisory ownership of a review gate before starting (kind="claim"). Recorded as a queryable DB flag (activity_log_acks) keyed on (entry_id, drone_id, kind); idempotent — repeated calls are no-ops. ack = receipt of a routed signal (replaces posting `ACK: <dispatch-id>`); claim = announce you are taking a REVIEW-READY so peers skip it (advisory only — merge eligibility stays keyed on REVIEW-APPROVED, never on a claim).',
        inputSchema: {
            type: 'object',
            required: ['entry_id'],
            properties: {
                entry_id: {
                    type: 'string',
                    description: 'UUID of the log entry to acknowledge.',
                },
                kind: {
                    type: 'string',
                    enum: ['ack', 'claim'],
                    description: 'Coordination kind. "ack" (default) = receipt. "claim" = advisory ownership of a review gate on a REVIEW-READY entry (wakes the gate audience; renders stale if you go silent past the wake-path SLA).',
                },
            },
        },
    },
    {
        name: 'borg_decide',
        description: 'Record a RATIFIED cube decision in the durable decision registry (gh#740) so drones cite it by topic instead of restating from memory. SEAT-HOLDER ONLY (Coordinator/Queen) — recording IS the ratification act; a decision is not ratified until it is in the registry. Topic-keyed: recording a new decision on an existing topic supersedes the prior (one active per topic). Surfaces in borg_regen + borg_decisions.',
        inputSchema: {
            type: 'object',
            required: ['topic', 'decision'],
            properties: {
                topic: {
                    type: 'string',
                    description: 'Stable topic key for cite-by-topic + supersession (e.g. "pricing-model"). Max 120 chars.',
                },
                decision: {
                    type: 'string',
                    description: 'The ratified decision text. Max 2000 chars.',
                },
                rationale: {
                    type: 'string',
                    description: 'Optional why. Max 2000 chars.',
                },
            },
        },
    },
    {
        name: 'borg_decisions',
        description: 'List the active ratified decisions for the cube (gh#740) — the source of truth to CITE instead of restating a decision from memory. Any member may read. Pass `topic` to fetch one topic\'s active decision; omit for all active decisions.',
        inputSchema: {
            type: 'object',
            properties: {
                topic: {
                    type: 'string',
                    description: 'Optional topic key to fetch that topic\'s active decision.',
                },
            },
        },
    },
    {
        name: 'borg_remove-decision',
        description: 'Remove one active ratified decision from the cube registry by topic or decision id. SEAT-HOLDER ONLY (Coordinator/Queen). The decision stops appearing in borg_decisions and borg_regen while its audit record is retained.',
        inputSchema: {
            type: 'object',
            oneOf: [{ required: ['topic'] }, { required: ['decision_id'] }],
            properties: {
                topic: {
                    type: 'string',
                    description: 'Topic of the active decision to remove. Provide exactly one selector.',
                },
                decision_id: {
                    type: 'string',
                    format: 'uuid',
                    description: 'Id of the active decision to remove. Provide exactly one selector.',
                },
            },
        },
    },
    {
        name: 'borg_log',
        description: 'Append a message to the cube\'s activity log. By default entries broadcast to all drones. When a cube declares a message taxonomy, borg_log applies class-based smart defaults: prefix-matched directed classes route to their default recipients unless you pass `to:`, `class:`, or explicit visibility. Pass `to: [...]` to direct by exact drone label, drone id, the 8-hex short-uuid (the `id:` token shown in roster/read-log — a drone_id prefix that is STABLE across label renumber), role name, or role slug.',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The log message (max 10KB).' },
                to: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional direct-message recipients by exact drone label, drone id, the 8-hex short-uuid (`id:` token from roster/read-log; stable across label renumber), role name, or role slug (resolves to all drones in that role). Omit to let class-based routing or broadcast defaults apply.',
                },
                class: {
                    type: 'string',
                    description: 'Optional declared message class. Overrides prefix auto-classification when the cube declares a message taxonomy.',
                },
                visibility: {
                    type: 'string',
                    enum: ['broadcast', 'direct'],
                    description: 'Optional explicit visibility. Overrides class-based routing defaults.',
                },
            },
            required: ['message'],
        },
    },
    {
        name: 'borg_list-cubes',
        description: 'List every cube owned by this user. Returns id, name, cube_directive, and timestamps for each. Useful before assimilate to see what\'s available, or as a starting point for any management action.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'borg_create-cube',
        description: 'Create a new cube. The server seeds a default "Drone" role atomically so the cube is assimilatable immediately. ' +
            'Pass an optional `template` name to apply a richer role set instead (see borg_list-templates / borg_apply-template).',
        inputSchema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Cube name (lowercase letters, digits, hyphens; max 64 chars).',
                    pattern: '^[a-z0-9-]+$',
                    maxLength: 64,
                },
                cube_directive: { type: 'string', description: 'Markdown text every drone in this cube will see in regen. Anything project-specific.' },
                template: {
                    type: 'string',
                    description: 'Optional template name to apply after cube creation (e.g. "software-dev"). Roles are merged by name; the default Drone role gets overwritten by the template if a same-named role is in the template.',
                },
            },
            required: ['name', 'cube_directive'],
        },
    },
    {
        name: 'borg_update-cube',
        description: 'Update a cube\'s name, cube_directive, and/or message_taxonomy. Pass only what changes.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube to update.' },
                name: {
                    type: 'string',
                    description: 'New name (optional). Lowercase letters, digits, hyphens; max 64 chars.',
                    pattern: '^[a-z0-9-]+$',
                    maxLength: 64,
                },
                cube_directive: { type: 'string', description: 'New cube directive markdown (optional).' },
                message_taxonomy: {
                    type: 'array',
                    description: 'New message-class taxonomy (optional). REPLACES the whole taxonomy; the worker re-validates the full array (non-overlapping prefixes, unique class names, directed classes need default_to). Pass [] to clear. To change ONE class without resending the whole array, use borg_patch-taxonomy-class instead. In default_to, pass @human-seat to route to drones in the cube human-seat role(s); literal role names/slugs/labels still work. Optional lifecycle tags mark dispatch/completion classes for stuck-dispatch detection.',
                    items: {
                        type: 'object',
                        properties: {
                            class: { type: 'string', description: 'Unique class name.' },
                            prefixes: { type: 'array', items: { type: 'string' }, description: 'Message prefixes routed by this class.' },
                            routing: { type: 'string', enum: ['broadcast', 'directed'], description: 'Routing mode.' },
                            default_to: { type: 'array', items: { type: 'string' }, description: 'Default recipients (role name/slug/label, or @human-seat) for a directed class.' },
                            lifecycle: { type: 'string', enum: ['dispatch', 'completion'], description: 'Optional lifecycle marker for stuck-dispatch detection.' },
                        },
                    },
                },
            },
            required: ['cube_id'],
        },
    },
    {
        name: 'borg_patch-taxonomy-class',
        description: "Patch ONE message-class in a cube's message_taxonomy without resending the whole taxonomy (avoids clobbering). action=add|replace|remove (replace/remove match name case-insensitively). The full taxonomy is re-validated after the patch (non-overlapping prefixes, unique names, directed classes need default_to) — a patch that breaks a rule against an untouched class is rejected. In default_to, @human-seat routes to the cube's human-seat role(s); literal names/slugs/labels also work. Optional lifecycle tags mark dispatch/completion classes for stuck-dispatch detection.",
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube to patch.' },
                action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add / replace / remove a single class.' },
                class_def: {
                    type: 'object',
                    description: 'The class definition (for add/replace). Shape: { class, prefixes?, routing: "broadcast"|"directed", default_to?, lifecycle? }.',
                    properties: {
                        class: { type: 'string', description: 'Unique class name.' },
                        prefixes: { type: 'array', items: { type: 'string' }, description: 'Message prefixes routed by this class.' },
                        routing: { type: 'string', enum: ['broadcast', 'directed'], description: 'Routing mode.' },
                        default_to: { type: 'array', items: { type: 'string' }, description: 'Default recipients (required for directed classes): role name/slug/label, or @human-seat.' },
                        lifecycle: { type: 'string', enum: ['dispatch', 'completion'], description: 'Optional lifecycle marker for stuck-dispatch detection.' },
                    },
                    required: ['class', 'routing'],
                },
                class: { type: 'string', description: 'For remove only: the name of the class to drop (case-insensitive).' },
            },
            required: ['cube_id', 'action'],
        },
    },
    {
        name: 'borg_delete-cube',
        description: 'Delete a cube and all its roles, drones, and log entries. Irreversible — confirm with the user before invoking unless the cube is clearly disposable.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube to delete.' },
            },
            required: ['cube_id'],
        },
    },
    {
        name: 'borg_create-role',
        description: 'Create a role inside a cube. The detailed_description is the role\'s playbook — only drones assigned to this role see it. Setting is_default=true demotes any existing default; a cube has exactly one default role at a time.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube this role belongs to.' },
                name: { type: 'string', description: 'Role name (e.g. "Builder", "Reviewer").' },
                short_description: { type: 'string', description: 'One-line summary, shown to every drone in the cube.' },
                detailed_description: { type: 'string', description: 'Full playbook for drones in this role — workflow, conventions, log signals to post.' },
                is_default: { type: 'boolean', description: 'If true, new drones assimilating into this cube are assigned this role. Demotes the previous default.' },
                is_mandatory: { type: 'boolean', description: 'If true, role-less assimilate fills this unoccupied non-queen role before ordinary worker roles. A mandatory human-seat role is therefore selected first until occupied.' },
                is_human_seat: { type: 'boolean', description: 'If true, this role represents the cube\'s human-occupied seat (where the human Queen sits directly). The class-hierarchy guard in reassign-drone allows promotion FROM a human-seat role TO the platform Queen role; promotion from non-human-seat roles is rejected.' },
                can_broadcast: { type: 'boolean', description: 'If true, drones in this role may post broadcast log entries when strict broadcast gating is enabled.' },
                receives_all_direct: { type: 'boolean', description: 'If true, drones in this role can see direct log entries as observer/audit recipients.' },
            },
            required: ['cube_id', 'name', 'short_description', 'detailed_description'],
        },
    },
    {
        name: 'borg_update-role',
        description: 'Update a role. Pass only the fields that change. Promoting to is_default demotes the previous default in the same cube.',
        inputSchema: {
            type: 'object',
            properties: {
                role_id: { type: 'string', description: 'UUID of the role to update.' },
                name: { type: 'string', description: 'New role name (optional).' },
                short_description: { type: 'string', description: 'New short description (optional).' },
                detailed_description: { type: 'string', description: 'New detailed playbook (optional).' },
                is_default: { type: 'boolean', description: 'Set true to make this the cube\'s default role (optional).' },
                is_mandatory: { type: 'boolean', description: 'Set true/false to prioritize this unoccupied non-queen role during role-less assimilate.' },
                is_human_seat: { type: 'boolean', description: 'Set true/false to mark/unmark this as the cube\'s human-occupied seat (the elevation source for the platform Queen role).' },
                can_broadcast: { type: 'boolean', description: 'Set true/false to allow or deny broadcast log entries when strict broadcast gating is enabled.' },
                receives_all_direct: { type: 'boolean', description: 'Set true/false to grant or remove observer visibility into direct log entries.' },
            },
            required: ['role_id'],
        },
    },
    {
        name: 'borg_patch-role-section',
        description: "Surgically patch ONE named section of a role's detailed_description, leaving the rest of the field byte-identical. Sections are delimited by plain-label lines (e.g. `Workflow:`, `Project conventions:`) — NOT markdown headings; text before the first label is the preamble. Use this instead of borg_update-role when changing a single section so you don't have to resend (and risk clobbering) the whole playbook. action=replace overwrites a section's body; action=insert adds a new section (optionally after a named one, else appended); action=delete removes a section.",
        inputSchema: {
            type: 'object',
            properties: {
                role_id: { type: 'string', description: 'UUID of the role to patch.' },
                action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'replace / insert / delete a single section.' },
                heading: { type: 'string', description: 'The section label WITHOUT the trailing colon (e.g. "Workflow"). Matched case-insensitively.' },
                body: { type: 'string', description: 'New text BELOW the heading (for replace/insert). Omit for delete.' },
                after: { type: 'string', description: 'For insert only: place the new section after the section with this heading. Omit/null to append at the end.' },
            },
            required: ['role_id', 'action', 'heading'],
        },
    },
    {
        name: 'borg_delete-role',
        description: 'Delete a role. Refuses if any drone is still assigned — reassign them with borg_reassign-drone or remove them with borg_evict-drone first.',
        inputSchema: {
            type: 'object',
            properties: {
                role_id: { type: 'string', description: 'UUID of the role to delete.' },
            },
            required: ['role_id'],
        },
    },
    {
        name: 'borg_reassign-drone',
        description: 'Reassign a drone to a different role in the same cube. Coordinator-shaped: the cube\'s Coordinator drone is the one expected to call this when dispatching new drones to specific work. ' +
            'Server refuses if you try to assign to the Coordinator role when another drone already holds it (evict or reassign that drone first).',
        inputSchema: {
            type: 'object',
            properties: {
                drone_id: { type: 'string', description: 'UUID of the drone to reassign.' },
                role_id: { type: 'string', description: 'UUID of the target role. Must belong to the same cube as the drone.' },
            },
            required: ['drone_id', 'role_id'],
        },
    },
    {
        name: 'borg_evict-drone',
        description: 'Evict (soft-delete) a drone from its cube. Coordinator-shaped: the cube\'s Coordinator/Queen seat calls this to remove a dead, stuck, or surplus drone — it drops out of the roster and frees its slot (incl. a held Coordinator/Queen-class seat), while its activity-log history is preserved with anonymized attribution. Owner-scoped: you can only evict drones in cubes you own. Identify the drone EITHER by drone_id (UUID) OR by label + cube_id (the label as it appears in the roster/regen).',
        inputSchema: {
            type: 'object',
            properties: {
                drone_id: { type: 'string', description: 'UUID of the drone to evict. Provide this OR (label + cube_id).' },
                label: { type: 'string', description: 'Drone label to evict, e.g. "two-of-seventeen-builder". Requires cube_id. Ignored when drone_id is given.' },
                cube_id: { type: 'string', description: 'UUID of the cube the labelled drone belongs to. Required when evicting by label.' },
            },
        },
    },
    {
        name: 'borg_list-drones',
        description: 'List every drone in a cube (owner-scoped). Returns id, label, role_id, agent_kind, last_seen, advisory reported model, working repository, and wake_path_alert_class for each — gives the Coordinator a roster they can act on with borg_reassign-drone.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube whose drones to list.' },
            },
            required: ['cube_id'],
        },
    },
    {
        name: 'borg_list-roles',
        description: 'List every role in a cube (owner-scoped). Returns id, name, short_description, is_default, is_mandatory, is_human_seat, can_broadcast, receives_all_direct, and role_class for each — gives Coordinator-class drones the role UUIDs they need for borg_reassign-drone (e.g. to promote a drone to the Queen role). Closes the gh#153 Queen-role-promotion UX gap (Coordinator drones previously had no way to discover role IDs without operator help).',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube whose roles to list.' },
            },
            required: ['cube_id'],
        },
    },
    {
        name: 'borg_list-templates',
        description: 'List available cube templates that can be applied via borg_apply-template or passed to borg_create-cube.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'borg_apply-template',
        description: 'Apply a named template to an existing cube, NON-CLOBBERINGLY. Roles are merged by name: new roles are created; existing template-named roles get template sections/classes the cube LACKS auto-applied, but EVOLVED (conflicting) text is preserved, never overwritten. Use this to retrofit an existing cube with a richer role set (e.g. add Coordinator/Reviewer/UX Expert). To review + selectively accept conflicting fragments, use borg_sync-roles (which surfaces each conflict + takes per-fragment accept decisions).',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube to apply the template to.' },
                template_name: { type: 'string', description: 'Template to apply (see borg_list-templates).' },
            },
            required: ['cube_id', 'template_name'],
        },
    },
    {
        name: 'borg_sync-roles',
        description: 'Non-clobbering sync of a cube\'s roles + message_taxonomy against the built-in template. Dry-run (default) classifies each fragment (role-text section, short_description, role flags, taxonomy class) as ADD (cube lacks it — safe auto-apply), UNCHANGED, or CONFLICT (cube has EVOLVED text). On apply, ADDs auto-apply; CONFLICTs apply ONLY via an explicit `decisions` accept (keyed on the dry-run fragment key, e.g. `role:Builder:section:Workflow`); unspecified conflicts default to reject — evolved text is NEVER silently overwritten. Custom roles untouched.',
        inputSchema: {
            type: 'object',
            properties: {
                cube_id: { type: 'string', description: 'UUID of the cube to sync.' },
                template_name: { type: 'string', description: 'Template to sync against (default: software-dev).' },
                apply: { type: 'boolean', description: 'If true, commit (auto-apply ADDs + accepted conflicts). If false (default), dry-run only — classify + surface conflicts.' },
                decisions: {
                    type: 'object',
                    description: 'Per-conflict accept/reject map, keyed on the fragment key from the dry-run (e.g. {"role:Builder:section:Workflow":"accept"}). Unspecified conflicts default to "reject" (keep the cube version).',
                    additionalProperties: { type: 'string', enum: ['accept', 'reject'] },
                },
            },
            required: ['cube_id'],
        },
    },
    // gh#899: dispatcher escape hatch — ALWAYS native in every role's surface
    // so deferred (filtered-out) tools are never lost. Routes through the
    // identical CallTool→handler→userId+Zod path (no weaker entry); this is
    // a UX/context optimization, NOT an authorization boundary.
    {
        name: 'borg_tool',
        description: 'Dispatcher: invoke ANY borg tool by name, including tools not pre-loaded in your role-scoped surface. Pass {"name":"<borg_tool>","arguments":{...}}. Routes through the identical auth + validation path as a direct call. Call borg_describe-tool first to learn a deferred tool\'s arguments.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The borg tool to invoke, e.g. "borg_evict-drone".' },
                arguments: { type: 'object', description: 'The arguments object for that tool (same shape as a direct call).' },
            },
            required: ['name'],
        },
    },
    {
        name: 'borg_describe-tool',
        description: 'Return the description + input schema for any borg tool by name — including deferred tools not pre-loaded in your surface. Schema-only; never executes the tool. Pair with borg_tool to invoke a deferred tool.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The borg tool to describe.' },
            },
            required: ['name'],
        },
    },
];
//# sourceMappingURL=tool-manifest.js.map