/**
 * Remote HTTP client for api.borgmcp.ai
 *
 * Handles:
 * - HTTP requests to remote MCP server
 * - Automatic token injection
 * - Network failure handling with retry + exponential backoff
 * - Offline queue for pending operations
 */
import type { MessageTaxonomy, MessageTaxonomyClass } from 'borgmcp-shared/templates';
import { type WorkingRepo } from './working-repo.js';
export declare const API_URL: string;
export interface RemoteConnection {
    apiUrl: string;
    authToken: string;
    serverTrustIdentity?: string;
}
export declare const LOCAL_SERVER_RESPONSE_LIMIT_BYTES: number;
export declare const LOCAL_SERVER_REQUEST_TIMEOUT_MS = 5000;
/**
 * Parse a `Retry-After` header (delta-seconds form, which the worker
 * emits — mcp-server.ts:382/583) into milliseconds. Returns null when
 * absent or not a non-negative integer count of seconds. (The HTTP-date
 * form is not emitted by the worker, so it is intentionally unhandled.)
 */
export declare function parseRetryAfterMs(headerValue: string | null): number | null;
/**
 * How long to wait before the next 429 retry. Honors the server's
 * Retry-After when present (capped at `capMs` so a full-window reset
 * can't wedge a CLI call); falls back to an escalating 1s·(attempt+1)
 * when absent. Adds jitter (injected for tests) so co-located sibling
 * drones sharing one per-IP bucket don't retry in lockstep.
 */
export declare function rateLimitWaitMs(retryAfterMs: number | null, attempt: number, capMs?: number, jitter?: () => number): number;
export declare function extractHttpErrorMessage(body: string): string;
/**
 * Given an ALREADY-OBTAINED response, while it is a 429 and retries
 * remain, wait per `rateLimitWaitMs` (honoring the CURRENT response's
 * Retry-After) and THEN re-run `doRequest`. Takes `initialResponse`
 * (not a first request) because the caller has already made the request
 * and read its status — re-fetching first would ignore the first 429's
 * Retry-After and double-fire an immediate extra request (CR blocker
 * d3a564f5). Returns the last Response (200-class on success, or a final
 * 429 if retries exhaust — the caller surfaces that). `sleep` is
 * injected for deterministic tests; no fetch-global mocking required.
 */
export declare function retryOn429(initialResponse: Response, doRequest: () => Promise<Response>, opts: {
    maxRetries?: number;
    capMs?: number;
    sleep: (ms: number) => Promise<void>;
    jitter?: () => number;
    log?: (msg: string) => void;
}): Promise<Response>;
/**
 * Get valid auth token (refreshes if expired).
 *
 * Exported so the SSE log-stream consumer (`src/log-stream.ts`)
 * can attach the same Bearer header that `authedFetch` uses for REST,
 * without duplicating the refresh-token plumbing.
 */
export declare function getValidToken(): Promise<string>;
/**
 * gh#794: the stored session's state, WITHOUT throwing — powers `borg setup`'s
 * short-circuit (SR#3: short-circuit ONLY on `valid`, never past a dead token).
 */
export type SessionState = 'valid' | 'dead' | 'transient';
/**
 * gh#794: classify the stored session into valid | dead | transient.
 *
 * ⚠ EFFECTFUL — NOT a read-only probe. The expired branch ATTEMPTS a refresh,
 * which on success PERSISTS the new id_token (via refreshIdToken → storeIdToken,
 * AES-256-GCM-re-encrypted) and on a dead refresh_token `clearTokens()`s. So a
 * `valid` result may have just refreshed-and-stored the session. `clearTokens`
 * fires ONLY on `dead` (RefreshTokenInvalidError / invalid_grant), NEVER on
 * `transient` — a network blip must not nuke a valid keychain (gh#34 invariant).
 *
 *   - cached id_token still valid (outside the config.ts 5-min buffer) → 'valid'
 *   - expired/within-buffer + refresh succeeds → 'valid' (refreshed + persisted)
 *   - expired + RefreshTokenInvalidError → 'dead' (cleared — re-auth needed)
 *   - expired + RefreshTransientError / unknown → 'transient' (keychain intact)
 *   - no refresh_token at all → 'dead' (never set up / already cleared)
 */
