/**
 * gh#docs-site — SOURCE-OF-TRUTH tool manifest.
 *
 * The single canonical list of borg_* MCP tool definitions. The runtime and
 * documentation consumers use the same pure-data list.
 *
 * CONTRACT-BACKED DATA — imports only published scalar contract constants, with
 * no client runtime side effects.
 */
import { DECISION_TEXT_MAX_BYTES, DEFAULT_MAX_LOG_ENTRY_BYTES, DOCUMENT_CONTENT_TYPES } from 'borgmcp-shared/protocol';

/**
 * gh#492: JSON Schema contract for a tool's `structuredContent`. Success
 * results conform to it; errors stay text-first. `additionalProperties` is
 * left open everywhere so additive server fields never invalidate a
 * conforming result.
 */
export interface OutputSchema {
  type: 'object';
  description?: string;
  properties: Record<string, any>;
  required?: string[];
}

export interface ToolManifestEntry {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
    oneOf?: Array<{ required: string[] }>;
  };
  outputSchema?: OutputSchema;
}

const BASE_TOOL_MANIFEST: ToolManifestEntry[] = [
        {
          name: 'borg_regen',
          description:
            "Refresh your context as a Drone. Returns the active cube's directive, " +
            "your role's detailed playbook, the drone roster, and recent activity log entries — " +
            'everything you need to be oriented. Call on session start, and again before each new ' +
            'task to stay in sync with the cube. Returns "not connected" if no active cube; use ' +
            'borg_assimilate first in that case. ' +
            'Optional `since` (entry-id UUID or ISO-8601 timestamp) trims the recent-log section ' +
            'to entries strictly after the anchor — pass your last-seen entry id to skip ' +
            'already-processed history on each refresh. If you know the current session model, pass ' +
            'optional `model` to self-report its printable identifier as advisory metadata; model names are not allowlisted.',
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                description:
                  'Optional cursor. Either an activity_log entry id (UUID; server resolves to (created_at, id) tuple) OR an ISO-8601 timestamp. When provided, the recent-log section returns entries strictly after that anchor. Non-existent UUID falls back to default recent window.',
              },
              mode: {
                type: 'string',
                enum: ['full', 'lite'],
                description:
                  'Optional output mode. Use full at session start and after context compaction. Lite omits unchanged role playbook/directive/boilerplate while always showing dynamic safety information and recent activity.',
              },
              model: {
                type: 'string',
                minLength: 1,
                maxLength: 160,
                pattern: '^[A-Za-z0-9][A-Za-z0-9._/@:+-]*$',
                description:
                  'Optional advisory self-report of the model running this agent session. Use a printable model identifier of 1-160 ASCII characters; model names are not allowlisted.',
              },
            },
            required: [],
          },
        },
        {
          name: 'borg_assimilate',
          description:
            "Reconnect this session to the existing drone saved for this worktree. This tool " +
            "never creates drones. Provide the cube's name; on a match it returns the cube " +
            "directive, your role's instructions, and recent activity for that drone. To create " +
            'a drone or switch cubes, run `borg assimilate` in a terminal instead.',
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
          description:
            "Read the active Cube's directive and the registry of all roles in it " +
            "(each role's name + short description). Use to remind yourself of cube-wide context.",
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'borg_role',
          description:
            "Read a role's detailed playbook. With no arguments, returns YOUR " +
            'assigned role. Pass `role` (a role name, case-insensitive, or role id) ' +
            'to read any other role in the cube — role playbooks are cube-internal ' +
            'shared context, readable by any drone.',
          inputSchema: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                description:
                  'Optional. A role name (case-insensitive) or role id. Omit to read your own role.',
              },
            },
            required: [],
          },
        },
        {
          name: 'borg_version',
          description:
            'Returns the installed borgmcp client version. Use to verify which version is running in this MCP session.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'borg_playbook',
          description:
            'Load the full operating-playbook chapter — the detailed disciplines, rationale, and examples behind the abbreviated session instructions (verification discipline v1/v2/v3, concrete source-of-truth surfaces, four-surface propagation). This detail is omitted from the initial context to keep it light; fetch it ONCE per session when doing review/verify-class work. Static text — do NOT re-fetch on every wake.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'borg_docs',
          description:
            'Look up the Borg MCP documentation. Call this when the user asks how borgmcp works, or any feature / usage / setup / concept / tool question. Returns the docs index — each section\'s documentation URL + a one-line summary. Pass `topic` (e.g. "worktree", "roles", "codex") to get the best-matching section(s) instead of the full index. Then WebFetch the returned URL to read the page — borg_docs returns the index only, it does not fetch the page for you.',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                description:
                  'Optional search topic — returns the best-matching docs section(s) instead of the full index.',
              },
            },
            required: [],
          },
        },
        {
          name: 'borg_whoami',
          description:
            'Returns your identity in the current cube: cube name, drone label, and role name. Use to confirm which cube/role/drone you are.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'borg_role-rationale',
          description:
            "Fetch exactly one named section from a role's detailed playbook using the current drone session. " +
            "Pass a role name/UUID and a plain-label section key. Role names and section keys match case-insensitively; UUIDs match exactly. Malformed selectors, ambiguous role names, and unknown roles/sections refuse. Returns the server's canonical role name, role_id, section heading, and the section body in full, refusing rather than truncating when it exceeds the server's role-text size limit, so a drone can read one section on demand instead of carrying the whole playbook in every borg_regen.",
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
          description:
            "List all currently connected drones in your cube, with each drone's label, role, and last-seen time. Optional `since` argument adds a sender-side liveness column — pass either an activity_log entry id (e.g., from a dispatch you posted) or an ISO-8601 timestamp; each drone is marked `awake` if they've posted a log entry after that point, otherwise `stale-since-X`. Useful for confirming a dispatch reached its named recipients (catches the silent-wake-path-failure class where SSE delivered but the drone's inbox Monitor never woke it).",
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                description:
                  'Optional liveness reference point. Either an activity_log entry id (UUID; server resolves to its created_at) OR an ISO-8601 timestamp. When provided, each drone in the output is tagged awake/stale relative to that point.',
              },
            },
            required: [],
          },
        },
        {
          name: 'borg_stream-status',
          description:
            "Diagnostic probe of the local SSE log-stream consumer: returns `connected`, `lastContentEventAt`, `lastWireActivityAt`, `lastHeartbeatAt`, `lastPersistedEventId`, `reconnectAttempts`, plus a wake-path check that flags if SSE is attached but no inbox Monitor is watching the file (the silent failure where incoming entries reach disk but do not wake the drone). Read-only in-process state; does NOT re-open the stream. Use when troubleshooting wake-ups or verifying the stream is alive.",
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'borg_read-log',
          description:
            "Read entries from the cube's activity log. Each entry is tagged " +
            "with the drone that wrote it and that drone's role. For wake triage, prefer " +
            '`unread_only=true` with a modest limit and drain until `has_more=false`; ' +
            'this reads oldest-unread-first from your server cursor and ' +
            'advances the watermark so bursts are not skipped. A backlog above 50 returns a digest plus the newest 25 entries. Optional `since` is a strict-after ' +
            'cursor for explicit bounded reads only; do not use it with the same timestamp as a ' +
            'notification preview because it can skip the boundary entry. Use `borg_read-entry` ' +
            'to fetch one known entry without changing the unread cursor.',
          inputSchema: {
            type: 'object',
            properties: {
              since: {
                type: 'string',
                description:
                  'Optional strict-after cursor for explicit bounded reads. Either an activity_log entry id (UUID; server resolves to (created_at, id) tuple for deterministic tie-break) OR an ISO-8601 timestamp. Do not use for routine wake triage; prefer unread_only.',
              },
              limit: {
                type: 'number',
                description: 'max entries to return (1-500)',
              },
              unread_only: {
                type: 'boolean',
                description:
                  'When true, read only entries posted after this drone last called read-log, oldest-unread-first. Server advances the watermark to the newest returned entry on every call; if has_more=true, call again until has_more=false.',
              },
            },
          },
        },
        {
          name: 'borg_read-entry',
          description:
            'Read one complete activity-log entry by its canonical UUID or unique 8-hex prefix without changing the unread cursor. Returns the same entry shape and structured routing recipients as borg_read-log. Use borg_read-log unread_only=true for routine wake drains. Direct routing controls delivery and wakes, not read confidentiality inside the cube.',
          inputSchema: {
            type: 'object',
            properties: {
              entry_id: {
                type: 'string',
                pattern: '^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12})$',
                description: 'Canonical activity-log entry UUID or unique 8-hex prefix.',
              },
            },
            required: ['entry_id'],
          },
        },
        {
          name: 'borg_ack',
          description:
            'Mark a log entry as explicitly acknowledged (kind="ack", default), or claim advisory ownership of a review gate before starting (kind="claim"). Recorded as a queryable DB flag (activity_log_acks) keyed on (entry_id, drone_id, kind); idempotent — repeated calls are no-ops. ack = receipt of a routed signal (replaces posting `ACK: <dispatch-id>`); claim = announce you are taking a REVIEW-READY so peers skip it (advisory only — merge eligibility stays keyed on REVIEW-APPROVED, never on a claim).',
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
                description:
                  'Coordination kind. "ack" (default) = receipt. "claim" = advisory ownership of a review gate on a REVIEW-READY entry (wakes the gate audience; renders stale if you go silent past the wake-path SLA).',
              },
            },
          },
        },
        {
          name: 'borg_ack-status',
          description:
            'Read acknowledgement status for one activity-log entry without changing it. Returns per-recipient acknowledgements and advisory claims separately. Activity-log silence is not evidence that acknowledgement is missing; use this query instead. This read-only query does not acknowledge or claim the entry and preserves unread cursors.',
          inputSchema: {
            type: 'object',
            required: ['entry_id'],
            properties: {
              entry_id: {
                type: 'string',
                format: 'uuid',
                description: 'Full UUID of the activity-log entry to inspect.',
              },
            },
          },
        },
        {
          name: 'borg_decide',
          description:
            'Record a RATIFIED cube decision in the durable decision registry so drones cite it by topic instead of restating from memory. Coordinator and Queen roles are workflow-eligible to ratify, but role labels grant no server permission; the selected local client must have a live cube-manage grant. Recording IS the ratification act; a decision is not ratified until it is in the registry. Topic-keyed: recording a new decision on an existing topic supersedes the prior (one active per topic). The decision appears in borg_regen and borg_decisions.',
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
                description: `The ratified decision text. Max ${DECISION_TEXT_MAX_BYTES} UTF-8 bytes (bytes, not characters).`,
              },
              rationale: {
                type: 'string',
                description: `Optional why. Max ${DECISION_TEXT_MAX_BYTES} UTF-8 bytes (bytes, not characters).`,
              },
            },
          },
        },
        {
          name: 'borg_decisions',
          description:
            'List the active ratified decisions for the cube — the source of truth to CITE instead of restating a decision from memory. Any member may read. Pass `topic` to fetch one topic\'s active decision; omit for all active decisions.',
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
          description:
            'Remove one active ratified decision from the cube registry by topic or decision id. Coordinator/Queen are workflow-eligible, but their labels grant no server permission; the selected local client must have a live cube-manage grant. The decision stops appearing in borg_decisions and borg_regen while its audit record is retained.',
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
          name: 'borg_put-document',
          description:
            'Create an immutable cube document containing Markdown or plain text. Use this for durable material that is too large or detailed for an activity-log message. Pass `supersedes` with the full prior document id to create its next linear revision; content is never edited in place. Requires the selected local client to have a live cube-write or cube-manage grant.',
          inputSchema: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                maxLength: 120,
                description: 'Document title, trimmed and control-free; max 120 Unicode characters and 480 UTF-8 bytes.',
              },
              content_type: {
                type: 'string',
                enum: [...DOCUMENT_CONTENT_TYPES],
                description: 'Exact document content type: text/markdown or text/plain.',
              },
              content: {
                type: 'string',
                description: 'Immutable document content. The server enforces its configured UTF-8 byte limit.',
              },
              supersedes: {
                type: 'string',
                description: 'Optional full opaque id of the active document this new revision supersedes.',
              },
            },
            required: ['title', 'content_type', 'content'],
          },
        },
        {
          name: 'borg_get-document',
          description:
            'Fetch one cube document by its full opaque id, including immutable content, revision links, state, author, and removal audit metadata. Exact-id reads retain removed content for audit. Requires a live cube-read, cube-write, or cube-manage grant.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Full opaque document id. Do not abbreviate it.' },
            },
            required: ['id'],
          },
        },
        {
          name: 'borg_list-documents',
          description:
            'List active and superseded document metadata in the current cube. Removed documents are omitted; use borg_get-document with an exact known id for retained audit content. Document bodies are not included.',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'borg_remove-document',
          description:
            'Mark one cube document removed while retaining its immutable content and audit metadata. The server permits the document author or a client with a live cube-manage grant; workflow role labels grant no permission. Idempotent for an already removed document.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Full opaque document id to remove. Do not abbreviate it.' },
            },
            required: ['id'],
          },
        },
        {
          name: 'borg_log',
          description:
            'Append a message to the cube\'s activity log with an explicit audience. Every call must pass `to: "broadcast"` for all drones or a non-empty selector array for direct delivery. Selectors accept an exact drone label, drone id, the stable 8-hex `id:` token shown in roster/read-log, role name, or role slug. Pass local Git refs through `refs` to append their mechanically resolved commit SHAs; REVIEW-READY messages require refs. Message text and taxonomy classes never choose the audience; optional `class` records classification/lifecycle metadata only. Cite durable cube documents through `documents`; citations carry current metadata but do not inline document content. Direct routing controls delivery and wakes, not read confidentiality inside the cube.',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: `The log message. Default limit ${DEFAULT_MAX_LOG_ENTRY_BYTES} bytes (server-configurable); a longer post is refused — store the detail as a document and cite it.` },
              // Keep this required value schema combinator-free for flat tool
              // serializers. normalizeLogAudience remains the strict boundary.
              to: {
                description:
                  'Required explicit audience: "broadcast" for every drone, or a non-empty array of exact drone labels, drone ids, stable 8-hex `id:` tokens, role names, or role slugs.',
              },
              class: {
                type: 'string',
                description:
                  'Optional declared message class for classification/lifecycle metadata. It never changes the required `to` audience.',
              },
              documents: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 100,
                uniqueItems: true,
                description: 'Optional full opaque ids of 1-100 same-cube documents to cite atomically. Unknown, duplicate, or foreign ids are refused.',
              },
              refs: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 8,
                uniqueItems: true,
                description: 'Optional local Git refs to resolve mechanically and append as `<ref> = <40-hex>` provenance. Required for REVIEW-READY messages.',
              },
            },
            required: ['message', 'to'],
          },
        },
        {
          name: 'borg_list-cubes',
          description: 'List every cube readable by this local client\'s live grants. Returns id, name, cube_directive, and timestamps for each. Useful before assimilate to see what\'s available, or as a starting point for an authorized management action.',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'borg_create-cube',
          description:
            'Create a new cube bound to an explicit repository. The server homes ONE cube per repository: if the given repository already has a cube, this reports that existing cube and leaves its directive unchanged (it never overwrites it). The server seeds the selected named template atomically; `software-dev` is selected by default. ' +
            'Pass an optional `template` name to select another role set (see borg_list-templates / borg_apply-template).',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Cube name (starts with a letter or digit; letters, digits, spaces, dots, underscores, or hyphens; max 120 UTF-8 bytes).',
                pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]*$',
                maxLength: 120,
              },
              cube_directive: { type: 'string', description: 'Project-specific Markdown shown to every drone when it refreshes cube context.' },
              repository: {
                type: 'string',
                description: 'The repository this cube binds to (explicit — not inferred from the working directory). Pass a canonical git remote URL (e.g. https://github.com/owner/repo) for a hosted repository, or a UUID identifying a local (no-remote) repository. The cube is homed to this repository; if it already has one, that existing cube is reported and its directive is left unchanged.',
              },
              working_repo_name: {
                type: 'string',
                description: 'Optional short display name for the repository (starts with a letter or digit; letters, digits, spaces, dots, underscores, or hyphens; max 120 bytes). Defaults to the repository segment of the URL; required when `repository` is a local UUID.',
                pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]*$',
                maxLength: 120,
              },
              template: {
                type: 'string',
                description: 'Optional named template (default: "software-dev"). The server seeds its roles atomically when a cube is newly created; it is never applied to an already-existing repository cube.',
              },
            },
            required: ['name', 'cube_directive', 'repository'],
          },
        },
        {
          name: 'borg_update-cube',
          description: 'Update a cube\'s cube_directive and/or message_taxonomy. Pass only what changes.',
          inputSchema: {
            type: 'object',
            properties: {
              cube_id: { type: 'string', description: 'UUID of the cube to update.' },
              cube_directive: { type: 'string', description: 'New cube directive markdown (optional).' },
              message_taxonomy: {
                type: 'array',
                description: 'New classification/lifecycle taxonomy (optional). REPLACES the whole taxonomy; the server re-validates non-overlapping prefixes and unique class names. Pass [] to clear. To change ONE class without resending the whole array, use borg_patch-taxonomy-class instead. Optional lifecycle tags mark dispatch/completion classes for stuck-dispatch detection. Taxonomy never chooses log recipients.',
                items: {
                  type: 'object',
                  properties: {
                    class: { type: 'string', description: 'Unique class name.' },
                    prefixes: { type: 'array', items: { type: 'string' }, description: 'Message prefixes classified by this class.' },
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
          description:
            "Patch ONE classification/lifecycle class in a cube's message_taxonomy without resending the whole taxonomy (avoids clobbering). action=add|replace|remove (replace/remove match name case-insensitively). The full taxonomy is re-validated for non-overlapping prefixes and unique names. Optional lifecycle tags mark dispatch/completion classes for stuck-dispatch detection. Taxonomy never chooses log recipients.",
          inputSchema: {
            type: 'object',
            properties: {
              cube_id: { type: 'string', description: 'UUID of the cube to patch.' },
              action: { type: 'string', enum: ['add', 'replace', 'remove'], description: 'add / replace / remove a single class.' },
              class_def: {
                type: 'object',
                description: 'The class definition (for add/replace). Shape: { class, prefixes?, lifecycle? }.',
                properties: {
                  class: { type: 'string', description: 'Unique class name.' },
                  prefixes: { type: 'array', items: { type: 'string' }, description: 'Message prefixes classified by this class.' },
                  lifecycle: { type: 'string', enum: ['dispatch', 'completion'], description: 'Optional lifecycle marker for stuck-dispatch detection.' },
                },
                required: ['class'],
              },
              class: { type: 'string', description: 'For remove only: the name of the class to drop (case-insensitive).' },
            },
            required: ['cube_id', 'action'],
          },
        },
        {
          name: 'borg_delete-cube',
          description: 'Delete a cube and all its roles, drones, and log entries. Irreversible; requires the exact cube UUID again after explicit user confirmation.',
          inputSchema: {
            type: 'object',
            properties: {
              cube_id: { type: 'string', description: 'UUID of the cube to delete.' },
              confirm_cube_id: { type: 'string', description: 'Explicit user confirmation: repeat the exact cube UUID to confirm this irreversible deletion.' },
            },
            required: ['cube_id', 'confirm_cube_id'],
          },
        },
        {
          name: 'borg_create-role',
          description: 'Create a role inside a cube. The detailed_description is the role\'s playbook — only drones assigned to this role see it. Setting is_default=true demotes any existing default; a cube has exactly one default role at a time.',
          inputSchema: {
            type: 'object',
            properties: {
              cube_id: { type: 'string', description: 'UUID of the cube this role belongs to.' },
              name: { type: 'string', description: 'Role name: 1-64 bytes, starting with an ASCII letter or digit, then using only ASCII letters, digits, spaces, periods, underscores, or hyphens.' },
              short_description: { type: 'string', description: 'One-line summary, shown to every drone in the cube.' },
              detailed_description: { type: 'string', description: 'Full playbook for drones in this role — workflow, conventions, log signals to post.' },
              is_default: { type: 'boolean', description: 'If true, new drones assimilating into this cube are assigned this role. Demotes the previous default.' },
              is_mandatory: { type: 'boolean', description: 'If true, role-less assimilation prioritizes this unoccupied role before ordinary worker roles. Platform-wide management roles are never auto-assigned; a mandatory human-operator role is selected first until occupied.' },
              is_human_seat: { type: 'boolean', description: 'If true, this role represents the cube\'s human-occupied seat (where the human Queen sits directly). The class-hierarchy guard in reassign-drone allows promotion FROM a human-seat role TO the platform Queen role; promotion from non-human-seat roles is rejected.' },
              can_broadcast: { type: 'boolean', description: 'If true, drones in this role may post broadcast log entries when strict broadcast gating is enabled.' },
              receives_all_direct: { type: 'boolean', description: 'If true, drones in this role are included as observer/audit recipients for every direct route.' },
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
              name: { type: 'string', description: 'New role name (optional): 1-64 bytes, starting with an ASCII letter or digit, then using only ASCII letters, digits, spaces, periods, underscores, or hyphens.' },
              short_description: { type: 'string', description: 'New short description (optional).' },
              detailed_description: { type: 'string', description: 'New detailed playbook (optional).' },
              is_default: { type: 'boolean', description: 'Set true to make this the cube\'s default role (optional).' },
              is_mandatory: { type: 'boolean', description: 'Set true/false to prioritize this unoccupied role during role-less assimilation. Platform-wide management roles are never auto-assigned.' },
              is_human_seat: { type: 'boolean', description: 'Set true/false to mark/unmark this as the cube\'s human-occupied seat (the elevation source for the platform Queen role).' },
              can_broadcast: { type: 'boolean', description: 'Set true/false to allow or deny broadcast log entries when strict broadcast gating is enabled.' },
              receives_all_direct: { type: 'boolean', description: 'Set true/false to include or remove this role as observer/audit recipients for every direct route.' },
            },
            required: ['role_id'],
          },
        },
        {
          name: 'borg_patch-role-section',
          description:
            "Surgically patch ONE named section of a role's detailed_description, leaving the rest of the field byte-identical. Sections are delimited by plain-label lines (e.g. `Workflow:`, `Project conventions:`) — NOT markdown headings; text before the first label is the preamble. Use this instead of borg_update-role when changing a single section so you don't have to resend (and risk clobbering) the whole playbook. action=replace overwrites a section's body; action=insert adds a new section (optionally after a named one, else appended); action=delete removes a section.",
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
          description: 'Delete a role using the selected local client\'s cube-management grant. Unknown or inaccessible roles refuse. Also refuses for the default, mandatory, or human-seat role, or a role assigned to an active drone. Reassign active drones with borg_reassign-drone or remove them with borg_evict-drone first. Evicted drones that held the deleted role are reassigned to the cube\'s default role; their activity-log attribution is unaffected.',
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
          description:
            'Reassign a drone within the current cube using the selected local client\'s cube-management grant. Returns server-derived drone, cube, and role readback. Coordinator and Queen are workflow labels, not server permissions.',
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
          description:
            'Remove a drone using the selected local client\'s cube-management grant. The drone\'s credential is revoked, project files remain, and activity history keeps the removed drone\'s attribution. Accepts drone_id for the current cube or label with cube_id.',
          inputSchema: {
            type: 'object',
            properties: {
              drone_id: { type: 'string', description: 'UUID of the drone to evict. Provide this OR (label + cube_id).' },
              label: { type: 'string', description: 'Drone label to evict, e.g. "two-of-seventeen-builder". Requires cube_id and cannot be combined with drone_id.' },
              cube_id: { type: 'string', description: 'UUID of the cube the labelled drone belongs to. Required when evicting by label.' },
            },
          },
        },
        {
          name: 'borg_list-drones',
          description:
            'List every drone in a cube when this local client has a live read, write, or manage grant. Returns id, label, role_id, agent_kind, last_seen, advisory reported model, working repository home assignment for implementation work, and wake_path_alert_class. Route repository-specific implementation work to the drone homed in that repository; drones do not take implementation work outside their home repository. Repository homing and role labels grant no server permission, and the server does not enforce repository homing.',
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
          description:
            'List every role in a cube when this local client has a live read, write, or manage grant. Returns id, name, short_description, is_default, is_mandatory, is_human_seat, can_broadcast, receives_all_direct, and role_class. Role labels affect workflow only and grant no server permission.',
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
          description:
            'A client-orchestrated, non-clobbering application of a named template through role and taxonomy primitives. Requires the selected local client\'s live cube-manage grant. Roles are merged by name: new roles are created; existing template-named roles get missing sections/classes applied, while conflicting text is preserved. Operations are sequential, not atomic: if a later primitive fails, earlier operations may already be committed. Use borg_sync-roles to review and selectively accept conflicts.',
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
          description:
            'A client-orchestrated, non-clobbering sync through role and taxonomy primitives. Requires the selected local client\'s live cube-manage grant. Dry-run (default) classifies each fragment as ADD, UNCHANGED, or CONFLICT. On apply, ADDs apply automatically; conflicts apply only through an explicit `decisions` accept, and unspecified conflicts remain unchanged. Operations are sequential, not atomic: if a later primitive fails, earlier operations may already be committed. Custom roles remain untouched.',
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

// ---------------------------------------------------------------------------
// gh#492: outputSchema per typed tool. Shapes mirror the borgmcp-shared
// protocol result contracts (protocol/coordination, protocol/types,
// protocol/documents); the client builds structuredContent from the same
// source objects its text renderer consumes. `borg_tool` declares no schema
// (its output is the selected inner tool's result) and `borg_playbook` is a
// deliberate text-only prose chapter.
// ---------------------------------------------------------------------------

const DOCUMENT_CITATION_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    size_bytes: { type: 'number' },
    state: { type: 'string' },
  },
  required: ['id', 'title'],
};

const DOCUMENT_METADATA_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    size_bytes: { type: 'number' },
    state: { type: 'string' },
    content_type: { type: 'string' },
    supersedes: { type: ['string', 'null'] },
    superseded_by: { type: ['string', 'null'] },
    author: { type: 'object' },
    created_at: { type: 'string' },
    removed_by: { type: ['object', 'null'] },
    removed_at: { type: ['string', 'null'] },
  },
  required: ['id', 'title', 'state'],
};

const DOCUMENT_OUTPUT = {
  ...DOCUMENT_METADATA_OUTPUT,
  properties: { ...DOCUMENT_METADATA_OUTPUT.properties, content: { type: 'string' } },
};

const LOG_ENTRY_OUTPUT = {
  type: 'object',
  description: 'Enriched activity-log entry.',
  properties: {
    id: { type: 'string' },
    cube_id: { type: 'string' },
    drone_id: { type: ['string', 'null'] },
    message: { type: 'string' },
    visibility: { type: 'string', enum: ['broadcast', 'direct'] },
    created_at: { type: 'string' },
    drone_label: { type: ['string', 'null'] },
    role_name: { type: ['string', 'null'] },
    recipient_drone_ids: { type: 'array', items: { type: 'string' } },
    documents: { type: 'array', items: DOCUMENT_CITATION_OUTPUT },
  },
  required: ['id', 'message', 'visibility', 'created_at'],
};

const DRONE_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    cube_id: { type: 'string' },
    role_id: { type: 'string' },
    label: { type: 'string' },
    last_seen: { type: 'string' },
    hostname: { type: ['string', 'null'] },
  },
  required: ['id', 'label'],
};

