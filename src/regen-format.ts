/**
 * Shared formatting helpers used by both the MCP `borg_regen` handler in
 * index.ts and the standalone `borg-regen` CLI in regen.ts.
 *
 * Lives in its own module so regen.ts can import these without pulling in
 * index.ts's stdio MCP server bootstrap.
 */

import {
  ROLE_SCOPED_SAFETY_DISCIPLINES,
  UNIVERSAL_SAFETY_DISCIPLINES,
} from 'borgmcp-shared/templates';
import { parseRoleSections } from 'borgmcp-shared/role-section';
import { formatRoleAgentLabel } from './roster-render.js';
import { formatDroneAddressToken } from 'borgmcp-shared/drone-address';
import { shellEscape } from './shell-escape.js';

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
export function parseHookSource(raw: string): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    const source = parsed?.source;
    return typeof source === 'string' ? source : null;
  } catch {
    return null;
  }
}

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
export function wakePathArming(
  agentKind: AgentKind,
  inboxPath: string,
  monitorStateRoot?: string | null
): string {
  if (agentKind === 'codex') {
    return [
      'Required Codex wake path: Borg activity stream → inbox wake channel via app-server remote control.',
      'On every wake, run `borg_read-log unread_only=true` and drain until caught up.',
      'No additional scheduler setup is required.',
      'Degraded fallback (only if remote control is unavailable): on return, call `borg_regen mode="full"` and drain unread log.',
    ].join(' ');
  }
  if (agentKind === 'opencode') {
    return (
      'Wake path: OpenCode wakes via SDK-driven entry injection into the TUI session — ' +
      'there is no tail-Monitor or `/loop` heartbeat to arm. Cube posts are delivered ' +
      'directly into your active session. Use \`borg_regen\` at any time for fresh context.'
    );
  }
  const monitorCommand = monitorStateRoot
    ? `borg-inbox-monitor --state-root ${shellEscape(monitorStateRoot)} ${shellEscape(inboxPath)}`
    : `borg-inbox-monitor ${shellEscape(inboxPath)}`;
  return [
    'Arm your wake path before working:',
    `1. **Inbox Monitor** (wake path) — run a persistent Monitor on \`${monitorCommand}\` so cube posts wake you in real time.`,
    '2. **Engage `/loop`** (self-paced) so you keep waking to triage the cube.',
    '3. **Adaptive recovery deadline** — after wake/triage, set ONE `ScheduleWakeup`: [9000, 12600]s (3h ±30m) when Monitor is healthy or indeterminate; [720, 1080]s (15m ±3m) only when explicitly broken. Re-arm Monitor; retry short until healthy. A real Monitor wake resets—not stacks—it.',
    '4. **Recovery tick** — drain `borg_read-log unread_only=true` first. If empty, do not full-regen or make a liveness post: check wake status, set the deadline, resume prior work. This reduces client fallback churn; safety probes may still wake.',
  ].join('\n');
}

/**
 * Resolve the lean-orientation identity (gh#927), preferring the fresh
 * network `regen()` result and falling back per-field to the local
 * `getActiveCube` state. When `result` is null — the net-free fallback path
 * taken on a `regen()` network failure — identity comes entirely from local
 * state, so a weak drone that hits a SessionStart network blip still gets
 * oriented (with its wake-path arming) instead of left dormant.
 */
