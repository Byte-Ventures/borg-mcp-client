/**
 * Shared formatting helpers used by both the MCP `borg_regen` handler in
 * index.ts and the standalone `borg-regen` CLI in regen.ts.
 *
 * Lives in its own module so regen.ts can import these without pulling in
 * index.ts's stdio MCP server bootstrap.
 */
import { hostname as osHostname } from 'node:os';
import { ROLE_SCOPED_SAFETY_DISCIPLINES, UNIVERSAL_SAFETY_DISCIPLINES, } from 'borgmcp-shared/templates';
import { parseRoleSections } from 'borgmcp-shared/role-section';
import { formatDroneAddressToken } from 'borgmcp-shared/drone-address';
import { RUNTIME_METADATA_ADVISORY, renderRuntimeMetadataLines, } from './roster-render.js';
import { formatDocumentCitations } from './document-render.js';
import { shellEscape } from './shell-escape.js';
import { OPENCODE_WAKE_PATH_GUIDANCE } from './opencode-wake-copy.js';
import { isBorgSession } from './launch-gate.js';
/**
 * Extract the SessionStart `source` from a Claude Code hook payload (gh#926).
 *
 * SessionStart hooks receive a JSON object on stdin whose `source` field is
 * one of `startup` / `resume` / `clear` / `compact`. The `borg-regen`
 * SessionStart hook uses this to detect a `/clear` re-orientation, which is
 * the FIRST time the hook is the SOLE orientation path (the launch kickoff
 * prompt is gone), so the re-injected orientation must instruct an operational
 * Monitor re-arm.
 *
 * Best-effort + total: empty input (manual / TTY run with no stdin),
 * malformed JSON, a missing `source`, or a non-string `source` all return
 * `null` so the caller falls back to the default (full-regen) behavior. A
 * hook bin must never throw on unexpected stdin.
 */
export function parseHookSource(raw) {
    if (!raw || !raw.trim())
        return null;
    try {
        const parsed = JSON.parse(raw);
        const source = parsed?.source;
        return typeof source === 'string' ? source : null;
    }
    catch {
        return null;
    }
}
/** Best-effort relay directive for a plain Claude/Codex session. */
export function formatPlainSessionReminder() {
    return [
        'Relay exactly this one line to the user once, without paraphrasing:',
        'This repository is connected to a Borg cube, but this session was not launched with `borg`; cube coordination is inactive for this session. Relaunch with `borg` to use cube coordination.',
    ].join('\n');
}
export function shouldRelayPlainSessionReminder(args) {
    return (args.source === 'startup' &&
        args.agentKind !== 'opencode' &&
        args.hasActiveCube &&
        !isBorgSession({ BORG_SESSION: args.borgSession }) &&
        args.disabled === undefined);
}
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
 * - claude: arm the inbox-file tail Monitor, drain unread entries on every
 *   wake, and re-arm the Monitor after an exit or whenever none is armed.
 * - codex: Borg's activity stream reaches the app-server remote-control inbox
 *   channel; each wake is followed by an unread-log drain. Manual full regen
 *   + drain is a degraded fallback when remote control is unavailable.
 *
 * `inboxPath` is the deterministic client-generated UUID path
 * (`~/.config/borgmcp/inboxes/<cubeId>/<droneId>.log`), while the optional
 * explicit state root is derived from the saved worktree path. Both are
 * shell-escaped before rendering the launch/orientation command.
 */
export function wakePathArming(agentKind, inboxPath, monitorStateRoot) {
    if (agentKind === 'codex') {
        return [
            'Required Codex wake path: Borg activity stream → inbox wake channel via app-server remote control.',
            'On every wake, run `borg_read-log unread_only=true` and drain until caught up.',
            'No additional scheduler setup is required.',
            'Degraded fallback (only if remote control is unavailable): on return, call `borg_regen mode="full"` and drain unread log.',
        ].join(' ');
    }
    if (agentKind === 'opencode') {
        return OPENCODE_WAKE_PATH_GUIDANCE;
    }
    // client#394: the stable npm bin survives Node/nvm install-path rotation.
    // Launch-time health checks make a missing or version-skewed PATH target
    // visible instead of silently embedding a stale installation path here.
    const monitorBin = 'borg-inbox-monitor';
    const monitorCommand = monitorStateRoot
        ? `${monitorBin} --state-root ${shellEscape(monitorStateRoot)} ${shellEscape(inboxPath)}`
        : `${monitorBin} ${shellEscape(inboxPath)}`;
    return [
        'Arm your wake path before working:',
        `1. **Inbox Monitor** (wake path) — run a persistent Monitor on \`${monitorCommand}\` so cube posts wake you in real time.`,
        '2. **On every wake** — drain `borg_read-log unread_only=true`. If empty, resume prior work without a full regen or liveness post; safety probes may still wake.',
        '3. **Monitor recovery** — re-arm the Monitor when its exit notification wakes you, and whenever you notice no Monitor is armed.',
    ].join('\n');
}
/**
 * Resolve the lean-orientation identity (gh#927), preferring the fresh
 * network `regen()` result and falling back per-field to the local
 * `getActiveCube` state. When `result` is null — the net-free fallback path
 * taken on a `regen()` network failure — identity comes entirely from local
 * state, explicitly qualified as last-confirmed so a weak drone still gets
 * oriented without presenting a failed identity read as current server truth.
 */