const ROLE_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    cube_id: { type: 'string' },
    name: { type: 'string' },
    short_description: { type: 'string' },
    is_default: { type: 'boolean' },
    is_human_seat: { type: 'boolean' },
    created_at: { type: 'string' },
  },
  required: ['id', 'name'],
};

const CUBE_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    cube_directive: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['id', 'name'],
};

const DECISION_OUTPUT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    cube_id: { type: 'string' },
    topic: { type: 'string' },
    decision: { type: 'string' },
    rationale: { type: ['string', 'null'] },
    supersedes: { type: ['string', 'null'] },
    created_at: { type: 'string' },
  },
  required: ['topic', 'decision'],
};

// The server's contextAdvisory for cube update, role update, and role-section
// patch is a SENTENCE (string) when present — never an object. Only the
// log-append advisory is an object; borg_log declares that shape separately.
const ADVISORY_OUTPUT = {
  description: 'Server advisory sentence attached to the mutation result; null when the server sent none.',
  type: ['string', 'null'],
};

export const TOOL_OUTPUT_SCHEMAS: Record<string, OutputSchema> = {
  // --- Machine-state queries and discovery ---
  'borg_version': {
    type: 'object',
    properties: { version: { type: 'string' } },
    required: ['version'],
  },
  'borg_whoami': {
    type: 'object',
    properties: {
      cube_id: { type: 'string' },
      cube_name: { type: 'string' },
      drone_id: { type: 'string' },
      drone_label: { type: 'string' },
      role_id: { type: 'string' },
      role_name: { type: 'string' },
      runtime_metadata: { type: 'object' },
      runtime_metadata_reported: { type: 'boolean' },
    },
    required: ['cube_id', 'cube_name', 'drone_id', 'drone_label', 'role_id', 'role_name'],
  },
  'borg_roster': {
    type: 'object',
    properties: {
      cube_name: { type: 'string' },
      drones: { type: 'array', items: DRONE_OUTPUT },
      roles: { type: 'array', items: ROLE_OUTPUT },
      since: { type: ['string', 'null'], description: 'Resolved since-cursor, or null for the default window.' },
    },
    required: ['cube_name', 'drones', 'roles', 'since'],
  },
  'borg_stream-status': {
    type: 'object',
    properties: {
      status: {
        type: 'object',
        description: 'In-process SSE consumer snapshot.',
        properties: {
          connected: { type: 'boolean' },
          reconnectAttempts: { type: 'number' },
          runLoopHealth: { type: 'string' },
        },
      },
      wake_path: { type: 'object', description: 'Runtime-specific wake-path inspection.' },
      // gh#500: null when wake-path health is indeterminate (a real state,
      // distinct from false=determined-unhealthy); the source is boolean|null.
      inbox_monitor_healthy: { type: ['boolean', 'null'] },
      inbox_path: { type: ['string', 'null'] },
      monitor_state_root: { type: ['string', 'null'] },
      drone_label: { type: ['string', 'null'] },
      cube_name: { type: ['string', 'null'] },
    },
    required: ['status', 'inbox_monitor_healthy'],
  },
  'borg_read-log': {
    type: 'object',
    properties: {
      // gh#496: no roster block — the per-wake drain payload stays
      // proportional to its entry count; entries carry drone_label/role_name.
      entries: { type: 'array', items: LOG_ENTRY_OUTPUT },
      behind_by: { type: ['number', 'null'], description: 'Visible entries still unread after this read; null when the server did not report it.' },
      has_more: { type: 'boolean' },
      omitted: { type: 'number', description: 'Older fetched entries summarized outside the structured entry tail; absent when digest mode was not used.' },
    },
    required: ['entries', 'behind_by', 'has_more'],
  },
  'borg_read-entry': {
    type: 'object',
    properties: {
      entry: LOG_ENTRY_OUTPUT,
      drones: { type: 'array', items: DRONE_OUTPUT },
      roles: { type: 'array', items: ROLE_OUTPUT },
    },
    required: ['entry'],
  },
  'borg_ack-status': {
    type: 'object',
    properties: {
      entry_id: { type: 'string' },
      visibility: { type: 'string', enum: ['broadcast', 'direct'] },
      recipients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            drone_id: { type: 'string' },
            drone_label: { type: ['string', 'null'] },
            drone_role: { type: ['string', 'null'] },
            acknowledged_at: { type: ['string', 'null'] },
          },
          required: ['drone_id', 'acknowledged_at'],
        },
      },
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            drone_id: { type: 'string' },
            drone_label: { type: ['string', 'null'] },
            drone_role: { type: ['string', 'null'] },
            claimed_at: { type: 'string' },
          },
          required: ['drone_id', 'claimed_at'],
        },
      },
    },
    required: ['entry_id', 'visibility', 'recipients', 'claims'],
  },
  'borg_decisions': {
    type: 'object',
    properties: { decisions: { type: 'array', items: DECISION_OUTPUT } },
    required: ['decisions'],
  },
  'borg_get-document': {
    type: 'object',
    properties: { document: DOCUMENT_OUTPUT },
    required: ['document'],
  },
  'borg_list-documents': {
    type: 'object',
    properties: { documents: { type: 'array', items: DOCUMENT_METADATA_OUTPUT } },
    required: ['documents'],
  },
  'borg_list-cubes': {
    type: 'object',
    properties: { cubes: { type: 'array', items: CUBE_OUTPUT } },
    required: ['cubes'],
  },
  'borg_list-drones': {
    type: 'object',
    properties: {
      cube_id: { type: 'string' },
      drones: { type: 'array', items: DRONE_OUTPUT },
      roles: { type: 'array', items: ROLE_OUTPUT },
    },
    required: ['cube_id', 'drones'],
  },
  'borg_list-roles': {
    type: 'object',
    properties: {
      cube_id: { type: 'string' },
      roles: { type: 'array', items: ROLE_OUTPUT },
    },
    required: ['cube_id', 'roles'],
  },
  'borg_list-templates': {
    type: 'object',
    properties: {
      templates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, description: { type: 'string' } },
          required: ['name', 'description'],
        },
      },
    },
    required: ['templates'],
  },
  'borg_describe-tool': {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      inputSchema: { type: 'object' },
      outputSchema: { type: ['object', 'null'], description: 'The described tool\'s structuredContent contract, or null for text-only and dynamic tools.' },
    },
    required: ['name', 'description', 'inputSchema', 'outputSchema'],
  },
  // --- Mutation receipts ---
  'borg_ack': {
    type: 'object',
    properties: {
      entry_id: { type: 'string' },
      kind: { type: 'string', enum: ['ack', 'claim'] },
      cube_name: { type: 'string' },
    },
    required: ['entry_id', 'kind', 'cube_name'],
  },
  'borg_decide': {
    type: 'object',
    properties: {
      decision: DECISION_OUTPUT,
      superseded: { type: 'boolean', description: 'True when this ratification superseded a prior decision on the topic.' },
      cube_name: { type: 'string' },
    },
    required: ['decision', 'superseded', 'cube_name'],
  },
  'borg_remove-decision': {
    type: 'object',
    properties: { decision: DECISION_OUTPUT, cube_name: { type: 'string' } },
    required: ['decision', 'cube_name'],
  },
  'borg_put-document': {
    type: 'object',
    properties: { document: DOCUMENT_OUTPUT },
    required: ['document'],
  },
  'borg_remove-document': {
    type: 'object',
    properties: { document: DOCUMENT_METADATA_OUTPUT },
    required: ['document'],
  },
  'borg_log': {
    type: 'object',
    properties: {
      suppressed: { type: 'boolean', description: 'True when a duplicate lifecycle signal was suppressed instead of persisted.' },
      entry: { ...LOG_ENTRY_OUTPUT, type: ['object', 'null'], description: 'The persisted entry; null when suppressed.' },
      recipients: { type: 'array', items: { type: 'string' }, description: 'Resolved directed-recipient display labels.' },
      unreachable_recipients: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, label: { type: 'string' } },
          required: ['id', 'label'],
        },
      },
      advisory: {
        type: ['object', 'null'],
        properties: { code: { type: 'string' }, threshold_bytes: { type: 'number' } },
      },
    },
    required: ['suppressed', 'entry', 'recipients', 'unreachable_recipients', 'advisory'],
  },
  'borg_create-cube': {
    type: 'object',
    properties: {
      cube: CUBE_OUTPUT,
      // client#499: 'created' = a new cube; 'resolved' = the repository already
      // had a cube (reported, directive left unchanged).
      result: { type: 'string', enum: ['created', 'resolved'] },
      template: { type: ['string', 'null'] },
      roles_created: { type: ['number', 'null'] },
      roles_updated: { type: ['number', 'null'] },
    },
    required: ['cube', 'result', 'template'],
  },
  'borg_update-cube': {
    type: 'object',
    properties: { cube: CUBE_OUTPUT, advisory: ADVISORY_OUTPUT },
    required: ['cube'],
  },
  'borg_patch-taxonomy-class': {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove'] },
      class: { type: 'string' },
      cube: CUBE_OUTPUT,
    },
    required: ['action', 'class', 'cube'],
  },
  'borg_delete-cube': {
    type: 'object',
    properties: { cube_id: { type: 'string' }, deleted: { type: 'boolean' } },
    required: ['cube_id', 'deleted'],
  },
  'borg_create-role': {
    type: 'object',
    properties: { role: ROLE_OUTPUT, cube_id: { type: 'string' } },
    required: ['role', 'cube_id'],
  },
  'borg_update-role': {
    type: 'object',
    properties: { role: ROLE_OUTPUT, advisory: ADVISORY_OUTPUT },
    required: ['role'],
  },
  'borg_patch-role-section': {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['replace', 'insert', 'delete'] },
      heading: { type: 'string' },
      role: ROLE_OUTPUT,
      advisory: ADVISORY_OUTPUT,
    },
    required: ['action', 'heading', 'role'],
  },
  'borg_delete-role': {
    type: 'object',
    properties: { role_id: { type: 'string' }, deleted: { type: 'boolean' } },
    required: ['role_id', 'deleted'],
  },
  'borg_reassign-drone': {
    type: 'object',
    properties: {
      drone: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          cube_id: { type: 'string' },
          role_id: { type: 'string' },
          label: { type: 'string' },
        },
        required: ['id', 'cube_id', 'role_id', 'label'],
      },
      role_name: { type: 'string' },
      cube_name: { type: 'string' },
    },
    required: ['drone', 'role_name', 'cube_name'],
  },
  'borg_evict-drone': {
    type: 'object',
    properties: {
      drone_id: { type: 'string' },
      label: { type: 'string' },
      cube_name: { type: 'string' },
      evicted: { type: 'boolean' },
    },
    required: ['drone_id', 'evicted'],
  },
  'borg_apply-template': {
    type: 'object',
    properties: {
      cube_id: { type: 'string' },
      template: { type: 'string' },
      roles_created: { type: 'number' },
      roles_updated: { type: 'number' },
      cube_directive_applied: { type: 'boolean' },
    },
    required: ['cube_id', 'template', 'roles_created', 'roles_updated'],
  },
  'borg_sync-roles': {
    type: 'object',
    properties: {
      cube_id: { type: 'string' },
      template: { type: 'string' },
      apply: { type: 'boolean' },
      result: { type: 'object', description: 'The sync plan or apply summary exactly as the server returned it.' },
    },
    required: ['cube_id', 'template', 'apply', 'result'],
  },
  // --- Context/domain results ---
  'borg_regen': {
    type: 'object',
    properties: {
      connected: { type: 'boolean', description: 'False when no cube is active; other fields are then absent.' },
      mode: { type: 'string', enum: ['full', 'lite'] },
      cube: CUBE_OUTPUT,
      drone: DRONE_OUTPUT,
      role: ROLE_OUTPUT,
      behind_by: { type: ['number', 'null'], description: 'Unread-entry count, null when the server did not report it.' },
      decision_topics: { type: 'array', items: { type: 'string' } },
      running_version: { type: 'string' },
      on_disk_version: { type: ['string', 'null'] },
      // gh#500: null when wake-path health is indeterminate (boolean|null source).
      wake_path_healthy: { type: ['boolean', 'null'] },
    },
    required: ['connected'],
  },
  'borg_assimilate': {
    type: 'object',
    properties: {
      reattached: { type: 'boolean' },
      cube_name: { type: 'string' },
      drone_label: { type: 'string' },
    },
    required: ['reattached', 'cube_name', 'drone_label'],
  },
  'borg_cube': {
    type: 'object',
    properties: {
      cube: {
        ...CUBE_OUTPUT,
        properties: { ...CUBE_OUTPUT.properties, message_taxonomy: { type: ['array', 'null'] } },
      },
      roles: { type: 'array', items: ROLE_OUTPUT },
    },
    required: ['cube', 'roles'],
  },
  'borg_role': {
    type: 'object',
    properties: {
      role: {
        ...ROLE_OUTPUT,
        properties: { ...ROLE_OUTPUT.properties, detailed_description: { type: 'string' } },
      },
    },
    required: ['role'],
  },
  'borg_docs': {
    type: 'object',
    properties: {
      topic: { type: ['string', 'null'] },
      matched: { type: 'boolean', description: 'True when the topic matched specific sections; false when the full index is returned.' },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
            title: { type: 'string' },
            url: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['slug', 'title', 'url', 'summary'],
        },
      },
    },
    required: ['topic', 'matched', 'sections'],
  },
  'borg_role-rationale': {
    type: 'object',
    properties: {
      role: { type: 'string' },
      section: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['role', 'section', 'body'],
  },
};

export const TOOL_MANIFEST: ToolManifestEntry[] = BASE_TOOL_MANIFEST.map((entry) => {
  const outputSchema = TOOL_OUTPUT_SCHEMAS[entry.name];
  return outputSchema ? { ...entry, outputSchema } : entry;
});