export function resolveLeanIdentity(
  active: { name: string; droneLabel: string; roleName?: string | null },
  result: { cube?: any; drone?: any; role?: any } | null
): { cubeName: string; droneLabel: string; roleName: string | null } {
  return {
    cubeName: result?.cube?.name ?? active.name,
    droneLabel: result?.drone?.label ?? active.droneLabel,
    roleName: result?.role?.name ?? active.roleName ?? null,
  };
}

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
export function formatLeanOrientation(args: {
  cubeName: string;
  droneLabel: string;
  roleName?: string | null;
  inboxPath: string;
  /** Explicit worktree-local root for Claude monitor PID/heartbeat state. */
  monitorStateRoot?: string | null;
  agentKind: AgentKind;
  source?: string | null;
}): string {
  const { cubeName, droneLabel, roleName, inboxPath, monitorStateRoot, agentKind, source } = args;
  const clearNote =
    source === 'clear'
      ? agentKind === 'codex'
        ? '\n_(`/clear` cleared your conversation; Codex remote-control wake remains active. Follow the required Codex wake path below.)_\n'
        : agentKind === 'claude'
          ? [
              '\n_(`/clear` cleared Claude\'s `/loop` and recovery deadline — re-arm them now.)_',
              '_Quiet-clear fallback: if a later turn follows silence, inspect `borg_stream-status` + `borg_roster`; call `borg_regen mode="full"`, drain `borg_read-log unread_only=true`, then re-arm Monitor, `/loop`, and the recovery deadline._\n',
            ].join('\n')
          : ''
      : '';
  return [
    `# Cube: ${cubeName} — ${droneLabel}`,
    '',
    `**Your role:** ${roleName || '_(call `borg_regen` to load)_'}`,
    clearNote,
    'You are a Borg drone — coordinate through the cube log, and never pause for the user. Blocked → escalate to your cube\'s coordinating role.',
    '',
    wakePathArming(agentKind, inboxPath, monitorStateRoot),
    '',
    'REQUIRED BEFORE ACTING OR POSTING: (1) call `borg_regen mode="full"`; (2) load the cube directive and conventions with `borg_cube`; (3) ensure your own role playbook/details are loaded — full regen normally supplies them, but call `borg_role` if missing or after compaction; (4) load `borg_playbook` once per session for the complete operating disciplines. Do not proceed until all four are in context. This orientation stays lean and does not inline them. If you know this session\'s model, include `model="<model-id>"` in the initial full regen for advisory roster metadata.',
    '',
  ].join('\n');
}

