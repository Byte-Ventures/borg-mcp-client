/**
 * Shared formatting helpers used by both the MCP `borg_regen` handler in
 * index.ts and the standalone `borg-regen` CLI in regen.ts.
 *
 * Lives in its own module so regen.ts can import these without pulling in
 * index.ts's stdio MCP server bootstrap.
 */
/**
 * Extract the SessionStart `source` from a Claude Code hook payload (gh#926).
 *
 * SessionStart hooks receive a JSON object on stdin whose `source` field is
 * one of `startup` / `resume` / `clear` / `compact`. The `borg-regen`
 * SessionStart hook uses this to detect a `/clear` re-orientation, which is
 * the FIRST time the hook is the SOLE orientation path (the launch kickoff
 * prompt is gone) AND the moment Claude Code clears the session-scoped
 * `/loop` + `ScheduleWakeup` — so the re-injected orientation must instruct
 * an operational re-arm.
 *
 * Best-effort + total: empty input (manual / TTY run with no stdin),
 * malformed JSON, a missing `source`, or a non-string `source` all return
 * `null` so the caller falls back to the default (full-regen) behavior. A
 * hook bin must never throw on unexpected stdin.
 */
export declare function parseHookSource(raw: string): string | null;
/** The agent runtime a session runs under — drives the wake-path branch. */
export type AgentKind = 'claude' | 'codex' | 'opencode';
/**
 * The agent-branched WAKE-PATH ARMING sub-block (gh#929/gh#927) — the single
 * shared "re-establish your wake path" instruction reused by the launch
 * kickoff prompt, the lean SessionStart-hook orientation, and the /clear
 * re-orient. Factored to ONE place so the most load-bearing (and most
 * drift-prone) liveness instruction can never diverge across the three
 * surfaces.
 *
 * Agent-branched on the existing env-agnostic signal (BORG_SESSION-style
 * `isCodexRemoteWakeEnabled`), NOT on a mutable server-recorded field:
 * - claude: arm the inbox-file tail Monitor + engage `/loop` + maintain one
 *   adaptive `ScheduleWakeup` recovery deadline (long while the Monitor is
 *   healthy or indeterminate; short only while explicitly broken).
 * - codex: Borg's activity stream reaches the app-server remote-control inbox
 *   channel; each wake is followed by an unread-log drain. Manual full regen
 *   + drain is a degraded fallback when remote control is unavailable.
 *
 * `inboxPath` is the deterministic client-generated UUID path
 * (`~/.config/borgmcp/inboxes/<cubeId>/<droneId>.log`), while the optional
 * explicit state root is derived from the saved worktree path. Both are
 * shell-escaped before rendering the launch/orientation command.
 */
export declare function wakePathArming(agentKind: AgentKind, inboxPath: string, monitorStateRoot?: string | null): string;
/**
 * Resolve the lean-orientation identity (gh#927), preferring the fresh
 * network `regen()` result and falling back per-field to the local
 * `getActiveCube` state. When `result` is null — the net-free fallback path
 * taken on a `regen()` network failure — identity comes entirely from local
 * state, so a weak drone that hits a SessionStart network blip still gets
 * oriented (with its wake-path arming) instead of left dormant.
 */
export declare function resolveLeanIdentity(active: {
    name: string;
    droneLabel: string;
    roleName?: string | null;
}, result: {
    cube?: any;
    drone?: any;
    role?: any;
} | null): {
    cubeName: string;
    droneLabel: string;
    roleName: string | null;
};
/**
 * The canonical LEAN orientation core (gh#929/gh#927) — the single shared
 * "minimal operational orientation" rendered for a drone at launch, on every
 * SessionStart source (startup/resume/clear/compact), and on /clear. It
 * SUPERSEDES the per-surface variants: the SessionStart hook renders this
 * instead of the full ~20.7KB `formatRegenMarkdown` (which the harness
 * truncates to a ~2KB preview, leaving weak models partially oriented), and
 * the /clear re-orient is just this with `source: 'clear'`.
 *
 * Three load-bearing parts, all kept (per the SEC/PM/CR rails):
 * - IDENTITY: cube + drone label + role, so a weak model knows who it is.
 * - WAKE-PATH ARMING: the shared `wakePathArming` block (liveness — correct
 *   to carry pre-`borg_regen`).
 * - `borg_regen` POINTER: the path to the full operating context and safety
 *   floor. Role-specific lifecycle guidance remains reachable through the
 *   role-text pointer. Kept in EVERY render.
 *
 * Template-agnostic (#921): the escalation target is "your cube's coordinating
 * role" — NEVER a hardcoded `coordinator` / `drone-1` (this is the
 * single most-rendered instruction surface in the product, and the first
 * thing a weak model on a NON-sw-dev template reads). `roleName` is optional
 * so the net-free fallback can render from local `getActiveCube` state when a
 * `regen()` network call is unavailable.
 */