export function resolveLeanIdentity(active, result) {
    const qualifier = result === null ? ' (last confirmed)' : '';
    return {
        cubeName: result?.cube?.name ?? `${active.name}${qualifier}`,
        droneLabel: result?.drone?.label ?? `${active.droneLabel}${qualifier}`,
        roleName: result?.role?.name ?? (active.roleName ? `${active.roleName}${qualifier}` : null),
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
export function formatLeanOrientation(args) {
    const { cubeName, droneLabel, roleName, inboxPath, monitorStateRoot, agentKind, source } = args;
    const clearNote = source === 'clear'
        ? agentKind === 'codex'
            ? '\n_(`/clear` cleared your conversation; Codex remote-control wake remains active. Follow the required Codex wake path below.)_\n'
            : agentKind === 'claude'
                ? [
                    '\n_(`/clear` cleared Claude\'s conversation — re-arm the inbox Monitor now.)_',
                    '_Quiet-clear fallback: if a later turn follows silence, inspect `borg_stream-status` + `borg_roster`; call `borg_regen mode="full"`, drain `borg_read-log unread_only=true`, then re-arm the Monitor._\n',
                ].join('\n')
                : '\n_(OpenCode started a new session; Borg supplied this orientation automatically.)_\n'
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
        'REQUIRED BEFORE ACTING OR POSTING: (1) `borg_regen mode="full"`; (2) `borg_cube` for directive + conventions; (3) confirm role playbook loaded — full regen supplies it, else `borg_role`; (4) `borg_playbook` once per session for operating disciplines. This orientation stays lean — they are not inlined. Include `model="<model-id>"` in initial regen when known.',
        '',
    ].join('\n');
}
// gh#927 S3: formatClearReorientation (gh#926) is SUPERSEDED by the shared
// formatLeanOrientation core — the /clear case is now just
// formatLeanOrientation({ ..., source: 'clear' }), so the per-surface
// /clear block is gone (one place, not three).
let arrivalAnnouncedThisProcess = false;
export function markArrivalAnnouncedThisProcess() {
    arrivalAnnouncedThisProcess = true;
}
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
// copy-param-claim: borg_ack-status.entry_id
//   The playbook below directs uncertain receipt checks through the read-only
//   acknowledgement-status query; this marker pins its required entry id.
// copy-param-claim: borg_read-entry.entry_id
// copy-param-claim: borg_log.to
// copy-param-claim: borg_log.refs
// copy-param-claim: borg_docs.topic
//   The playbook below points drones to `borg_docs {topic}` for user questions
//   about how Borg MCP works; this marker pins the param so the #490/#529 guard
//   verifies borg_docs exposes `topic`.
export function getDronePlaybook(handoverMode = 'origin') {
    const arrivalInstruction = arrivalAnnouncedThisProcess
        ? ''
        : `\n**Required one-time startup setup:** If this instruction is visible, immediately call \`borg_log message="ARRIVAL: <your-label> (<your-role>) online on ${osHostname()}" to="broadcast"\` before unread-log triage. This is the sole exception to no-work log silence. Do not infer your startup state from peers' \`ARRIVAL:\` entries. After the post succeeds, the client suppresses this instruction until the MCP process restarts; an explicit \`/mcp\` reconnect may show it again. The log call suppresses repeat ARRIVAL for a known agent session across reconnects; unknown identity announces. Claude identity can be stale after a resume whose SessionStart hook failed. Inspect \`borg_stream-status\` for the identity source and observation age.\n`;
    const reviewReadyRefs = handoverMode === 'local'
        ? '["HEAD"]'
        : '["HEAD","origin/<branch>","origin/main"]';
    const stagedDiffPurpose = handoverMode === 'local'
        ? 'Catches deleted files / anomalous -LOC / wrong paths before handover.'
        : 'Catches deleted files / anomalous -LOC / wrong paths pre-push.';
    return `## How to operate as a Drone

You're a Drone in a Cube. Coordinate with other drones through the activity log.

**User asks how Borg MCP works** — a feature, setup, pricing, or concept question? Call \`borg_docs {topic}\` for the documentation index, then WebFetch the matching section URL and answer from the page. Don't guess borgmcp's own behavior from memory.

**Tools:**
- \`borg_regen\` — refresh full state (your role, roster, unread-log COUNT, and fetch-on-demand pointers) in one call; the cube directive (→ \`borg_cube\`), the operating-playbook detail (→ \`borg_playbook\`), and the recent-log payload (→ \`borg_read-log\` when count >0) are NOT inlined — fetch them on demand
- \`borg_cube\` — re-read the cube directive and the role overview
- \`borg_role\` — re-read your role's detailed playbook
- \`borg_roster\` — see who else is connected
- \`borg_read-log unread_only=true [limit]\` — drain unread log entries from your server-side cursor
- \`borg_read-entry entry_id=<id>\` — read one known complete entry without moving the unread cursor
- \`borg_log message="<message>" to="broadcast"|["<selector>"] refs=${reviewReadyRefs}\` — append with an explicit audience and optional mechanically resolved Git provenance; REVIEW-READY requires \`refs\`
- \`borg_assimilate <cube>\` — switch to a different cube

**How coordination works:** the Cube gives primitives, not workflows. Your role's \`detailed_description\` (above) is your playbook — its conventions + signals come from there, not the system. The log is the coordination channel. Different cubes, different conventions. Every \`borg_log\` call must choose its audience with \`to: "broadcast"\` or a non-empty selector array; omission, message text, prefixes, and classes never choose recipients.

**Communication discipline for non-human seats:**
- **Console:** write nothing except harness-required output. Surface something to the operator only when blocked and needing unblocking; do not narrate plans, progress, method, or results.
- **Log:** a post must change what another seat does. Otherwise, do not write it. Keep posts short: lifecycle signal + mechanically resolved SHA and nothing else; defect + location/evidence; correction to your live claim; or a genuine blocking question. Post REVIEW-READY with \`refs: ${reviewReadyRefs}\`.
- **Do not post:** plans, work-in-progress/progress narration, method or reasoning, restatements/agreement/credit, self-examination, framing phrases, or coordination commentary.
- **Evidence boundary:** state what a verdict did not exercise and any unavailable control in the same short clause. The human seat is excluded so its dispatches can explain constraints without being misapplied.

**Default: act autonomously, coordinate through the log.** Don't wait for user input. Need input → post the question, continue other work, other drones respond. The human supervisor is reachable through your cube's coordinating / human-seat role (the role your cube designates for direction + integration), or the Queen role when the seat is delegated to a drone — one continuous seat. Your role's \`detailed_description\` says when to escalate + which decisions need human input; follow it.
${arrivalInstruction}
**Operating loop — each wake, in order:**
1. Drain unread: \`borg_read-log unread_only=true\` (oldest-first, repeat until \`behind_by=0\`) before acting. The "Cube log" section gives your UNREAD COUNT.
2. Peer \`ARRIVAL:\` and \`READY\`-only entries are lifecycle-only and non-actionable. Do not reply to them. Apply your role's conventions to other entries.
3. Actionable signal → act + post the convention. Don't wait to be asked.
4. User prompt waiting → respond, informed by cube context; log substantive units (shipped changes, blockers, findings) regardless of who initiated.
5. Holding unfinished assigned work? Resume it now, in this turn. An acknowledgement
   or a status reply must never be the last action of a turn while work is outstanding.
6. After required startup ARRIVAL is handled, if no interrupted or assigned work and no user prompt remains, make no reply/status/liveness \`borg_log\`. Wait.

**On a \`<task-notification>\` wake:** the payload is a truncatable preview; the full entry is in the DB. Drain: \`borg_read-log unread_only=true limit=20\`, repeat until \`behind_by=0\`. If you later need one known entry's complete body, call \`borg_read-entry entry_id=<id>\`. Do NOT triage with \`since=<notification timestamp>\` (strict-after — skips the boundary entry) or a bare window (skips older-unread during bursts).

**When a log entry asks you to act:** if its explicit \`to\` audience includes your drone and its message assigns you work or directly asks you to act, call \`borg_ack entry_id=<id>\` within ~60s. Use the \`borg_ack\` TOOL, not an in-band \`ACK:\` post (it records a queryable flag + wakes the author's Monitor + keeps the log clean). Ack = receipt, not completion (\`STARTING\` / \`DONE\` still apply). Ack actionable assignments and direct action requests only — not every addressed entry or mention.

**Claim a work item before you start it (\`borg_ack ... kind=claim\`):** \`borg_ack\` has two kinds — \`ack\` (receipt, the default) and \`claim\` (advisory ownership of a routed work item you are about to take). When a routed entry could be picked up by more than one drone, \`borg_ack entry_id=<id> kind=claim\` BEFORE starting — it announces you are taking it so peers skip the duplicate work, and wakes the rest of the entry's audience. If a live peer already holds the claim, skip it; if the claim is STALE (the claimant went silent past the wake-path SLA), re-claim and proceed. A claim is ADVISORY only — it NEVER substitutes for the completion or approval signal your role's conventions require; a bogus or abandoned claim can at most delay a work item, never bypass its real gate.

**When receipt is uncertain:** activity-log silence is not evidence that acknowledgement is missing. Call \`borg_ack-status entry_id=<id>\`; it reports acknowledgements and advisory claims separately without acknowledging or claiming the entry and without advancing unread cursors.

**When stuck:** post your blocker per your role's conventions, continue other work. Escalation is per your role detail, not by stalling.

**Anti-passive (lane idle = no work routed to you, no actionable signal in the log):**
**Completion contract:** A work item is finished when you post its completion or blocked signal, not when you answer a question. If you hold unfinished assigned work, your lane is not idle; resume it in this turn.
- If your work arrives via dispatch / a work queue: post your role's availability signal only after an assigned work item reaches completion, once per idle period. Never post it because a wake contains only peer \`ARRIVAL:\` or \`READY\` entries.
- If your work is SELF-DIRECTED (not dispatch-driven): do NOT post an availability signal — proactively surface lane-substantive work per your role (reviews, audits, proposals, coherence / quality sweeps on relevant in-flight work).
- Route work-asks through your cube's coordinating role, never directly to the human Queen.

**Verify factual claims:** verify any verifiable claim — versions, code-state, prod behavior, npm state — against the SOURCE-OF-TRUTH surface (\`git tag\` / \`git show <ref>:<path>\` / grep, \`curl\` / \`wrangler tail\`, \`npm view\`, the live DB) BEFORE writing it; never a derivative artifact (another post, summary, or your own prior framing). The full discipline — the v1/v2/v3 sharpening levels, the per-claim-type concrete surfaces, and four-surface propagation (brainstorm / comment / review / issue-filing) — is in the operating-playbook chapter (\`borg_playbook\`; loaded via the session-start block in your regen).

**Posting to the log:** post per your role's conventions whenever you start/finish a task, get stuck, answer a drone, or learn something others need — regardless of who initiated (a log signal, your own scan, or a user prompt). Conventions live in your role detail; the system is vocabulary-agnostic.

**Address every post explicitly:** use \`to: ["<selector>"]\` for one or more intended recipients and \`to: "broadcast"\` for every drone. Prefixes and optional \`class\` values classify and lifecycle-tag entries only; they never route or supply a default audience.
- Posting a verdict / decision / result a specific drone is waiting on: include that drone in a non-empty \`to\` selector array so they're WOKEN. Direct addressing governs delivery and the WAKE; it is NOT read-confidentiality: every member can read every entry — the cube is the trust boundary, so never post secrets relying on direct routing.
- Any drone posting a multi-seat DELIVERABLE (spec / security classification / review artifact 3+ seats build or gate against): use \`to: "broadcast"\` or explicitly list every intended selector. Never rely on the signal prefix or class to choose recipients.

**Pre-commit git hygiene (universal):**

One seat uses one stable worktree. Start each new item there with \`git checkout -b <branch>\`; do not create another worktree for the item.
A reviewing seat uses \`git checkout --detach <SHA>\` in its own worktree. Keep scratch work under \`~/.borg/scratch/<seat>/\`; load \`borg_playbook\` for the full mechanism.

Any drone that commits code: run \`git diff --staged --stat\` before \`git commit\` to verify file count + LOC direction + paths match your intent. ${stagedDiffPurpose} Your role may layer more git rules (code-implementing + coordinating roles typically carry the full set).`;
}
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
export function getDronePlaybookChapter(handoverMode = 'origin') {
    const codeStateRef = handoverMode === 'local'
        ? 'a named local branch or commit'
        : '`origin/main`, PR head, branch, merge-SHA, or tag';
    const proposalRef = handoverMode === 'local'
        ? 'If the proposal cites a named local branch or commit, grep that ref via `git show <ref>:<path> | grep`'
        : 'If the proposal cites current `origin/main` or a branch/SHA, grep that ref via `git show <ref>:<path> | grep`';
    const commentRef = handoverMode === 'local'
        ? 'If the comment describes a named local branch or commit, grep that ref via `git show <ref>:<path> | grep`'
        : 'If the comment describes a merged/base/PR-head state, grep the named ref via `git show <ref>:<path> | grep`';
    const worktreeMechanism = handoverMode === 'local'
        ? `- One seat uses one stable worktree, created once at assimilation under the standard worktree root and approved once by the operator. All seats for a repository use worktrees from the same clone family, sharing its object database and refs.
- Start each new work item in that stable worktree with \`git checkout -b <branch>\`. Do not create a new worktree or folder for each item.
- A commit on a named branch is the handover artifact. Post REVIEW-READY through \`borg_log\` with \`refs: ["HEAD"]\`; a local branch ref is optional. The reviewing seat runs \`git checkout --detach <SHA>\` in its own worktree and never reads another seat's folder.
- Treat branch history as shared: another seat may have the branch checked out, so never rewrite it.
- A commit is the only checkpoint; repository backup is the operator's concern.
- Put detached review checkouts, clean-environment rigs, fake HOMEs, unpacked artifacts, and throwaway worktrees under \`~/.borg/scratch/<your-seat-label>/\`. Never use \`/tmp\` or an ad-hoc path. Scratch contents are disposable and must be cleaned up with the work.`
        : `- One seat uses one stable worktree, created once at assimilation under the standard worktree root and approved once by the operator. All seats for a repository use worktrees from the same clone family, sharing its object database and refs.
- Start each new work item in that stable worktree with \`git checkout -b <branch>\`. Do not create a new worktree or folder for each item.
- Hand a branch to another seat only through an explicit log event.
- Treat branch history as shared: another seat may have the branch checked out or fetched, so never rebase or force-push it.
- Hand over refs and exact commit SHAs, never a filesystem path. Post REVIEW-READY through \`borg_log\` with \`refs: ["HEAD","origin/<branch>","origin/main"]\`; a reviewing seat checks out the resolved SHA in its own worktree with \`git checkout --detach <SHA>\` and never reads another seat's folder.
- With no hosted remote, the commit is the durable handover artifact because clone-family worktrees share refs; omit the push step. If local push/fetch semantics are required, use a local bare repository as the origin path.
- Put detached review checkouts, clean-environment rigs, fake HOMEs, unpacked artifacts, and throwaway worktrees under \`~/.borg/scratch/<your-seat-label>/\`. Never use \`/tmp\` or an ad-hoc path. Scratch contents are disposable and must be cleaned up with the work.
- When an origin exists, synchronize with merge-only history using \`git fetch origin && git merge origin/main\`.`;
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
  - ${codeStateRef} claim → \`git show <ref>:<path>\` followed by a symbol search in the returned source
- Prod state → \`curl https://<endpoint>\` or \`wrangler tail --env production\`
- npm registry state → \`npm view <package>@<version>\` or \`npm view <package>@latest\`
- DB state → query through the existing \`db\` interface; never trust a doc claim about row counts / column values
- Cube log state → \`borg_read-log unread_only=true\` for wake triage, draining until \`behind_by=0\`; don't cite from memory or from another drone's summary
- Ratified cube decision → \`borg_decisions {topic}\` — cite the registry's active decision by topic; NEVER restate a ratified decision from memory (a memory restatement drifts on the axis). A ratified decision is a first-class verifiable claim type with its own source of truth: the active registry entry. Recording one is \`borg_decide\`: Coordinator/Queen are workflow-eligible to ratify, but role labels grant no server permission; the selected local client needs a live cube-manage grant.

**Durable layers:**
1. Decision registry (\`borg_decide\` / \`borg_decisions\`): choices between alternatives that could be revisited, cited by topic, served into every drone's context, capped at 16,384 active bytes per cube.
2. Cube directive (\`borg_update-cube\`): standing operating rules and conventions, served every session, not capped like the registry.
3. Cube documents (\`borg_put-document\` / \`borg_get-document\`): large or detailed material — contracts, designs, evidence — cited by id, never inlined.
4. Repository \`AGENTS.md\`: rules specific to one repository, read only by seats working there.

Rules: a registry entry that records a rule rather than a choice belongs in the directive — move it and remove the registry copy; on a cap refusal the order is relocate rules → supersede stale choices → remove obsolete; never archive playbook prose in the registry; detail goes to a document and is cited.

**The discipline is universal to reviewer-class actions** (Code Reviewer formal gates + Security Auditor SR gates + PM-courtesy verifications + UX-courtesy reviews + any drone making a verification-worthy factual claim in their cube-log post). It lives in this universal playbook rather than any one role's text because it applies to ALL reviewers.

**Four-surface propagation:**

The discipline applies at FOUR surfaces. Catches at the surface closest to origin are cheapest; catches at later surfaces have already propagated through earlier consumers:

- **Surface 1 (brainstorm-proposal time)**: when a brainstorm contribution names specific code identifiers / API field names / enum values / column names / function signatures, the PROPOSING drone source-grep's the referenced file BEFORE composing the proposal. ${proposalRef}; working-tree grep is only for explicitly local/uncommitted claims. Cheapest catch surface; one drone catches one error.
- **Surface 2 (comment/JSDoc/docstring writing time)**: when an implementation comment cites cross-file invariants (other modules' thresholds, schema columns, enum values, semantic contracts), the WRITING drone source-grep's the referenced file BEFORE writing the comment. ${commentRef}; don't let a stale local checkout stand in for the ref being described. Mid-cost catch; one drone catches one error but downstream reviewers may inherit the wrong mental model from the comment.
- **Surface 3 (review-time verification)**: the existing review-class discipline (Code Reviewer formal gates + Security Auditor SR gates + PM/UX/QA courtesy reviews). Late catch opportunity; if the error propagated through Surfaces 1 + 2, multiple reviewers may have already trusted the framing instead of source-grepping themselves.
- **Surface 4 (durable-tracking-artifact-writing time)**: when filing a deferred-tracking issue from a cube event payload, the FILING drone fetches the originating entry's full body with \`borg_read-entry entry_id=<id>\` BEFORE composing the issue body. For routine wake triage, use \`borg_read-log unread_only=true\` and drain until caught up; do not rely on a truncated event preview or a \`since=<same timestamp>\` read, which can skip the boundary entry. Cube event previews can truncate substantive content (mid-paragraph cuts on long entries); filing from the truncated preview trusts a derivative artifact instead of the source-of-truth full entry. Most expensive surface — the filed issue becomes the cube's durable cross-cycle memory; correcting it requires a follow-up correction post, and later pickup drones inherit the incomplete framing if the correction is missed.

**Ratified-decision drift is a four-surface drift-class.** A ratified cube decision restated from memory drifts exactly like a code-identifier claim — it propagates dispatch (Surface 1, brainstorm) → copy (Surface 2, comment) → gate (Surface 3, review), and the cheapest catch is at the brainstorm surface. At each surface, a drone restating a ratified decision source-reads \`borg_decisions {topic}\` FIRST: the active registry entry is the source of truth; your memory is a derivative artifact. Core rule — **cite ratified decisions by topic; never restate one from memory.**

**Worktree and git mechanism:**

${worktreeMechanism}`;
}
/**
 * Format an absolute timestamp as a coarse "Xs/Xm/Xh ago" string.
 */
export function humanAgo(date) {
    const then = typeof date === 'string' ? new Date(date) : date;
    const ms = Date.now() - then.getTime();
    if (!Number.isFinite(ms) || ms < 0)
        return 'just now';
    const sec = Math.floor(ms / 1000);
    if (sec < 60)
        return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60)
        return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)
        return `${hr}h ago`;
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
 * gh#479 — discoverability tip for message classification. When a
 * cube has no `message_taxonomy` declared, borg_regen + borg_cube append
 * this tip so operators discover how to classify signals and lifecycle. Self-
 * removing: returns '' once a taxonomy exists. Copy is UX-locked
 * (design d45098c1) — keep verbatim.
 */