export declare function probeSession(): Promise<SessionState>;
/**
 * Connect this client as a Drone to a Cube.
 *
 * Returns the cube definition, the drone's assigned role (with full
 * detailed_description), the drone record, and an opaque session token
 * the caller is expected to persist via cubes.ts.
 */
export declare function assimilate(cubeNameOrSelector: string | {
    cube_id?: string;
    cube_name?: string;
    role_id?: string;
    role_name?: string;
    prior_drone_id?: string;
    model?: string | null;
}, apiUrl?: string, hostname?: string | null, agentKind?: 'claude' | 'codex' | 'opencode' | null, authToken?: string, serverTrustIdentity?: string): Promise<{
    cube: {
        id: string;
        owner_id: string;
        name: string;
        cube_directive: string;
        created_at: string;
        updated_at: string;
    };
    role: {
        id: string;
        cube_id: string;
        name: string;
        short_description: string;
        detailed_description: string;
        is_default: boolean;
        is_mandatory: boolean;
        is_human_seat: boolean;
        role_class: 'queen' | 'worker';
        created_at: string;
    };
    drone: {
        id: string;
        cube_id: string;
        role_id: string;
        label: string;
        last_seen: string;
        hostname: string | null;
        created_at: string;
    };
    sessionToken: string;
    reattached?: boolean;
}>;
/**
 * Get the active cube's directive + role registry.
 */
