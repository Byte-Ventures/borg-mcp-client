/**
 * Pure renderer for the `borg_roster` MCP tool output.
 *
 * Split out from `index.ts` so the T2.1 sender-side liveness probe
 * (the `awake`/`stale-since-X` column rendering when a `since` arg is
 * passed) can be unit-tested without spinning up the MCP server. Same
 * pure-function + injected-`humanAgo` pattern as `stream-status.ts`.
 *
 * Two modes:
 *   - No `since` provided: classic roster — one line per drone with
 *     label, role, and `last seen` relative time.
 *   - `since` provided: each line additionally carries an `awake`
 *     marker if the drone's `last_seen` is after the resolved
 *     timestamp, otherwise a `stale-since-<relative>` marker derived
 *     from the resolved timestamp the server echoed back.
 */
export declare const RUNTIME_METADATA_ADVISORY = "Agent CLI, reported model, and working repository are advisory. They do not determine authority, role, health, activity, wake behavior, or routing.";
export interface RosterDrone {
    id?: string;
    label: string;
    role_id: string;
    last_seen: string | Date;
    /** Only present when the request carried `since`. */
    seen_since?: boolean;
    /**
     * gh#370 — which AI agent is running this drone. Null for drones that
     * joined before the column existed or via a launcher path that didn't
     * forward the kind. This is the agent CLI, not a model descriptor.
     */
    agent_kind?: 'claude' | 'codex' | 'opencode' | null;
    regen_count?: number | null;
    wake_path?: 'live' | 'degraded' | 'deaf' | null;
    wake_path_alert_class?: 'dead' | 'post-blocked' | 'presumed-dead' | 'systemic-post-block' | 'wake-path-deaf' | 'independent' | null;
    /** Legacy launch descriptor retained on the wire for the Ollama launch path; not displayed. */
    model?: string | null;
    /** Advisory model string self-reported by the agent on regen. */
    reported_model?: string | null;
    /** Current cwd-derived repository identity, refreshed on regen. */
    working_repo_name?: string | null;
    working_repo_origin?: string | null;
    runtime_metadata_reported?: boolean;
}
export interface RosterRole {
    id: string;
    name: string;
    /**
     * Default model descriptor for drones assigned to this role.
     * Null = no role default (use cube default or null for Claude).
     */
    default_model?: string | null;
}
export declare function formatRoleAgentLabel(roleName: string, agentKind: RosterDrone['agent_kind']): string;
export declare function formatWorkingRepoLabel(drone: Pick<RosterDrone, 'working_repo_name' | 'working_repo_origin'>): string;
export declare function renderRuntimeMetadataLines(drone: RosterDrone, opts?: {
    includeOrigin?: boolean;
}): string[];
export interface RenderRosterInputs {
    cubeName: string;
    drones: RosterDrone[];
    roles: RosterRole[];
    /**
     * Server-echoed resolved timestamp (ISO-8601). Present iff caller
     * passed `since` to `borg_roster`. Drives both the column header copy
     * AND the relative-time label on `stale-since-X` cells.
     */
    resolvedSince: string | null;
    /** Relative-time formatter, injected so the renderer is pure. */
    humanAgo: (d: Date | string) => string;
}
export declare function renderRoster(inputs: RenderRosterInputs): string;
//# sourceMappingURL=roster-render.d.ts.map