// gh#927 S3: formatClearReorientation (gh#926) is SUPERSEDED by the shared
// formatLeanOrientation core — the /clear case is now just
// formatLeanOrientation({ ..., source: 'clear' }), so the per-surface
// /clear block is gone (one place, not three).

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
// copy-param-claim: borg_ack.kind
//   The drone playbook below recommends `borg_ack ... kind=claim` to claim a
//   review gate; this inline marker pins the param so the #490/#529 copy↔
//   mechanism guard verifies borg_ack actually exposes `kind`
//   (client/__tests__/copy-mechanism-guard.test.ts).
// copy-param-claim: borg_docs.topic
//   The playbook below points drones to `borg_docs {topic}` for user questions
//   about how Borg MCP works; this marker pins the param so the #490/#529 guard
//   verifies borg_docs exposes `topic`.
export function getDronePlaybook(): string {
  return `## How to operate as a Drone

You're a Drone in a Cube. Coordinate with other drones through the activity log.

**User asks how Borg MCP works** — a feature, setup, pricing, or concept question? Call \`borg_docs {topic}\` for the documentation index, then WebFetch the matching section URL and answer from the page. Don't guess borgmcp's own behavior from memory.

**Tools:**
- \`borg_regen\` — refresh full state (your role, roster, unread-log COUNT, and fetch-on-demand pointers) in one call; the cube directive (→ \`borg_cube\`), the operating-playbook detail (→ \`borg_playbook\`), and the recent-log payload (→ \`borg_read-log\` when count >0) are NOT inlined — fetch them on demand
- \`borg_cube\` — re-read the cube directive and the role overview
- \`borg_role\` — re-read your role's detailed playbook
- \`borg_roster\` — see who else is connected
- \`borg_read-log unread_only=true [limit]\` — drain unread log entries from your server-side cursor
- \`borg_log <message>\` — append to the log
- \`borg_assimilate <cube>\` — switch to a different cube

**How coordination works:** the Cube gives primitives, not workflows. Your role's \`detailed_description\` (above) is your playbook — its conventions + signals come from there, not the system. The log is the coordination channel. Different cubes, different conventions.

**Default: act autonomously, coordinate through the log.** Don't wait for user input. Need input → post the question, continue other work, other drones respond. The human supervisor is reachable through your cube's coordinating / human-seat role (the role your cube designates for direction + integration), or the Queen role when the seat is delegated to a drone — one continuous seat. Your role's \`detailed_description\` says when to escalate + which decisions need human input; follow it.

**Operating loop — each wake, in order:**
1. Drain unread: \`borg_read-log unread_only=true\` (oldest-first, repeat until \`behind_by=0\`) before acting. The "Cube log" section gives your UNREAD COUNT.
2. Apply your role's conventions to each entry. Act on: questions you can answer; blocked peers you can unblock; unowned work you can claim; decisions affecting you.
3. Actionable signal → act + post the convention. Don't wait to be asked.
4. User prompt waiting → respond, informed by cube context; log substantive units (shipped changes, blockers, findings) regardless of who initiated.
5. Nothing actionable + no prompt → done; wait for next wake.

**On a \`<task-notification>\` wake:** the payload is a truncatable preview; the full entry is in the DB. Drain: \`borg_read-log unread_only=true limit=20\`, repeat until \`behind_by=0\`. Do NOT triage with \`since=<notification timestamp>\` (strict-after — skips the boundary entry) or a bare window (skips older-unread during bursts).

**On first wake this session:** post one \`ARRIVAL: <your-label> (<your-role>) online on <hostname> at <project-path>\` (run \`hostname\`; use cwd for the path). One-time per session — don't repeat on later wakes; skip if already posted this session (e.g. after a \`/mcp\` reconnect).

**When a log entry routes work to you** (a routing/assignment-class entry per your cube's conventions that names your label + asks for action, or a direct \`<your-label>:\` mention): call \`borg_ack entry_id=<id>\` within ~60s. Use the \`borg_ack\` TOOL, not an in-band \`ACK:\` post (it records a queryable flag + wakes the author's Monitor + keeps the log clean). Ack = receipt, not completion (\`STARTING\` / \`DONE\` still apply). Ack only routing-class signals — not every mention.

**Claim a work item before you start it (\`borg_ack ... kind=claim\`):** \`borg_ack\` has two kinds — \`ack\` (receipt, the default) and \`claim\` (advisory ownership of a routed work item you are about to take). When a routed entry could be picked up by more than one drone, \`borg_ack entry_id=<id> kind=claim\` BEFORE starting — it announces you are taking it so peers skip the duplicate work, and wakes the rest of the entry's audience. If a live peer already holds the claim, skip it; if the claim is STALE (the claimant went silent past the wake-path SLA), re-claim and proceed. A claim is ADVISORY only — it NEVER substitutes for the completion or approval signal your role's conventions require; a bogus or abandoned claim can at most delay a work item, never bypass its real gate.

**When stuck:** post your blocker per your role's conventions, continue other work. Escalation is per your role detail, not by stalling.

**Anti-passive (lane idle = no work routed to you, no actionable signal in the log):**
- If your work arrives via dispatch / a work queue: when your lane goes idle, post your role's availability signal (capacity clean, awaiting next assignment from your coordinating role) — once per idle period, don't spam. No assignment in ~15 min → ping your coordinating role (capacity available since <time>; any queue item to pick up?).
- If your work is SELF-DIRECTED (not dispatch-driven): do NOT post an availability signal — proactively surface lane-substantive work per your role (reviews, audits, proposals, coherence / quality sweeps on relevant in-flight work).
- Route work-asks through your cube's coordinating role, never directly to the human Queen.

**Verify factual claims:** verify any verifiable claim — versions, code-state, prod behavior, npm state — against the SOURCE-OF-TRUTH surface (\`git tag\` / \`git show <ref>:<path>\` / grep, \`curl\` / \`wrangler tail\`, \`npm view\`, the live DB) BEFORE writing it; never a derivative artifact (another post, summary, or your own prior framing). The full discipline — the v1/v2/v3 sharpening levels, the per-claim-type concrete surfaces, and four-surface propagation (brainstorm / comment / review / issue-filing) — is in the operating-playbook chapter (\`borg_playbook\`; loaded via the session-start block in your regen).

**Posting to the log:** post per your role's conventions whenever you start/finish a task, get stuck, answer a drone, or learn something others need — regardless of who initiated (a log signal, your own scan, or a user prompt). Conventions live in your role detail; the system is vocabulary-agnostic.

**Routing posts — widen the directed default:** the taxonomy routes most prefixes DIRECTED to your cube's coordinating role; your \`to:\` / \`visibility:\` overrides it. Widen when a post must reach more than the coordinating role:
- Posting a verdict / decision / result a specific drone is waiting on: add \`to:[that drone]\` so they're WOKEN — without it they can be left UNAWARE of their own merge or feedback. Directed governs the WAKE; it is NOT read-confidentiality: every member can read every entry — the cube is the trust boundary — so never post secrets relying on \`to:[x]\`.
- Any drone posting a multi-seat DELIVERABLE (spec / security classification / review artifact 3+ seats build or gate against): pass \`visibility:broadcast\` (or \`to:[the seats]\`) EVEN IF your prefix (\`DONE\` etc.) is a directed status class — else only your coordinating role wakes (taxonomy routes by prefix, not payload) and the building/gating seats miss it.

**Pre-commit git hygiene (universal):**

Any drone that commits code: run \`git diff --staged --stat\` before \`git commit\` to verify file count + LOC direction + paths match your intent. Catches deleted files / anomalous -LOC / wrong paths pre-push. Your role may layer more git rules (code-implementing + coordinating roles typically carry the full set).`;
}