export declare function getCubeInfo(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<{
    cube: any;
    roles: any[];
}>;
/**
 * Get this drone's assigned role (with detailed_description).
 */
export declare function getRoleInfo(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<{
    role: any;
}>;
/**
 * Get a named role's full playbook (detailed_description). Any drone in
 * the cube may read any role. `role` is a role name (case-insensitive)
 * or role id.
 */
export declare function getRoleInfoByName(sessionToken: string, apiUrl: string, role: string, serverTrustIdentity?: string): Promise<{
    role: any;
}>;
export declare function whoami(sessionToken: string, apiUrl: string, serverTrustIdentity?: string): Promise<{
    cube_id: string;
    cube_name: string;
    drone_id: string;
    drone_label: string;
    role_id: string;
    role_name: string;
}>;
/**
 * List all currently-connected drones in this cube.
 *
 * Optional `since` is the T2.1 sender-side liveness probe — pass either
 * an activity_log entry id (UUID; server resolves to its `created_at`)
 * OR an ISO-8601 timestamp. When provided, the response includes:
 *   - per-drone `seen_since: boolean` — true iff that drone's
 *     `last_seen` is strictly after the resolved timestamp
 *   - top-level `since: ISO-string | null` — the resolved timestamp
 *     (echoed back so the renderer can label the column accurately
 *     even when the caller passed an entry-id)
 */
export declare function getRoster(sessionToken: string, apiUrl: string, since?: string, serverTrustIdentity?: string): Promise<{
    drones: any[];
    roles: any[];
    message_taxonomy?: MessageTaxonomy | null;
    since?: string | null;
}>;
/**
 * Read recent log entries for the cube.
 */
export declare function readLog(sessionToken: string, apiUrl: string, opts?: {
    since?: string;
    limit?: number;
    unreadOnly?: boolean;
    serverTrustIdentity?: string;
}): Promise<{
    entries: any[];
    drones: any[];
    roles: any[];
    behind_by?: number;
    has_more?: boolean;
}>;
/**
 * Sprint 25 log substrate refactor: explicit ack on a log entry.
 *
 * Replaces in-band `ACK: <dispatch-id>` log entries with a DB-backed
 * flag on activity_log_acks. Idempotent — the server INSERT uses ON
 * CONFLICT DO NOTHING. 204 No Content on success.
 */
export declare function ackLogEntry(sessionToken: string, apiUrl: string, entryId: string, kind?: 'ack' | 'claim', serverTrustIdentity?: string): Promise<void>;
/**
 * gh#740: record a ratified cube decision (seat-holder only — the worker
 * enforces the seat gate). Supersedes the active decision on the same topic.
 */
export declare function recordDecision(sessionToken: string, apiUrl: string, input: {
    topic: string;
    decision: string;
    rationale?: string;
}, serverTrustIdentity?: string): Promise<{
    decision: any;
}>;
/**
 * gh#740: list active ratified decisions for the cube (any member). With
 * `topic`, returns that topic's active decision.
 */
export declare function listDecisions(sessionToken: string, apiUrl: string, topic?: string, serverTrustIdentity?: string): Promise<{
    decisions: any[];
}>;
/** Remove one active ratified decision. The worker enforces the seat gate. */
export declare function removeDecision(sessionToken: string, apiUrl: string, selector: {
    topic: string;
} | {
    decision_id: string;
}, serverTrustIdentity?: string): Promise<{
    decision: any;
}>;
/**
 * Regen: one-shot composite of everything a drone needs to be oriented.
 *
 * Returns the active cube's directive, the drone's own role with full
 * detailed_description, the public role registry (no detailed_description
 * leakage for OTHER roles), the drone roster, and the caller's unread-log
 * COUNT (behind_by). gh#886: the recent-log PAYLOAD is no longer rendered
 * client-side — the drone gets the count and drains via borg_read-log. Use
 * on session start and before each new task to stay in sync.
 *
 * gh#29 Sprint C / Q3a: optional `since` cursor (entry-id UUID or
 * ISO-8601 timestamp). The worker still ships `recentLog` for rollout-compat
 * (a pre-gh#886 client renders it; `since` trims it to entries strictly after
 * the anchor) — but the current client renders the unread COUNT, not the
 * payload, so `since` no longer affects what this client shows.
 */
export declare function regen(sessionToken: string, apiUrl: string, opts?: {
    since?: string;
    /** Advisory self-report from the running agent; never model-routing config. */
    reportedModel?: string;
    /** Current cwd-derived identity; refreshed each regen to avoid stale routing data. */
    workingRepo?: WorkingRepo;
    /** Verified self-hosted authority from the caller's first active-state read. */
    serverTrustIdentity?: string;
}): Promise<{
    cube: any;
    role: any;
    drone: any;
    roles: any[];
    drones: any[];
    recentLog?: any[];
    behind_by?: number;
}>;
export declare function roleRationale(sessionToken: string, apiUrl: string, role: string, section: string, serverTrustIdentity?: string): Promise<{
    role: string;
    section: string;
    body: string;
}>;
/**
 * Append a message to the cube's shared activity log.
 */
export declare function appendLog(sessionToken: string, apiUrl: string, message: string, opts?: {
    visibility?: 'broadcast' | 'direct';
    recipientDroneIds?: string[];
    class?: string;
    to?: string[];
    serverTrustIdentity?: string;
}): Promise<{
    entry: {
        id: string;
        cube_id: string;
        drone_id: string;
        message: string;
        visibility: 'broadcast' | 'direct';
        created_at: string;
    };
    routing?: {
        class: string | null;
        recipients: string[];
        fellOpen: boolean;
        message: string | null;
    } | null;
    unreachableRecipients?: {
        id: string;
        label: string;
    }[];
}>;
/**
 * gh#716 — submit a friction/bug report to the borgmcp dev team (borg_report-friction).
 * WRITE-ONLY: the caller never reads reports back. The server scrubs secrets before
 * persist and stamps reporter_user_id from the authenticated session (never client input).
 * Drone-session authed (POST /api/drone/report). Opaque `{ ok: true }` response.
 */
export declare function submitReport(sessionToken: string, apiUrl: string, input: {
    kind?: 'friction' | 'bug';
    message: string;
    metadata?: Record<string, string>;
}): Promise<{
    ok: boolean;
}>;
export interface TriageReport {
    id: string;
    kind: 'friction' | 'bug';
    message: string;
    metadata: Record<string, string> | null;
    redacted: boolean;
    created_at: string;
    reporter_email: string;
}
/**
 * gh#956: read counterpart to submitReport — fetch friction/bug reports for
 * triage. OAuth-only (mirrors listCubes; not cube-scoped). The server gates
 * non-builder callers with 403, surfaced here as `{ forbidden: true }` so the
 * tool can show a clear tier message instead of throwing.
 */
export declare function fetchReports(): Promise<{
    forbidden: true;
} | {
    forbidden: false;
    reports: TriageReport[];
}>;
/**
 * List all cubes owned by the authenticated user. Owner-scoped via the
 * Bearer token alone; no drone session needed.
 */
export declare function listCubes(connection?: RemoteConnection): Promise<{
    cubes: any[];
}>;
/**
 * List bundled cube templates. Used by the `borg assimilate` orchestrator
 * to surface the interactive template prompt on first-drone bootstrap.
 */
export declare function listTemplates(connection?: RemoteConnection): Promise<{
    templates: Array<{
        name: string;
        description: string;
        roles: any[];
    }>;
}>;
/**
 * Create a new cube. Server-side seeds a default "Drone" role atomically
 * so the cube is assimilatable immediately, OR applies the named template
 * atomically when `opts.template` is set (single-withUserId transaction —
 * skips the auto-Drone insert to avoid is_default partial-index conflict).
 *
 * Returns `{ cube, roles }` — the roles array lets the assimilate
 * orchestrator pick a default role without a follow-up `getCube` call.
 * Existing callers that read `body.cube` keep working (forward-compat).
 */
export declare function createCube(name: string | undefined, cubeDirective: string, opts?: {
    template?: string;
    message_taxonomy?: MessageTaxonomy | null;
}, connection?: RemoteConnection): Promise<{
    id: string;
    name: string;
    cube_directive?: string;
    roles: any[];
    drones?: any[];
    [k: string]: any;
}>;
/**
 * Update a cube's name and/or cube_directive. Both fields are optional;
 * pass only what changes.
 */
export declare function updateCube(cubeId: string, updates: {
    name?: string;
    cube_directive?: string;
    message_taxonomy?: MessageTaxonomy | null;
}): Promise<{
    cube: any;
}>;
/**
 * gh#473 PR1 — granular per-class taxonomy patch. Add / replace-by-name
 * / remove a single class within the cube's message_taxonomy, leaving
 * other classes unchanged. The worker re-validates the FULL resulting
 * array (cross-class invariants) before persist. Owner-scoped via the
 * Bearer token.
 */
export declare function patchTaxonomyClass(cubeId: string, op: {
    action: 'add';
    class_def: MessageTaxonomyClass;
} | {
    action: 'replace';
    class_def: MessageTaxonomyClass;
} | {
    action: 'remove';
    class: string;
}): Promise<{
    cube: any;
}>;
/**
 * Delete a cube. Cascade-deletes all roles, drones, and log entries.
 * Owner-scoped via the Bearer token; the worker enforces ownership.
 */
export declare function deleteCube(cubeId: string): Promise<void>;
/**
 * Create a role inside a cube. is_default=true demotes the previous
 * default role; the cube always has exactly one default.
 */
export declare function createRole(cubeId: string, data: {
    name: string;
    short_description: string;
    detailed_description: string;
    is_default?: boolean;
    is_mandatory?: boolean;
    is_human_seat?: boolean;
    can_broadcast?: boolean;
    receives_all_direct?: boolean;
    default_model?: string;
    role_class?: 'queen' | 'worker';
}): Promise<{
    role: any;
}>;
/**
 * Update a role. All fields optional; pass only what changes.
 */
export declare function updateRole(roleId: string, updates: {
    name?: string;
    short_description?: string;
    detailed_description?: string;
    is_default?: boolean;
    is_mandatory?: boolean;
    is_human_seat?: boolean;
    can_broadcast?: boolean;
    receives_all_direct?: boolean;
    default_model?: string;
    role_class?: 'queen' | 'worker';
}): Promise<{
    role: any;
}>;
/**
 * gh#473 PR1 — granular role-text section patch. Replace / insert /
 * delete a single named section of a role's detailed_description,
 * leaving the rest of the field byte-identical. Owner-scoped via the
 * Bearer token. Sections are delimited by plain-label lines (e.g.
 * `Workflow:`), NOT markdown headings.
 */
export declare function patchRoleSection(roleId: string, op: {
    action: 'replace';
    heading: string;
    body: string;
} | {
    action: 'insert';
    heading: string;
    body: string;
    after?: string | null;
} | {
    action: 'delete';
    heading: string;
}): Promise<{
    role: any;
}>;
/**
 * Delete a role. Worker refuses if any drone is still assigned to it
 * (reassign or evict those drones first).
 */
export declare function deleteRole(roleId: string): Promise<void>;
/**
 * Reassign a drone to a different role within the same cube.
 * Queen-class seat cardinality is enforced server-side — attempting
 * to assign to a queen-class role when another drone already holds
 * the seat returns an error. The class-hierarchy guard also rejects
 * direct promotion from non-human-seat roles.
 */
export declare function reassignDrone(droneId: string, roleId: string): Promise<{
    drone: any;
}>;
/**
 * Evict (soft-delete) a drone from its cube (gh#718). Owner-authed via the
 * Bearer token, exactly like reassignDrone — the worker's `DELETE
 * /api/drones/:id` route scopes the delete to cubes the caller owns
 * (CubeStore.evictDrone RLS owner-scope), so a non-owner can never evict
 * another account's drone. The drone row is preserved with `evicted_at` set
 * and its activity-log attribution anonymized; the route returns 204 No
 * Content (no body).
 */
export declare function evictDrone(droneId: string): Promise<void>;
/**
 * Fetch a cube's full detail: directive, roles (with detailed
 * descriptions), and drones. Accessible to owners and active members via
 * the Bearer token; no drone session needed.
 */
export declare function getCube(cubeId: string, connection?: RemoteConnection): Promise<{
    id: string;
    name: string;
    roles: any[];
    drones: any[];
    [k: string]: any;
}>;
/**
 * gh#473 PR2 — apply a named template to an existing cube via the
 * NON-CLOBBERING server route. New roles are inserted; existing
 * template-named roles get ADD fragments auto-applied (template
 * sections/classes the cube lacks) but their EVOLVED (conflicting)
 * fragments are surfaced server-side and KEPT, never overwritten. Returns
 * `{ created, updated }` counts. To selectively take template versions of
 * conflicting fragments, use `syncRoles` with a `decisions` map instead.
 */
export declare function applyTemplate(cubeId: string, templateName: string): Promise<{
    created: number;
    updated: number;
}>;
/**
 * Check subscription status
 */
export declare function checkSubscriptionStatus(): Promise<any>;
/**
 * gh#473 PR2 — NON-CLOBBERING sync of a cube's roles + message_taxonomy
 * against the current built-in template. Dry-run by default classifies
 * each fragment (role-text SECTION / short_description / flags / taxonomy
 * CLASS) as ADD / UNCHANGED / CONFLICT. Pass apply=true to commit:
 * ADD fragments auto-apply (zero clobber risk); CONFLICT fragments apply
 * ONLY when their stable key appears in `decisions` as 'accept'.
 * Unspecified conflicts DEFAULT TO REJECT — the cube's evolved text is
 * never silently overwritten. Custom roles (names not in template) are
 * never touched. Returns a NonClobberSyncResult.
 */
export declare function syncRoles(cubeId: string, templateName?: string, apply?: boolean, decisions?: Record<string, 'accept' | 'reject'>): Promise<any>;
/**
 * Create subscription (returns checkout URL)
 */
export declare function createSubscription(): Promise<string>;
export declare function createBillingPortalSession(): Promise<string>;
//# sourceMappingURL=remote-client.d.ts.map