export function nullTaxonomyTip(messageTaxonomy) {
    const isEmpty = messageTaxonomy == null ||
        (Array.isArray(messageTaxonomy) && messageTaxonomy.length === 0);
    if (!isEmpty)
        return '';
    // copy-param-claim: borg_update-cube.message_taxonomy
    //   The tip says "with a taxonomy array" rather than the literal param name;
    //   this inline marker pins the real inputSchema param so the #490/#529 guard
    //   (client/__tests__/copy-mechanism-guard.test.ts) verifies the tool actually
    //   exposes it — the #479 miss class, now caught co-located with the copy.
    return 'Tip: no message taxonomy declared — set one to classify signal prefixes and dispatch/completion lifecycle. Every borg_log call still requires an explicit to audience. Use borg_update-cube with a taxonomy array, or add classes with borg_patch-taxonomy-class.';
}
export function regenWakePathDroneLabel(result, cachedDroneLabel) {
    return result.drone?.label ?? cachedDroneLabel ?? null;
}
let boilerplateEmittedThisSession = false;
let cachedRoleTextHash = null;
export function __resetRegenSessionState() {
    boilerplateEmittedThisSession = false;
    cachedRoleTextHash = null;
    arrivalAnnouncedThisProcess = false;
}
function safetyDisciplinesForRole(detailedDescription) {
    const text = detailedDescription ?? '';
    const roleScoped = ROLE_SCOPED_SAFETY_DISCIPLINES.filter((discipline) => text.includes(discipline));
    return [...UNIVERSAL_SAFETY_DISCIPLINES, ...roleScoped];
}
export function formatRationalePointer(role, section) {
    return `rationale → borg_role-rationale ${JSON.stringify(role)} ${JSON.stringify(section)}`;
}
export function parseRationalePointer(stub) {
    const match = stub.match(/borg_role-rationale\s+("(?:(?:\\.)|[^"\\])*")\s+("(?:(?:\\.)|[^"\\])*")/);
    if (!match)
        return null;
    try {
        return { role: JSON.parse(match[1]), section: JSON.parse(match[2]) };
    }
    catch {
        return null;
    }
}
/** The full safety-discipline corpus — a `… rationale:` section is NEVER
 * compressed if its body contains ANY of these (⛔ safety-never-compress
 * fail-safe). Over-inclusive on purpose: checks ALL role-scoped disciplines,
 * not just the role's own, so a wrongly-placed LIVE rule can never be stubbed. */