/**
 * Eager export of the playbook text. Cheap to compute (string concat);
 * exporting as a constant lets callers splice it directly without a
 * function call site.
 */
export const DRONE_PLAYBOOK = getDronePlaybook();

/**
 * gh#912: the verbose operating-discipline DETAIL externalized out of the
 * bootstrap regen into an on-demand chapter (fetched via the borg_playbook
 * tool). The inline core (getDronePlaybook) keeps the rule-spine + triggers +
 * forcing-functions + safety; this chapter carries the WHY, the per-level
 * sharpening, the concrete surfaces, and the four-surface propagation that a
 * drone only needs when doing review/verify-class work. Static text.
 */
// copy-param-claim: borg_decisions.topic
//   The chapter below tells drones to cite a ratified decision via
//   `borg_decisions {topic}`; this marker pins the param so the #490/#529
//   copy-guard verifies borg_decisions exposes `topic`
//   (client/__tests__/copy-mechanism-guard.test.ts).
export function getDronePlaybookChapter(): string {
  return `## Operating playbook — full disciplines (borg_playbook chapter)

This is the on-demand detail behind the rule-spine in your regen. Load it ONCE per session; it is static — do not re-fetch on every wake.

**Verifying factual claims:**

Any time you make a factual claim that could be verified — "this shipped as version Y", "function Z does W", "endpoint A returns B in prod", "package P is at version Q on npm" — verify the claim against a SOURCE-OF-TRUTH surface BEFORE writing it, not against a derivative artifact (another post, doc, summary, or your own prior framing). Three sharpening levels:

- **v1 (verify against the actual surface):** check the claim against the surface it describes (e.g. a code-state claim → grep the file). Apply when the claim is about code-state.
- **v2 (source-of-truth vs derivative artifacts):** when the verification surface itself could carry the original error chain (another post citing the same wrong claim, a doc copy-mirrored from the post you're checking), verify against the canonical source-of-truth: \`git tag\` for version-attribution, code-by-grep / direct file read for code-state, live \`curl\` or \`wrangler tail\` for prod-state, \`npm view\` for npm-state. Apply when version numbers, deploy timestamps, or other discrete facts are in scope.
- **v3 (end-to-end execution path vs originating mechanism):** when verifying a live-mechanism claim ("the watchdog wakes silent drones"), verify the END-TO-END execution path, not just each isolated component — each isolated mechanism can be correct while the path between them silently breaks. Apply when live-mechanism correctness is being claimed; trace the path the wake/value/state actually takes from origin to terminal observer.

**Concrete verification surfaces by claim type:**
- Version attribution → \`git tag --contains <sha>\` or \`git log --oneline <tag>\`
- Code state → match the grep surface to the claim surface:
  - Local uncommitted claim → \`grep -n "<symbol>" <file>\` or direct file read in the working tree
  - \`origin/main\`, PR head, branch, merge-SHA, or tag claim → \`git show <ref>:<path>\` followed by a symbol search in the returned source
- Prod state → \`curl https://<endpoint>\` or \`wrangler tail --env production\`
- npm registry state → \`npm view <package>@<version>\` or \`npm view <package>@latest\`
- DB state → query through the existing \`db\` interface; never trust a doc claim about row counts / column values
- Cube log state → \`borg_read-log unread_only=true\` for wake triage, draining until \`behind_by=0\`; don't cite from memory or from another drone's summary
- Ratified cube decision → \`borg_decisions {topic}\` — cite the registry's active decision by topic; NEVER restate a ratified decision from memory (a memory restatement drifts on the axis). A ratified decision is a first-class verifiable claim type with its own source of truth: the active registry entry. Recording one is \`borg_decide\` (seat-holder only — recording IS the ratification act).

**The discipline is universal to reviewer-class actions** (Code Reviewer formal gates + Security Auditor SR gates + PM-courtesy verifications + UX-courtesy reviews + any drone making a verification-worthy factual claim in their cube-log post). It lives in this universal playbook rather than any one role's text because it applies to ALL reviewers.

**Four-surface propagation:**

The discipline applies at FOUR surfaces. Catches at the surface closest to origin are cheapest; catches at later surfaces have already propagated through earlier consumers:

- **Surface 1 (brainstorm-proposal time)**: when a brainstorm contribution names specific code identifiers / API field names / enum values / column names / function signatures, the PROPOSING drone source-grep's the referenced file BEFORE composing the proposal. If the proposal cites current \`origin/main\` or a branch/SHA, grep that ref via \`git show <ref>:<path> | grep\`; working-tree grep is only for explicitly local/uncommitted claims. Cheapest catch surface; one drone catches one error.
- **Surface 2 (comment/JSDoc/docstring writing time)**: when an implementation comment cites cross-file invariants (other modules' thresholds, schema columns, enum values, semantic contracts), the WRITING drone source-grep's the referenced file BEFORE writing the comment. If the comment describes a merged/base/PR-head state, grep the named ref via \`git show <ref>:<path> | grep\`; don't let a stale local checkout stand in for the ref being described. Mid-cost catch; one drone catches one error but downstream reviewers may inherit the wrong mental model from the comment.
- **Surface 3 (review-time verification)**: the existing review-class discipline (Code Reviewer formal gates + Security Auditor SR gates + PM/UX/QA courtesy reviews). Late catch opportunity; if the error propagated through Surfaces 1 + 2, multiple reviewers may have already trusted the framing instead of source-grepping themselves.
- **Surface 4 (durable-tracking-artifact-writing time)**: when filing a deferred-tracking issue from a cube event payload, the FILING drone fetches the originating entry's full body from the cube log BEFORE composing the issue body. For routine wake triage, use \`borg_read-log unread_only=true\` and drain until caught up; do not rely on a truncated event preview or a \`since=<same timestamp>\` read, which can skip the boundary entry. Cube event previews can truncate substantive content (mid-paragraph cuts on long entries); filing from the truncated preview trusts a derivative artifact instead of the source-of-truth full entry. Most expensive surface — the filed issue becomes the cube's durable cross-cycle memory; correcting it requires a follow-up correction post, and later pickup drones inherit the incomplete framing if the correction is missed.

**Ratified-decision drift is a four-surface drift-class.** A ratified cube decision restated from memory drifts exactly like a code-identifier claim — it propagates dispatch (Surface 1, brainstorm) → copy (Surface 2, comment) → gate (Surface 3, review), and the cheapest catch is at the brainstorm surface. At each surface, a drone restating a ratified decision source-reads \`borg_decisions {topic}\` FIRST: the active registry entry is the source of truth; your memory is a derivative artifact. Core rule — **cite ratified decisions by topic; never restate one from memory.**`;
}