export declare function formatLeanOrientation(args: {
    cubeName: string;
    droneLabel: string;
    roleName?: string | null;
    inboxPath: string;
    /** Explicit worktree-local root for Claude monitor PID/heartbeat state. */
    monitorStateRoot?: string | null;
    agentKind: AgentKind;
    source?: string | null;
}): string;
/**
 * Build the universal drone playbook.
 *
 * The playbook is appended to every regen / cube / assimilate response.
 * Including it on every refresh is intentional: it protects against
 * /compact and /clear losing the procedural knowledge while state still
 * flows through.
 *
 * The playbook describes the autonomous-default behavior shared by every
 * role. Role-specific overrides (e.g., "consult the human Queen" for the
 * Coordinator role; "ship on consensus" for the Queen role when the seat
 * is delegated to a drone) live in each role's detailed_description, not
 * here.
 */
export declare function getDronePlaybook(): string;
/**
 * Eager export of the playbook text. Cheap to compute (string concat);
 * exporting as a constant lets callers splice it directly without a
 * function call site.
 */
export declare const DRONE_PLAYBOOK: string;
/**
 * gh#912: the verbose operating-discipline DETAIL externalized out of the
 * bootstrap regen into an on-demand chapter (fetched via the borg_playbook
 * tool). The inline core (getDronePlaybook) keeps the rule-spine + triggers +
 * forcing-functions + safety; this chapter carries the WHY, the per-level
 * sharpening, the concrete surfaces, and the four-surface propagation that a
 * drone only needs when doing review/verify-class work. Static text.
 */
export declare function getDronePlaybookChapter(): string;
/**
 * Format an absolute timestamp as a coarse "Xs/Xm/Xh ago" string.
 */
export declare function humanAgo(date: Date | string): string;
/**
 * Format a regen() composite into the markdown text shown to drones.
 *
 * The playbook is always appended. The token cost is bounded (~500 tokens),
 * but the risk of a drone losing the playbook to /compact or /clear and
 * being left with state but no procedural knowledge is unbounded. Always
 * include — robustness wins.
 */
/**
 * gh#479 — discoverability tip for intent-based routing (#468). When a
 * cube has no `message_taxonomy` declared, borg_regen + borg_cube append
 * this tip so operators discover how to enable smart routing. Self-
 * removing: returns '' once a taxonomy exists. Copy is UX-locked
 * (design d45098c1) — keep verbatim.
 */
export declare function nullTaxonomyTip(messageTaxonomy: unknown): string;
export declare function regenWakePathDroneLabel(result: {
    drone?: {
        label?: string | null;
    };
}, cachedDroneLabel: string | null | undefined): string | null;
export type RegenMode = 'full' | 'lite';
export declare function __resetRegenSessionState(): void;
export declare function formatRationalePointer(role: string, section: string): string;
export declare function parseRationalePointer(stub: string): {
    role: string;
    section: string;
} | null;
/**
 * gh#496-A(b) — compress a role's `detailed_description` for rendering.
 *
 * Splits the role text into sections (via the client port of the worker's
 * `parseRoleSections`, parity-guarded) and replaces each `… rationale:`
 * plain-label section's BODY with a one-line on-demand stub
 * (`formatRationalePointer(role, heading)` verbatim — heading sans colon).
 * Every other section — preamble, operational-rule sections, and ALL woven
 * safety-discipline text — is emitted INLINE, fetch-free. No content is lost:
 * `getRoleRationale(role, heading)` serves the full section on demand, so
 * core-inline + Σ(every stub resolved) reconstructs the stored text.
 *
 * ⛔ SAFETY-NEVER-COMPRESS: a section is stubbed ONLY when (a) its heading,
 * sans-colon/trimmed/lowercased, ends with `rationale`, AND (b) its body
 * contains NONE of `ALL_SAFETY_DISCIPLINES`. Any ambiguity (a safety string
 * present, or simply not a `rationale:` heading) fails safe to INLINE — a
 * wrongly-compressed LIVE rule is the catastrophic mode, so we over-include.
 */
export declare function compressRoleText(roleName: string, detailedDescription: string | null | undefined): string;
export declare function formatRegenMarkdown(result: {
    cube: any & {
        directive_hash?: string | null;
    };
    role: any & {
        detailed_description_hash?: string | null;
    };
    drone: any;
    roles: any[];
    drones: any[];
    recentLog?: any[];
    behind_by?: number;
    decisions?: any[];
}, opts?: {
    mode?: RegenMode;
}): string;
export declare function formatLogEntryMarkdown(entry: any, droneById: Map<string, any>, roleById: Map<string, any>): string;
//# sourceMappingURL=regen-format.d.ts.map