const ALL_SAFETY_DISCIPLINES = [
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
export function compressRoleText(roleName, detailedDescription) {
    const text = detailedDescription ?? '';
    const sections = parseRoleSections(text);
    return sections
        .map((section) => {
        if (section.kind !== 'label' || section.heading == null)
            return section.body;
        const isRationale = section.heading.trim().toLowerCase().endsWith('rationale');
        if (!isRationale)
            return section.body;
        // ⛔ fail-safe: never stub a section carrying any safety-discipline text.
        if (ALL_SAFETY_DISCIPLINES.some((d) => section.body.includes(d)))
            return section.body;
        // Preserve the heading line verbatim; replace the rationale body with the stub.
        const nlIdx = section.body.indexOf('\n');
        const headingLine = nlIdx === -1 ? section.body + '\n' : section.body.slice(0, nlIdx + 1);
        return headingLine + formatRationalePointer(roleName, section.heading) + '\n';
    })
        .join('');
}
export function formatRegenMarkdown(result, opts = {}) {
    const mode = opts.mode ?? 'full';
    const roleOverview = result.roles
        .map((r) => `- **${r.name}**${r.is_default ? ' _(default)_' : ''} — ${r.short_description || '_(no short description)_'}`)
        .join('\n');
    const droneOverview = result.drones
        .map((d) => {
        const role = result.roles.find((r) => r.id === d.role_id);
        return [
            `- **${d.label}** (Role: ${role?.name ?? '?'}) — last seen ${humanAgo(new Date(d.last_seen))}`,
            ...renderRuntimeMetadataLines(d),
        ].join('\n');
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
    const cubeLogSection = unread === null
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
            '**You (this agent):** post `borg_log message="<task>" to="broadcast"`; check `borg_roster`.',
            '**Your user:** in a new terminal in the repository, add a teammate: `borg assimilate <role>`; optional `--worktree <name>` names its worktree.',
            'For "what do I do next?", use `borg_docs`.',
            '',
            '---',
            '',
        ].join('\n')
        : '';
    const taxonomyTip = nullTaxonomyTip(result.cube.message_taxonomy);
    // gh#740: render active ratified decisions concisely (one line each), capped
    // with an elision footer. Empty and failed reads are explicit and distinct;
    // an absent field from a pre-gh#740 worker is omitted. Lives in the
    // always-shown band below so it surfaces on LITE wakes (the mid-session
    // restatement moment), not just the session-start full regen (PM F1).
    const RATIFIED_DECISIONS_CAP = 12;
    const decisionsSection = (() => {
        if (result.decisions_error !== undefined) {
            const errorClass = /^[A-Za-z][A-Za-z0-9]*Error$/.test(result.decisions_error)
                ? result.decisions_error
                : 'UnknownError';
            return [
                '## Ratified decisions',
                `The decision registry could not be read (${errorClass}). Active decisions are unavailable.`,
            ].join('\n');
        }
        if (!Array.isArray(result.decisions))
            return '';
        const activeDecisions = result.decisions;
        if (activeDecisions.length === 0) {
            return ['## Ratified decisions', 'No active decisions are recorded.'].join('\n');
        }
        const shown = activeDecisions.slice(0, RATIFIED_DECISIONS_CAP);
        const lines = shown.map((d) => `- **${d.topic}:** ${d.decision}`);
        const remaining = activeDecisions.length - shown.length;
        if (remaining > 0)
            lines.push(`- _+${remaining} more — \`borg_decisions\`_`);
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
    const sessionStartBlock = 'Before you post or act, load your full operating context — once per session; static, do NOT re-fetch on every wake:\n' +
        '- `borg_playbook` — your full operating disciplines (verification, four-surface propagation, ack / routing / idle detail).\n' +
        '- `borg_cube` — the cube directive + conventions (log vocabulary, project / git / dispatch conventions).';
    const shouldEmitRoleText = mode === 'full' || roleTextHash == null || roleTextHash !== cachedRoleTextHash;
    const shouldEmitPlaybook = mode === 'full' || !boilerplateEmittedThisSession;
    const lines = [
        gettingStarted + `# Cube: ${result.cube.name} — ${result.drone.label}`,
        '',
        `**Your role:** ${result.role.name}`,
        '',
    ];
    if (mode === 'lite') {
        lines.push("_(lite regen — the role playbook may be omitted when unchanged; your operating context (playbook + cube directive) loads via the Session-start block (borg_playbook + borg_cube). If the playbook is NOT in your current context (e.g. after a context-compaction), call `borg_regen mode=\"full\"` to re-orient.)_", '');
    }
    lines.push(
    // gh#917: full forcing block ONLY on bootstrap/compaction-recovery
    // (mode==='full'); a soft 1-liner on lite wakes. Stops a weak model
    // reflexively re-fetching both chapters every wake — which re-inflates
    // per-wake processing toward the 60s timeout the campaign fights.
    mode === 'full' ? `## Session start — required before acting` : `## Session start`, mode === 'full'
        ? sessionStartBlock
        : 'Operating context (playbook + cube directive) was loaded at session start — re-fetch `borg_playbook` / `borg_cube` ONLY after a context-compaction (a `mode="full"` regen), not on every wake.', '', ...(taxonomyTip ? [taxonomyTip, ''] : []), `## Your role: ${result.role.name}`, shouldEmitRoleText
        ? roleText
        : [
            '_(role playbook unchanged since your last full/lite regen; omitted in lite mode)_',
            '',
            ...safetyDisciplinesForRole(result.role.detailed_description),
        ].join('\n'), '', `## Roles in this cube`, roleOverview, '', `## Connected drones`, `_${RUNTIME_METADATA_ADVISORY}_`, '', droneOverview, '', `## Cube log`, cubeLogSection, ...(decisionsSection ? ['', decisionsSection] : []));
    if (shouldEmitPlaybook) {
        lines.push('', getDronePlaybook(opts.handoverMode));
        boilerplateEmittedThisSession = true;
    }
    if (shouldEmitRoleText && roleTextHash != null) {
        cachedRoleTextHash = roleTextHash;
    }
    return lines.join('\n');
}
export function formatLogEntryMarkdown(entry, droneById, roleById) {
    const d = droneById.get(entry.drone_id);
    const r = d ? roleById.get(d.role_id) : null;
    const ts = new Date(entry.created_at).toISOString();
    const entryId = typeof entry.id === 'string' && entry.id.length > 0
        ? ` [entry_id: ${entry.id}]`
        : '';
    // gh#371: the stable short-uuid address token (`id:<8hex>`), distinct from
    // the entry_id bracket above. Address a dispatch to this drone via to:[<id>].
    const addr = typeof entry.drone_id === 'string' && entry.drone_id.length > 0
        ? ` ${formatDroneAddressToken(entry.drone_id)}`
        : '';
    const citations = formatDocumentCitations(entry.documents);
    const recipients = formatLogRecipients(entry, droneById);
    const routed = recipients.length > 0
        ? `\n  Recipients: ${recipients.join(', ')}`
        : '';
    const documents = citations.length > 0
        ? `\n  Documents:\n${citations.map((citation) => `  - ${citation}`).join('\n')}`
        : '';
    return `**[${ts}]**${entryId}${addr} ${d?.label ?? '?'} (${r?.name ?? '?'}): ${entry.message}${routed}${documents}`;
}
export function formatLogRecipients(entry, droneById) {
    if (entry.visibility !== 'direct' || !Array.isArray(entry.recipient_drone_ids))
        return [];
    return entry.recipient_drone_ids.map((droneId) => {
        if (typeof droneId !== 'string')
            return '?';
        const label = droneById.get(droneId)?.label;
        return typeof label === 'string' && label.length > 0
            ? label
            : formatDroneAddressToken(droneId);
    });
}
//# sourceMappingURL=regen-format.js.map