/**
 * Format an absolute timestamp as a coarse "Xs/Xm/Xh ago" string.
 */
export function humanAgo(date: Date | string): string {
  const then = typeof date === 'string' ? new Date(date) : date;
  const ms = Date.now() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

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
export function nullTaxonomyTip(messageTaxonomy: unknown): string {
  const isEmpty =
    messageTaxonomy == null ||
    (Array.isArray(messageTaxonomy) && messageTaxonomy.length === 0);
  if (!isEmpty) return '';
  // copy-param-claim: borg_update-cube.message_taxonomy
  //   The tip says "with a taxonomy array" rather than the literal param name;
  //   this inline marker pins the real inputSchema param so the #490/#529 guard
  //   (client/__tests__/copy-mechanism-guard.test.ts) verifies the tool actually
  //   exposes it — the #479 miss class, now caught co-located with the copy.
  return 'Tip: no message taxonomy declared — set one to enable intent-based smart routing (#468). Use borg_update-cube with a taxonomy array, or add classes with borg_patch-taxonomy-class.';
}

export function regenWakePathDroneLabel(
  result: { drone?: { label?: string | null } },
  cachedDroneLabel: string | null | undefined
): string | null {
  return result.drone?.label ?? cachedDroneLabel ?? null;
}

export type RegenMode = 'full' | 'lite';

let boilerplateEmittedThisSession = false;
let cachedRoleTextHash: string | null = null;

export function __resetRegenSessionState(): void {
  boilerplateEmittedThisSession = false;
  cachedRoleTextHash = null;
}

function safetyDisciplinesForRole(detailedDescription: string | null | undefined): string[] {
  const text = detailedDescription ?? '';
  const roleScoped = ROLE_SCOPED_SAFETY_DISCIPLINES.filter((discipline) =>
    text.includes(discipline)
  );
  return [...UNIVERSAL_SAFETY_DISCIPLINES, ...roleScoped];
}

export function formatRationalePointer(role: string, section: string): string {
  return `rationale → borg_role-rationale ${JSON.stringify(role)} ${JSON.stringify(section)}`;
}

export function parseRationalePointer(stub: string): { role: string; section: string } | null {
  const match = stub.match(/borg_role-rationale\s+("(?:(?:\\.)|[^"\\])*")\s+("(?:(?:\\.)|[^"\\])*")/);
  if (!match) return null;
  try {
    return { role: JSON.parse(match[1]), section: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

/** The full safety-discipline corpus — a `… rationale:` section is NEVER
 * compressed if its body contains ANY of these (⛔ safety-never-compress
 * fail-safe). Over-inclusive on purpose: checks ALL role-scoped disciplines,
 * not just the role's own, so a wrongly-placed LIVE rule can never be stubbed. */
const ALL_SAFETY_DISCIPLINES: readonly string[] = [
  ...UNIVERSAL_SAFETY_DISCIPLINES,
  ...ROLE_SCOPED_SAFETY_DISCIPLINES,
];

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
export function compressRoleText(
  roleName: string,
  detailedDescription: string | null | undefined
): string {
  const text = detailedDescription ?? '';
  const sections = parseRoleSections(text);
  return sections
    .map((section) => {
      if (section.kind !== 'label' || section.heading == null) return section.body;
      const isRationale = section.heading.trim().toLowerCase().endsWith('rationale');
      if (!isRationale) return section.body;
      // ⛔ fail-safe: never stub a section carrying any safety-discipline text.
      if (ALL_SAFETY_DISCIPLINES.some((d) => section.body.includes(d))) return section.body;
      // Preserve the heading line verbatim; replace the rationale body with the stub.
      const nlIdx = section.body.indexOf('\n');
      const headingLine = nlIdx === -1 ? section.body + '\n' : section.body.slice(0, nlIdx + 1);
      return headingLine + formatRationalePointer(roleName, section.heading) + '\n';
    })
    .join('');
}

export function formatRegenMarkdown(
  result: {
    cube: any & { directive_hash?: string | null };
    role: any & { detailed_description_hash?: string | null };
    drone: any;
    roles: any[];
    drones: any[];
    // gh#886: recentLog is no longer rendered into the bundle (it ballooned
    // the regen and blocked simpler-model bootstrap). Kept optional for
    // rollout-compat — a pre-gh#886 worker still sends it; we fall back to
    // rendering it only when behind_by is absent.
    recentLog?: any[];
    // gh#886: the caller's unread count (worker countUnreadForDrone). When
    // present, regen renders a smart drain instruction instead of the payload.
    behind_by?: number;
    // gh#740: active ratified decisions for the cube. Rendered in the
    // always-shown band (lite + full) so the source of truth is in context at
    // mid-session restatement moments. Absent on a pre-gh#740 worker → omitted.
    decisions?: any[];
  },
  opts: { mode?: RegenMode } = {}
): string {
  const mode = opts.mode ?? 'full';
  const roleOverview = result.roles
    .map(
      (r: any) =>
        `- **${r.name}**${r.is_default ? ' _(default)_' : ''} — ${r.short_description || '_(no short description)_'}`
    )
    .join('\n');

  const droneOverview =
    result.drones
      .map((d: any) => {
        const role = result.roles.find((r: any) => r.id === d.role_id);
        const roleLabel = formatRoleAgentLabel(role?.name ?? '?', d.agent_kind);
        return `- **${d.label}** (${roleLabel}) — last seen ${humanAgo(new Date(d.last_seen))}`;
      })
      .join('\n') || '_(no drones connected)_';

  // gh#886: the cube log is NO LONGER inlined as a payload. Render a smart
  // unread-count instruction from the caller's behind_by (worker
  // countUnreadForDrone) — the drone learns how-many + whether-to-fetch
  // without the token cost of the entries. The worker is a single atomic
  // deploy and always sends behind_by, so there is no "old worker" branch;
  // the `behind_by` absent case is one-line null-safety (a brief
  // new-worker-meets-not-yet-updated-client skew) that renders the drain
  // instruction without a number rather than crashing — never inlines a payload.
  const unread = typeof result.behind_by === 'number' ? result.behind_by : null;
  const cubeLogSection =
    unread === null
      ? 'Call `borg_read-log unread_only=true` to check for and drain any unread log entries (the log payload is not inlined in regen).'
      : unread > 0
        ? `You have **${unread}** unread log ${unread === 1 ? 'entry' : 'entries'}. ` +
          'Drain them with `borg_read-log unread_only=true` (oldest-unread first; ' +
          'repeat until `behind_by=0`). The log payload is not inlined here — fetch on demand.'
        : "You're caught up — **0** unread log entries. No need to read the log right now.";

  const isEmptyCube = (unread ?? 0) === 0 && result.drones.length <= 1;
  const gettingStarted = isEmptyCube
    ? [
        '## Getting started',
        '',
        'Welcome to your first cube. Here\'s how to get going:',
        '',
        '1. Post your first activity: `borg_log message="Starting work on <your task>"`',
        '2. Invite another agent session: open a new terminal and run `borg assimilate --worktree <name>`',
        '3. Check who\'s here: `borg_roster`',
        '',
        '---',
        '',
      ].join('\n')
    : '';

  const taxonomyTip = nullTaxonomyTip(result.cube.message_taxonomy);

  // gh#740: render active ratified decisions concisely (one line each), capped
  // with an elision footer. Section omitted when there are none (or the field
  // is absent on a pre-gh#740 worker — mixed-client safe). Lives in the
  // always-shown band below so it surfaces on LITE wakes (the mid-session
  // restatement moment), not just the session-start full regen (PM F1).
  const RATIFIED_DECISIONS_CAP = 12;
  const activeDecisions = Array.isArray(result.decisions) ? result.decisions : [];
  const decisionsSection = (() => {
    if (activeDecisions.length === 0) return '';
    const shown = activeDecisions.slice(0, RATIFIED_DECISIONS_CAP);
    const lines = shown.map((d: any) => `- **${d.topic}:** ${d.decision}`);
    const remaining = activeDecisions.length - shown.length;
    if (remaining > 0) lines.push(`- _+${remaining} more — \`borg_decisions\`_`);
    return ['## Ratified decisions', 'Cite these by topic — do NOT restate a ratified decision from memory.', ...lines].join('\n');
  })();

  const roleTextHash = result.role.detailed_description_hash ?? null;
  // gh#496-A(b): full mode (and the lite emit-role-text branch) render the
  // COMPRESSED-core role text — `… rationale:` sections become on-demand
  // borg_role-rationale stubs; rules + all safety stay inline. The lite
  // hash-gating path (shouldEmitRoleText, over the STORED detailed_description
  // hash) and the lite-omitted safety set below are unchanged.
  const roleText = result.role.detailed_description
    ? compressRoleText(result.role.name, result.role.detailed_description)
    : '_(no detailed description set)_';
  // gh#912-followup: ONE consolidated session-start fetch block (PM
  // campaign-level catch 7a42d0e3) — replaces BOTH #912's standalone
  // borg_playbook pointer AND a separate directive pointer. N competing
  // "required first step" pointers let a weak model satisfy the loudest and
  // skip the rest; a single atomic block = one triage decision, uniform
  // forcing, and gh#512-ready (the role-text fetch appends a bullet here). The
  // directive (opaque ~1-2K) is fetched via the EXISTING borg_cube. SAFETY is
  // NOT deferred — git/wake-path safety lives inline in the role-text safety
  // floor, so deferring the directive defers zero safety.
  const sessionStartBlock =
    'Before you post or act, load your full operating context — once per session; static, do NOT re-fetch on every wake:\n' +
    '- `borg_playbook` — your full operating disciplines (verification, four-surface propagation, ack / routing / idle detail).\n' +
    '- `borg_cube` — the cube directive + conventions (log vocabulary, project / git / dispatch conventions).';
  const shouldEmitRoleText =
    mode === 'full' || roleTextHash == null || roleTextHash !== cachedRoleTextHash;
  const shouldEmitPlaybook = mode === 'full' || !boilerplateEmittedThisSession;

  const lines = [
    gettingStarted + `# Cube: ${result.cube.name} — ${result.drone.label}`,
    '',
    `**Your role:** ${result.role.name}`,
    '',
  ];

  if (mode === 'lite') {
    lines.push(
      "_(lite regen — the role playbook may be omitted when unchanged; your operating context (playbook + cube directive) loads via the Session-start block (borg_playbook + borg_cube). If the playbook is NOT in your current context (e.g. after a context-compaction), call `borg_regen mode=\"full\"` to re-orient.)_",
      ''
    );
  }

  lines.push(
    // gh#917: full forcing block ONLY on bootstrap/compaction-recovery
    // (mode==='full'); a soft 1-liner on lite wakes. Stops a weak model
    // reflexively re-fetching both chapters every wake — which re-inflates
    // per-wake processing toward the 60s timeout the campaign fights.
    mode === 'full' ? `## Session start — required before acting` : `## Session start`,
    mode === 'full'
      ? sessionStartBlock
      : 'Operating context (playbook + cube directive) was loaded at session start — re-fetch `borg_playbook` / `borg_cube` ONLY after a context-compaction (a `mode="full"` regen), not on every wake.',
    '',
    ...(taxonomyTip ? [taxonomyTip, ''] : []),
    `## Your role: ${result.role.name}`,
    shouldEmitRoleText
      ? roleText
      : [
          '_(role playbook unchanged since your last full/lite regen; omitted in lite mode)_',
          '',
          ...safetyDisciplinesForRole(result.role.detailed_description),
        ].join('\n'),
    '',
    `## Roles in this cube`,
    roleOverview,
    '',
    `## Connected drones`,
    droneOverview,
    '',
    `## Cube log`,
    cubeLogSection,
    ...(decisionsSection ? ['', decisionsSection] : []),
  );

  if (shouldEmitPlaybook) {
    lines.push('', getDronePlaybook());
    boilerplateEmittedThisSession = true;
  }
  if (shouldEmitRoleText && roleTextHash != null) {
    cachedRoleTextHash = roleTextHash;
  }

  return lines.join('\n');
}

export function formatLogEntryMarkdown(
  entry: any,
  droneById: Map<string, any>,
  roleById: Map<string, any>
): string {
  const d = droneById.get(entry.drone_id) as any;
  const r = d ? (roleById.get(d.role_id) as any) : null;
  const ts = new Date(entry.created_at).toISOString();
  const entryId =
    typeof entry.id === 'string' && entry.id.length > 0
      ? ` [entry_id: ${entry.id}]`
      : '';
  // gh#371: the stable short-uuid address token (`id:<8hex>`), distinct from
  // the entry_id bracket above. Address a dispatch to this drone via to:[<id>].
  const addr =
    typeof entry.drone_id === 'string' && entry.drone_id.length > 0
      ? ` ${formatDroneAddressToken(entry.drone_id)}`
      : '';
  return `**[${ts}]**${entryId}${addr} ${d?.label ?? '?'} (${r?.name ?? '?'}): ${entry.message}`;
}
