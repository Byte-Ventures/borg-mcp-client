import { describe, expect, it } from 'vitest';
import {
  __resetRegenSessionState,
  formatLogEntryMarkdown,
  getDronePlaybook,
  getDronePlaybookChapter,
  nullTaxonomyTip,
  formatRegenMarkdown,
  regenWakePathDroneLabel,
  compressRoleText,
  parseRationalePointer,
  parseHookSource,
  formatLeanOrientation,
  wakePathArming,
  resolveLeanIdentity,
} from '../src/regen-format';
import { parseRoleSections } from 'borgmcp-shared/role-section';
import { formatWakePathPrefix } from '../src/stream-status';
import {
  GIT_OPERATIONAL_DISCIPLINE_BUILDER,
  GIT_OPERATIONAL_DISCIPLINE_COORDINATOR,
  PUSH_DISCIPLINE_BUILDER,
  PUSH_DISCIPLINE_COORDINATOR,
  WAKE_PATH_MONITOR_DISCIPLINE,
  ESCALATION_DISCIPLINE,
  TEMPLATES,
} from 'borgmcp-shared/templates';

describe('formatLogEntryMarkdown', () => {
  it('includes the activity log entry_id for borg_ack targeting', () => {
    const drones = new Map([
      ['drone-1', { id: 'drone-1', label: 'drone-a', role_id: 'role-1' }],
    ]);
    const roles = new Map([
      ['role-1', { id: 'role-1', name: 'Builder' }],
    ]);

    expect(
      formatLogEntryMarkdown(
        {
          id: 'entry-123',
          drone_id: 'drone-1',
          created_at: '2026-05-28T12:00:00.000Z',
          message: 'DISPATCH: drone-b — fix ack affordance',
        },
        drones,
        roles
      )
    ).toBe(
      // gh#371: each entry now also carries the stable short-uuid address token
      // (`id:<8hex>`), distinct from the [entry_id: …] ack target beside it.
      '**[2026-05-28T12:00:00.000Z]** [entry_id: entry-123] `id:drone-1` drone-a (Builder): DISPATCH: drone-b — fix ack affordance'
    );
  });
});

describe('#921 de-template — universal layer is template-agnostic (STARTER contrast-render, PM leak-detector)', () => {
  it('the UNIVERSAL getDronePlaybook carries NO sw-dev-EXCLUSIVE role-names or workflow signals', () => {
    const u = getDronePlaybook();
    // sw-dev-exclusive role NAMES — a STARTER (Coordinator/Worker/Reviewer) cube has none of these
    for (const n of ['Builder', 'Code Reviewer', 'QA Tester', 'Security Auditor', 'Visionary', 'UX Expert', 'UI Designer', 'Product Manager', 'Coordinator']) {
      expect(u).not.toContain(n);
    }
    // sw-dev-specific workflow signals — STARTER uses FEEDBACK/APPROVED
    for (const s of ['REVIEW-APPROVED', 'REVIEW-FEEDBACK', 'QA-PASS', 'QA-FAIL', 'PUSHING', 'MERGED']) {
      expect(u).not.toContain(s);
    }
    // generic, actionable escalation survives (template-agnostic)
    expect(u).toContain('coordinating role');
  });

  it('keeps escalation and wake-path disciplines generic while preserving safety semantics', () => {
    // Escalation uses the generic coordinating role; Queen (platform) stays.
    expect(ESCALATION_DISCIPLINE).not.toContain('Coordinator');
    expect(ESCALATION_DISCIPLINE).toContain('coordinating role');
    expect(ESCALATION_DISCIPLINE).toContain('Queen');
    // Wake-path guidance stays tool-agnostic and preserves terminal-state safety.
    expect(WAKE_PATH_MONITOR_DISCIPLINE).not.toContain('REVIEW-READY');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).not.toContain('gh#');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).toContain('configured wake mechanism');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).toContain('authoritatively confirms');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).toContain('terminal lifecycle state');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).toContain('reversible suspension');
    expect(WAKE_PATH_MONITOR_DISCIPLINE).toContain('actual heartbeat request');
  });

  it('a STARTER Worker regen is behaviorally coherent: STARTER signals (role-text) + generic universal escalation, no sw-dev bleed', () => {
    const starter = TEMPLATES['starter'];
    const worker = starter.roles.find((r) => r.name === 'Worker')!;
    const result = {
      cube: { name: 'my-cube', cube_directive: 'do the work', message_taxonomy: starter.message_taxonomy },
      role: { name: worker.name, detailed_description: worker.detailed_description },
      drone: { label: 'two-of-three-worker' },
      roles: starter.roles.map((r, i) => ({ id: `r${i}`, name: r.name, short_description: r.short_description ?? '', is_default: !!r.is_default })),
      drones: [{ id: 'r1', label: 'two-of-three-worker', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' }],
      behind_by: 0,
    };
    __resetRegenSessionState();
    const regen = formatRegenMarkdown(result, { mode: 'full' });
    // "finished → what do I post?" — STARTER's OWN signals come from its role-text
    expect(regen).toContain('DONE');
    expect(regen).toContain('REVIEW-READY');
    // "blocked → escalate to whom?" — generic coordinating-role (universal) is actionable for a non-sw-dev cube
    expect(regen).toContain('coordinating role');
    // no sw-dev-EXCLUSIVE workflow-signal bled from the universal layer (getDronePlaybook +
    // the appended ONE_SIGNAL/DENSE_COMM disciplines) into a STARTER drone's regen. (STARTER's
    // OWN role-text legitimately uses DISPATCH/REVIEW-READY/DONE — only the sw-dev-EXCLUSIVE
    // signals STARTER never declares are leak evidence.)
    for (const swDevOnly of ['REVIEW-APPROVED', 'REVIEW-FEEDBACK', 'QA-PASS', 'QA-FAIL', 'PUSHING', 'MERGED', 'SHIPPED']) {
      expect(regen).not.toContain(swDevOnly);
    }
  });
});

describe('getDronePlaybook', () => {
  it('de-templates idle/escalation guidance to a generic coordinating role — no sw-dev role-name, no hard-coded label (gh#921)', () => {
    const playbook = getDronePlaybook();

    // generic coordinating-role phrasing (template-agnostic)
    expect(playbook).toContain('coordinating role');
    // the sw-dev role-NAME is gone (de-templated)
    expect(playbook).not.toContain('Coordinator');
    expect(playbook).not.toContain('Builder');
    expect(playbook).not.toContain('Code Reviewer');
    // never a hard-coded drone label
    expect(playbook).not.toContain('drone-1');
  });

  it('documents the directed-default override discipline (gh#16 / gh#675)', () => {
    const playbook = getDronePlaybook();
    // to:[author] rule — a waited-on recipient must be WOKEN, not left unaware
    expect(playbook).toContain('to:[that drone]');
    expect(playbook).toContain('UNAWARE of their own merge or feedback');
    // gh#675 — multi-seat deliverables widen to broadcast/to:[seats]
    expect(playbook).toContain('multi-seat DELIVERABLE');
    expect(playbook).toContain('visibility:broadcast');
    // SR/CR-verified security model: directed routing is a WAKE mechanism, NOT confidentiality
    expect(playbook).toContain('NOT read-confidentiality');
    expect(playbook).toContain('the cube is the trust boundary');
    expect(playbook).toContain('never post secrets relying on');
  });

  it('introduces the claim kind as advisory ownership + the keyed-on-real-gate invariant, TEMPLATE-AGNOSTICALLY (gh#418 / #921)', () => {
    const playbook = getDronePlaybook();
    // the new kind + how to use it
    expect(playbook).toContain('kind=claim');
    expect(playbook).toContain('advisory');
    // the load-bearing invariant stated GENERICALLY — a claim never substitutes
    // for the real completion/approval gate (the sw-dev REVIEW-APPROVED framing
    // lives in role-text, not this universal layer).
    expect(playbook).toMatch(/NEVER substitutes for the completion or approval signal/);
    expect(playbook).toMatch(/never bypass its real gate/);
    // #921: NO sw-dev-exclusive workflow signal bleeds into the universal layer.
    expect(playbook).not.toContain('REVIEW-APPROVED');
    expect(playbook).not.toContain('REVIEW-READY');
    expect(playbook).not.toContain('gh#');
  });
});

describe('nullTaxonomyTip (gh#479)', () => {
  const TIP_MARKER = 'no message taxonomy declared';

  it('returns the verbatim UX-locked tip when taxonomy is null', () => {
    expect(nullTaxonomyTip(null)).toBe(
      'Tip: no message taxonomy declared — set one to enable intent-based smart routing (#468). Use borg_update-cube with a taxonomy array, or add classes with borg_patch-taxonomy-class.'
    );
  });

  it('returns the tip for undefined and for an empty array (no taxonomy yet)', () => {
    expect(nullTaxonomyTip(undefined)).toContain(TIP_MARKER);
    expect(nullTaxonomyTip([])).toContain(TIP_MARKER);
  });

  it('returns empty string once a taxonomy exists (self-removing)', () => {
    expect(nullTaxonomyTip([{ class: 'status-claim', routing: 'directed' }])).toBe('');
  });
});

describe('formatRegenMarkdown — taxonomy tip (gh#479)', () => {
  const baseResult = (messageTaxonomy: unknown) => ({
    cube: { name: 'borg-mcp', cube_directive: 'do things', message_taxonomy: messageTaxonomy },
    role: { name: 'Builder', detailed_description: 'build' },
    drone: { label: 'two-of-ten-builder' },
    roles: [{ id: 'r1', name: 'Builder', short_description: 'builds', is_default: true }],
    drones: [
      { id: 'd1', label: 'two-of-ten-builder', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' },
      { id: 'd2', label: 'one-of-one-queen', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' },
    ],
    recentLog: [],
  });

  it('appends the tip when the cube has no message_taxonomy', () => {
    const out = formatRegenMarkdown(baseResult(null));
    expect(out).toContain('no message taxonomy declared');
    expect(out).toContain('borg_patch-taxonomy-class');
  });

  it('omits the tip when a taxonomy is declared (self-removing)', () => {
    const out = formatRegenMarkdown(baseResult([{ class: 'status-claim', routing: 'directed' }]));
    expect(out).not.toContain('no message taxonomy declared');
  });

  it('uses the fresh regen drone label for wake-path warning labels', () => {
    const result = baseResult([{ class: 'status-claim', routing: 'directed' }]);
    result.drone.label = 'fresh-server-label';

    const warning = formatWakePathPrefix({
      inboxPath: '/tmp/borg/inbox.log',
      droneLabel: regenWakePathDroneLabel(result, 'stale-cache-label'),
      cubeName: result.cube.name,
    });
    const regen = formatRegenMarkdown(result);

    expect(regen).toContain('# Cube: borg-mcp — fresh-server-label');
    expect(warning).toContain('borg inbox for fresh-server-label on cube borg-mcp');
    expect(warning).not.toContain('stale-cache-label');
  });

  it('shows agent_kind in the connected-drone roster when known', () => {
    const result = baseResult([{ class: 'status-claim', routing: 'directed' }]);
    result.drones = [
      {
        id: 'd1',
        label: 'claude-builder',
        role_id: 'r1',
        agent_kind: 'claude',
        last_seen: '2026-05-30T12:00:00.000Z',
      },
      {
        id: 'd2',
        label: 'legacy-builder',
        role_id: 'r1',
        agent_kind: null,
        last_seen: '2026-05-30T12:00:00.000Z',
      },
    ];

    const out = formatRegenMarkdown(result);

    expect(out).toContain('**claude-builder** (Role: Builder · Agent CLI: Claude Code)');
    expect(out).toContain('**legacy-builder** (Role: Builder · Agent CLI: not reported) — last seen');
    expect(out).not.toContain('Agent CLI: null');
  });
});

describe('formatRegenMarkdown — lite mode (gh#496-B)', () => {
  const baseResult = (roleText = 'Workflow:\nBuild things.') => ({
    cube: {
      name: 'borg-mcp',
      cube_directive: 'directive body',
      directive_hash: 'directive-hash-1',
      message_taxonomy: [{ class: 'status-claim', routing: 'directed' }],
    },
    role: {
      name: 'Builder',
      detailed_description: roleText,
      detailed_description_hash: 'role-hash-1',
    },
    drone: { label: 'two-of-ten-builder' },
    roles: [{ id: 'r1', name: 'Builder', short_description: 'builds', is_default: true }],
    drones: [
      { id: 'd1', label: 'two-of-ten-builder', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' },
    ],
    recentLog: [
      {
        id: 'entry-1',
        drone_id: 'd1',
        created_at: '2026-05-30T12:01:00.000Z',
        message: 'READY: capacity clean',
      },
    ],
  });

  // gh#496-A(b): full mode renders the COMPRESSED-core role text (`… rationale:`
  // sections become on-demand stubs). The old "full == raw stored bytes"
  // invariant is REPLACED by the Σ-reconstruct completeness test below.
  it('full and default mode are identical, and render compressed-core role text', () => {
    const result = baseResult(
      'Workflow:\n- build things\n\nDesign rationale:\nWHY we build this way and case studies.\n'
    );
    __resetRegenSessionState();
    const defaultOut = formatRegenMarkdown(result);
    __resetRegenSessionState();
    const fullOut = formatRegenMarkdown(result, { mode: 'full' });

    expect(fullOut).toBe(defaultOut); // default === full (both full mode)
    // gh#912-followup: directive is no longer inlined — full mode emits the borg_cube pointer.
    expect(fullOut).toContain('borg_cube');
    expect(fullOut).not.toContain('directive body');
    expect(fullOut).toContain('## How to operate as a Drone');
    // Core operational text stays inline; rationale prose compresses to a stub.
    expect(fullOut).toContain('Workflow:\n- build things');
    expect(fullOut).toContain('Design rationale:');
    expect(fullOut).toContain('borg_role-rationale "Builder" "Design rationale"');
    expect(fullOut).not.toContain('WHY we build this way and case studies');
  });

  it('completeness (replaces T8): compressed-core + every resolved stub reconstructs stored', () => {
    const stored =
      'You are a Builder.\n\nWorkflow:\n- do thing\n\nGit discipline rationale:\nWHY git hygiene matters.\nmore why.\n\nProject conventions:\n- TDD\n';
    const compressed = compressRoleText('Builder', stored);
    // The drone sees stubs, not the rationale prose.
    expect(compressed).not.toContain('WHY git hygiene matters');
    expect(compressed).toContain('borg_role-rationale');

    // Simulate getRoleRationale: resolve a heading against the STORED text.
    const storedSections = parseRoleSections(stored);
    const resolve = (heading: string) =>
      storedSections.find((s) => s.kind === 'label' && s.heading === heading)?.body ?? '__MISSING__';

    // Reconstruct stored from the COMPRESSED render by restoring each stub's
    // body via getRoleRationale — nothing is lost (contract #1).
    const reconstructed = parseRoleSections(compressed)
      .map((s) => {
        if (s.kind !== 'label' || s.heading == null) return s.body;
        const stubLine = s.body.split('\n').find((l) => l.includes('borg_role-rationale'));
        if (!stubLine) return s.body;
        const parsed = parseRationalePointer(stubLine);
        return parsed ? resolve(parsed.section) : s.body;
      })
      .join('');

    expect(reconstructed).toBe(stored);
  });

  it('omits unchanged invariant slices in lite mode after a full regen', () => {
    const result = baseResult();
    __resetRegenSessionState();
    formatRegenMarkdown(result, { mode: 'full' });

    const lite = formatRegenMarkdown(result, { mode: 'lite' });

    expect(lite).toContain('lite regen');
    expect(lite).toContain('context-compaction');
    expect(lite).not.toContain('directive body');
    expect(lite).not.toContain('Workflow:\nBuild things.');
    expect(lite).not.toContain('## How to operate as a Drone');
    // gh#886: the cube-log section still renders in lite mode, but as the
    // unread-count instruction — NOT the inlined recentLog payload.
    expect(lite).toContain('## Cube log');
    expect(lite).not.toContain('READY: capacity clean');
  });

  it('still renders fresh regen identity in lite mode', () => {
    const result = baseResult();
    __resetRegenSessionState();
    formatRegenMarkdown(result, { mode: 'full' });
    result.drone.label = 'fresh-lite-label';

    const lite = formatRegenMarkdown(result, { mode: 'lite' });

    expect(lite).toContain('# Cube: borg-mcp — fresh-lite-label');
    expect(lite).not.toContain('# Cube: borg-mcp — two-of-ten-builder');
  });

  it('re-emits role text and directive when their content hashes change', () => {
    const result = baseResult();
    __resetRegenSessionState();
    formatRegenMarkdown(result, { mode: 'full' });

    const changed = baseResult('Workflow:\nChanged playbook.');
    changed.role.detailed_description_hash = 'role-hash-2';
    changed.cube.cube_directive = 'changed directive';
    changed.cube.directive_hash = 'directive-hash-2';
    const lite = formatRegenMarkdown(changed, { mode: 'lite' });

    // gh#912-followup: the directive body is never inlined now (always a borg_cube
    // pointer); only the role text re-emits on a hash change.
    expect(lite).not.toContain('changed directive');
    expect(lite).toContain('borg_cube');
    expect(lite).toContain('Workflow:\nChanged playbook.');
  });

  it('always emits universal and applicable role-scoped safety disciplines in lite mode', () => {
    const roleText = [
      'Workflow:',
      'Build things.',
      WAKE_PATH_MONITOR_DISCIPLINE,
      GIT_OPERATIONAL_DISCIPLINE_BUILDER,
      PUSH_DISCIPLINE_BUILDER,
    ].join('\n');
    const result = baseResult(roleText);
    __resetRegenSessionState();
    formatRegenMarkdown(result, { mode: 'full' });

    const lite = formatRegenMarkdown(result, { mode: 'lite' });

    expect(lite).toContain('configured wake mechanism');
    expect(lite).toContain('Pre-push announcement discipline');
    expect(lite).toContain('The initial `git push` to a feature branch');
    expect(lite).not.toContain('Merge-announcement discipline');
    expect(lite).not.toContain('Coordinator runs all merges');
  });

  it('does not emit Builder-scoped push discipline for Coordinator lite output', () => {
    const roleText = [
      'Workflow:',
      'Coordinate things.',
      WAKE_PATH_MONITOR_DISCIPLINE,
      GIT_OPERATIONAL_DISCIPLINE_COORDINATOR,
      PUSH_DISCIPLINE_COORDINATOR,
    ].join('\n');
    const result = baseResult(roleText);
    result.role.name = 'Coordinator';
    __resetRegenSessionState();
    formatRegenMarkdown(result, { mode: 'full' });

    const lite = formatRegenMarkdown(result, { mode: 'lite' });

    expect(lite).toContain('configured wake mechanism');
    expect(lite).toContain('Merge-announcement discipline');
    expect(lite).toContain('Coordinator runs all merges');
    expect(lite).not.toContain('Pre-push announcement discipline');
    expect(lite).not.toContain('The initial `git push` to a feature branch');
  });
});

describe('formatRegenMarkdown — cube log out of regen (gh#886)', () => {
  const LOG_ENTRY_TEXT = 'DISPATCH: drone-b — do the thing';
  const result = (over: { behind_by?: number; recentLog?: any[] }) => ({
    cube: { name: 'borg-mcp', cube_directive: 'do things', message_taxonomy: [{ class: 'status-claim', routing: 'directed' }] },
    role: { name: 'Builder', detailed_description: 'build' },
    drone: { label: 'two-of-ten-builder' },
    roles: [{ id: 'r1', name: 'Builder', short_description: 'builds', is_default: true }],
    drones: [
      { id: 'd1', label: 'two-of-ten-builder', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' },
      { id: 'd2', label: 'one-of-one-queen', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' },
    ],
    recentLog: over.recentLog,
    behind_by: over.behind_by,
  });
  const sampleLog = [
    { id: 'e1', drone_id: 'd1', created_at: '2026-05-30T12:00:00.000Z', message: LOG_ENTRY_TEXT },
  ];

  it('renders a smart unread-count instruction (NOT the log payload) when behind_by > 0', () => {
    const out = formatRegenMarkdown(result({ behind_by: 3, recentLog: sampleLog }));
    expect(out).toContain('## Cube log');
    expect(out).toContain('You have **3** unread log entries');
    expect(out).toContain('borg_read-log unread_only=true');
    // the payload itself is NOT inlined — the whole point of gh#886
    expect(out).not.toContain(LOG_ENTRY_TEXT);
  });

  it('uses singular "entry" for exactly 1 unread', () => {
    const out = formatRegenMarkdown(result({ behind_by: 1, recentLog: sampleLog }));
    expect(out).toContain('You have **1** unread log entry.');
    expect(out).not.toContain(LOG_ENTRY_TEXT);
  });

  it('renders a caught-up message when behind_by === 0', () => {
    const out = formatRegenMarkdown(result({ behind_by: 0, recentLog: [] }));
    expect(out).toContain('## Cube log');
    expect(out).toContain("caught up — **0** unread log entries");
    // the >0 drain instruction must NOT be present when caught up
    expect(out).not.toContain('Drain them with');
    expect(out).not.toContain('You have **');
  });

  it('null-safety: behind_by absent → renders the drain instruction (no number), never the payload, never crashes', () => {
    // worker is a single atomic deploy + always sends behind_by; this only
    // defends the brief new-worker-meets-not-yet-updated-client skew.
    const out = formatRegenMarkdown(result({ recentLog: sampleLog })); // no behind_by
    expect(out).toContain('## Cube log');
    expect(out).toContain('borg_read-log unread_only=true');
    expect(out).not.toContain(LOG_ENTRY_TEXT); // payload never inlined
  });
});

describe('cube directive → borg_cube pointer (gh#912-followup directive-chapter)', () => {
  const DIRECTIVE_BODY = 'SECRET-DIRECTIVE-BODY: build the widget per these opaque user conventions.';
  const result = (over: { mode?: 'full' | 'lite' } = {}) => formatRegenMarkdown({
    cube: { name: 'borg-mcp', cube_directive: DIRECTIVE_BODY, message_taxonomy: [{ class: 'status-claim', routing: 'directed' }] },
    role: { name: 'Builder', detailed_description: 'build' },
    drone: { label: 'two-of-ten-builder' },
    roles: [{ id: 'r1', name: 'Builder', short_description: 'builds', is_default: true }],
    drones: [{ id: 'd1', label: 'two-of-ten-builder', role_id: 'r1', last_seen: '2026-05-30T12:00:00.000Z' }],
    behind_by: 0,
  }, over);

  it('emits the consolidated session-start fetch block instead of the inline directive body (bootstrap/full)', () => {
    __resetRegenSessionState();
    const out = result({ mode: 'full' });
    expect(out).toContain('## Session start — required before acting');
    // ONE block lists BOTH fetches (consolidated, uniform — no competing pointers)
    expect(out).toContain('borg_cube');
    expect(out).toContain('borg_playbook');
    // the opaque directive body is NOT inlined — the whole point of the cut
    expect(out).not.toContain(DIRECTIVE_BODY);
  });

  it('never inlines the directive body, in lite mode either', () => {
    __resetRegenSessionState();
    result({ mode: 'full' }); // prime session caches
    const lite = result({ mode: 'lite' });
    expect(lite).not.toContain(DIRECTIVE_BODY);
  });

  // gh#917: the FULL forcing block only on bootstrap/compaction (mode==='full');
  // lite wakes get a SOFT 1-liner so a weak model doesn't reflexively re-fetch.
  it('gates the forcing block: full = required-before-acting block; lite = soft re-fetch-after-compaction reminder', () => {
    __resetRegenSessionState();
    const full = result({ mode: 'full' });
    expect(full).toContain('## Session start — required before acting');
    expect(full).toContain('Before you post or act, load your full operating context');

    const lite = result({ mode: 'lite' });
    expect(lite).toContain('## Session start');
    expect(lite).not.toContain('## Session start — required before acting'); // not the forcing heading
    expect(lite).not.toContain('Before you post or act, load your full operating context'); // not the full block
    expect(lite).toContain('after a context-compaction'); // the soft reminder
  });
});

describe('DRONE_PLAYBOOK core/chapter split (gh#912)', () => {
  it('CORE (getDronePlaybook) keeps the rule-spine + triggers + safety inline', () => {
    const core = getDronePlaybook();
    // triggers / forcing-functions (PM rail — survive preferentially)
    expect(core).toContain('ARRIVAL:');
    expect(core).toContain('borg_ack');
    expect(core).toContain('availability signal'); // gh#921: de-templated from the literal `READY:` to generic anti-passive phrasing
    expect(core).toContain('to:[that drone]');
    expect(core).toContain('multi-seat DELIVERABLE');
    expect(core).toContain('NOT read-confidentiality');
    // verification rule-spine stays inline (the RULE, not the depth)
    expect(core).toContain('Verify factual claims');
    expect(core).toContain('SOURCE-OF-TRUTH');
    // safety floor stays inline (SEC rail)
    expect(core).toContain('git diff --staged --stat');
    expect(core).toContain('borg_read-log unread_only=true');
    // the smart pointer to the chapter
    expect(core).toContain('borg_playbook');
  });

  it('CORE drops the verbose detail/WHY/case-studies (moved to the chapter)', () => {
    const core = getDronePlaybook();
    expect(core).not.toContain('Four-surface propagation');
    expect(core).not.toContain('Surface 1 (brainstorm-proposal time)');
    expect(core).not.toContain('PR-B 5-drone cascade-failure'); // empirical case study
    expect(core).not.toContain('v3 (end-to-end execution path'); // v1/v2/v3 depth
  });

  it('CHAPTER (getDronePlaybookChapter) carries the moved teachable detail', () => {
    const chapter = getDronePlaybookChapter();
    expect(chapter).toContain('Four-surface propagation');
    expect(chapter).toContain('Surface 1 (brainstorm-proposal time)');
    expect(chapter).toContain('v3 (end-to-end execution path');
    expect(chapter).toContain('Concrete verification surfaces by claim type');
  });

  it('CHAPTER strips dev-tracking refs + internal-incident case studies (gh#914 STAGE 2 / directive-1)', () => {
    const chapter = getDronePlaybookChapter();
    // the empirical case-studies block (pure internal-incident provenance) is removed
    expect(chapter).not.toContain('PR-B 5-drone cascade-failure');
    expect(chapter).not.toContain('Empirical case studies');
    // dev-tracking refs a borgmcp user can't resolve are stripped
    expect(chapter).not.toContain('Refinement #13');
    expect(chapter).not.toContain('gh#68');
    expect(chapter).not.toContain('gh#39');
    expect(chapter).not.toContain('Sprint 8');
  });

  it('CHAPTER does not duplicate the inline rule-spine sections (no double-render)', () => {
    const chapter = getDronePlaybookChapter();
    // operating-loop / idle / routing rule-spine stays ONLY in the core
    expect(chapter).not.toContain('READY:');
    expect(chapter).not.toContain('multi-seat DELIVERABLE');
  });
});

describe('parseHookSource', () => {
  it('extracts source from a SessionStart hook payload', () => {
    const raw = JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'clear',
      session_id: 'abc',
    });
    expect(parseHookSource(raw)).toBe('clear');
  });

  it('returns the startup source for a normal launch payload', () => {
    expect(parseHookSource(JSON.stringify({ source: 'startup' }))).toBe('startup');
  });

  it('returns null when the payload has no source field', () => {
    expect(parseHookSource(JSON.stringify({ hook_event_name: 'SessionStart' }))).toBeNull();
  });

  it('returns null for empty input (manual / TTY run, no stdin)', () => {
    expect(parseHookSource('')).toBeNull();
    expect(parseHookSource('   ')).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(parseHookSource('{not json')).toBeNull();
  });

  it('returns null when source is not a string', () => {
    expect(parseHookSource(JSON.stringify({ source: 42 }))).toBeNull();
  });
});

// gh#927 S3: formatClearReorientation (gh#926) is superseded by
// formatLeanOrientation({ source: 'clear' }); its /clear behavior is covered
// by the formatLeanOrientation tests below (the /clear-note + wake-path-arming
// + borg_regen-pointer cases).

describe('wakePathArming', () => {
  const inboxPath =
    '/home/u/.config/borgmcp/inboxes/d63afd65-73b7-473a-a969-6cefa10d5c87/3336cde1-a76e-4e89-8bc2-77c149bb6a74.log';
  const monitorStateRoot = '/home/u/repo/.borgmcp/inbox-monitor';

  describe('claude', () => {
    const arming = wakePathArming('claude', inboxPath, monitorStateRoot);

    it('uses one adaptive Claude recovery deadline without stacking wake timers', () => {
      expect(arming).toContain('inbox-monitor');
      expect(arming).toContain('--state-root');
      expect(arming).toContain(monitorStateRoot);
      expect(arming).toContain(inboxPath);
      expect(arming).toContain('/loop');
      expect(arming).toContain('ScheduleWakeup');
      expect(arming).toMatch(/adaptive recovery deadline/i);
      expect(arming).toContain('[9000, 12600]');
      expect(arming).toContain('[720, 1080]');
      expect(arming).toMatch(/healthy or indeterminate/i);
      expect(arming).toMatch(/explicitly.*broken/i);
      expect(arming).toMatch(/resets.*not stacks/i);
      expect(arming).not.toContain('3600');
    });

    it('makes an empty recovery tick a cheap wake-status check before prior work resumes', () => {
      expect(arming).toContain('borg_read-log unread_only=true');
      expect(arming).toMatch(/if.*empty/i);
      expect(arming).toMatch(/do not.*full-regen/i);
      expect(arming).toMatch(/do not.*liveness post/i);
      expect(arming).toMatch(/re-arm.*retry.*until healthy/i);
      expect(arming).toMatch(/resume prior work/i);
      expect(arming).toContain('reduces client fallback churn');
      expect(arming).not.toContain('zero idle-wake cost');
    });
  });

  describe('codex', () => {
    const arming = wakePathArming('codex', inboxPath);

    it('requires the supported stream/inbox/log-drain path without Claude-only setup', () => {
      expect(arming.toLowerCase()).toContain('app-server');
      expect(arming).toContain('Borg activity stream');
      expect(arming).toContain('inbox wake channel');
      expect(arming).toContain('borg_read-log unread_only=true');
      expect(arming).toContain('Degraded fallback');
      expect(arming).toContain('borg_regen mode="full"');
      expect(arming).not.toContain('borg-inbox-monitor');
      expect(arming).not.toContain('/loop');
      expect(arming).not.toContain('ScheduleWakeup');
    });
  });

  describe('opencode', () => {
    const arming = wakePathArming('opencode', inboxPath);

    it('retains its native injected wake path without Claude recovery deadlines', () => {
      expect(arming).toContain('SDK-driven entry injection');
      expect(arming).not.toContain('adaptive recovery deadline');
      expect(arming).not.toContain('[9000, 12600]');
      expect(arming).not.toContain('[720, 1080]');
    });
  });
});

describe('formatLeanOrientation', () => {
  const base = {
    cubeName: 'acme-cube',
    droneLabel: 'three-of-five-builder',
    roleName: 'Builder',
    inboxPath:
      '/home/u/.config/borgmcp/inboxes/d63afd65-73b7-473a-a969-6cefa10d5c87/3336cde1-a76e-4e89-8bc2-77c149bb6a74.log',
    monitorStateRoot: '/home/u/repo/.borgmcp/inbox-monitor',
    agentKind: 'claude' as const,
  };

  it('renders the drone identity: cube name, drone label, role', () => {
    const out = formatLeanOrientation(base);
    expect(out).toContain('acme-cube');
    expect(out).toContain('three-of-five-builder');
    expect(out).toContain('Builder');
  });

  it('uses a TEMPLATE-AGNOSTIC escalation line — no hardcoded coordinator/drone-1 (#921)', () => {
    const out = formatLeanOrientation(base);
    expect(out.toLowerCase()).toContain('coordinating role');
    expect(out).not.toContain('drone-1');
    expect(out).not.toMatch(/coordinator \(drone-1\)/i);
  });

  it('keeps the borg_regen pointer in EVERY render (path to the safety floor — SEC check)', () => {
    expect(formatLeanOrientation(base)).toContain('borg_regen');
    expect(formatLeanOrientation({ ...base, source: 'clear' })).toContain('borg_regen');
    expect(formatLeanOrientation({ ...base, agentKind: 'codex' })).toContain('borg_regen');
  });

  it('requires the full context-loading sequence before acting or posting', () => {
    const out = formatLeanOrientation(base);
    expect(out).toMatch(/required before acting or posting/i);
    expect(out).toContain('borg_regen mode="full"');
    expect(out).toContain('borg_cube');
    expect(out).toContain('cube directive');
    expect(out).toContain('borg_role');
    expect(out).toMatch(/own role (playbook|details)/i);
    expect(out).toMatch(/borg_playbook.*once per session/i);
    expect(out).toMatch(/do not proceed until/i);

    expect(out.indexOf('borg_regen mode="full"')).toBeLessThan(out.indexOf('borg_cube'));
    expect(out.indexOf('borg_cube')).toBeLessThan(out.indexOf('borg_role'));
    expect(out.indexOf('borg_role')).toBeLessThan(out.indexOf('borg_playbook'));
  });

  it('embeds the adaptive Claude Monitor/loop recovery deadline', () => {
    const out = formatLeanOrientation(base);
    expect(out).toContain('inbox-monitor');
    expect(out).toContain('--state-root');
    expect(out).toContain(base.monitorStateRoot);
    expect(out).toContain('/loop');
    expect(out).toContain('ScheduleWakeup');
    expect(out).toContain('[9000, 12600]');
    expect(out).toContain('[720, 1080]');
  });

  it('embeds the required Codex stream/inbox/log-drain wake path', () => {
    const out = formatLeanOrientation({ ...base, agentKind: 'codex' });
    expect(out.toLowerCase()).toContain('app-server');
    expect(out).toContain('Borg activity stream');
    expect(out).toContain('inbox wake channel');
    expect(out).toContain('borg_read-log unread_only=true');
    expect(out).toContain('Degraded fallback');
    expect(out).not.toContain('borg-inbox-monitor');
    expect(out).not.toContain('/loop');
    expect(out).not.toContain('ScheduleWakeup');
  });

  it('adds a /clear-specific note when Claude wake state was cleared', () => {
    const out = formatLeanOrientation({ ...base, source: 'clear' });
    expect(out).toContain('/clear');
  });

  it('adds the compact Claude quiet-clear fallback and wake-path re-arm', () => {
    const out = formatLeanOrientation({ ...base, source: 'clear' });
    expect(out).toMatch(/quiet-clear fallback.*later turn.*silence/i);
    expect(out).toContain('borg_stream-status');
    expect(out).toContain('borg_roster');
    expect(out).toContain('borg_regen mode="full"');
    expect(out).toContain('borg_read-log unread_only=true');
    expect(out).toContain('Monitor');
    expect(out).toContain('/loop');
    expect(out).toContain('ScheduleWakeup');
  });

  it('keeps the quiet-clear fallback out of Codex and OpenCode orientation', () => {
    for (const agentKind of ['codex', 'opencode'] as const) {
      const out = formatLeanOrientation({ ...base, agentKind, source: 'clear' });
      expect(out).not.toContain('borg_stream-status');
      expect(out).not.toContain('borg_roster');
      expect(out).not.toContain('Quiet-clear fallback');
    }
  });

  it('uses a codex-specific /clear note without Claude-only loop or ScheduleWakeup instructions', () => {
    const out = formatLeanOrientation({ ...base, agentKind: 'codex', source: 'clear' });
    expect(out).toContain('/clear');
    expect(out).toContain('remote-control wake');
    expect(out).not.toContain('ScheduleWakeup');
    expect(out).not.toContain('/loop');
  });

  it('omits the /clear note for non-clear sources', () => {
    expect(formatLeanOrientation({ ...base, source: 'startup' })).not.toContain('/clear');
    expect(formatLeanOrientation(base)).not.toContain('/clear');
    for (const source of ['startup', 'resume', 'compact']) {
      expect(formatLeanOrientation({ ...base, source })).not.toContain('borg_stream-status');
      expect(formatLeanOrientation({ ...base, source })).not.toContain('borg_roster');
    }
  });

  it('degrades gracefully when roleName is absent (net-free fallback from local state)', () => {
    const out = formatLeanOrientation({ ...base, roleName: undefined });
    // must still render without throwing and still carry the borg_regen pointer
    expect(out).toContain('acme-cube');
    expect(out).toContain('borg_regen');
  });

  it('stays under the ~2KB SessionStart preview budget for every source/agent combo', () => {
    for (const agentKind of ['claude', 'codex', 'opencode'] as const) {
      for (const source of [undefined, 'startup', 'clear', 'compact', 'resume']) {
        const out = formatLeanOrientation({ ...base, agentKind, source });
        // gh#client#18: absolute bin paths (self-path.ts) add ~52 bytes vs bare
        // names; the Claude Code preview truncation is ~2KB but not exact.
        expect(Buffer.byteLength(out, 'utf-8')).toBeLessThan(2200);
      }
    }
  });
});

describe('resolveLeanIdentity', () => {
  const active = { name: 'local-cube', droneLabel: 'local-label', roleName: 'Builder' };

  it('prefers the fresh regen result identity when present', () => {
    const result = {
      cube: { name: 'fresh-cube' },
      drone: { label: 'fresh-label' },
      role: { name: 'Coordinator' },
    };
    expect(resolveLeanIdentity(active, result)).toEqual({
      cubeName: 'fresh-cube',
      droneLabel: 'fresh-label',
      roleName: 'Coordinator',
    });
  });

  it('falls back to local active state for any field the result omits', () => {
    expect(resolveLeanIdentity(active, { cube: {}, drone: {}, role: {} })).toEqual({
      cubeName: 'local-cube',
      droneLabel: 'local-label',
      roleName: 'Builder',
    });
  });

  it('uses local state entirely when result is null (net-free fallback on regen failure)', () => {
    expect(resolveLeanIdentity(active, null)).toEqual({
      cubeName: 'local-cube',
      droneLabel: 'local-label',
      roleName: 'Builder',
    });
  });

  it('renders roleName null when neither result nor local state has it (graceful)', () => {
    const noRole = { name: 'local-cube', droneLabel: 'local-label' };
    expect(resolveLeanIdentity(noRole, null).roleName).toBeNull();
  });
});

describe('formatRegenMarkdown — Ratified decisions section (gh#740)', () => {
  const baseResult = (decisions?: any[]) => ({
    cube: { name: 'borg-mcp', message_taxonomy: [] },
    role: { name: 'Builder', detailed_description: 'Workflow:\nBuild.', detailed_description_hash: 'h1' },
    drone: { label: 'd-1' },
    roles: [{ id: 'r1', name: 'Builder', short_description: 'builds', is_default: true }],
    drones: [{ id: 'd1', label: 'd-1', role_id: 'r1', last_seen: '2026-06-21T12:00:00.000Z' }],
    behind_by: 0,
    ...(decisions !== undefined ? { decisions } : {}),
  });

  it('renders active decisions one-line each under "Ratified decisions" — IN LITE output (PM F1)', () => {
    __resetRegenSessionState();
    const out = formatRegenMarkdown(
      baseResult([
        { topic: 'pricing-model', decision: 'pooled, not per-cube' },
        { topic: 'release-cadence', decision: 'ship-on-consensus' },
      ]),
      { mode: 'lite' },
    );
    expect(out).toContain('## Ratified decisions');
    expect(out).toContain('**pricing-model:** pooled, not per-cube');
    expect(out).toContain('**release-cadence:** ship-on-consensus');
    // the cite-don't-restate nudge rides with the section
    expect(out).toContain('do NOT restate a ratified decision from memory');
  });

  it('omits the section entirely when there are no active decisions (no empty header)', () => {
    __resetRegenSessionState();
    expect(formatRegenMarkdown(baseResult([]), { mode: 'lite' })).not.toContain('## Ratified decisions');
  });

  it('mixed-client: a pre-gh#740 worker (no decisions field) → section omitted, no crash', () => {
    __resetRegenSessionState();
    expect(formatRegenMarkdown(baseResult(undefined), { mode: 'lite' })).not.toContain('## Ratified decisions');
  });

  it('past the cap (12), renders the first 12 + a "+N more — borg_decisions" elision footer', () => {
    __resetRegenSessionState();
    const many = Array.from({ length: 15 }, (_, i) => ({ topic: `t-${i}`, decision: `d-${i}` }));
    const out = formatRegenMarkdown(baseResult(many), { mode: 'lite' });
    expect(out).toContain('**t-0:** d-0');
    expect(out).toContain('**t-11:** d-11');
    expect(out).not.toContain('**t-12:** d-12'); // capped
    expect(out).toContain('+3 more — `borg_decisions`');
  });
});

describe('getDronePlaybookChapter — ratified-decision discipline (gh#740)', () => {
  it('the per-claim-type verification list includes the ratified-decision → borg_decisions surface (PM F3a)', () => {
    const ch = getDronePlaybookChapter();
    expect(ch).toContain('Ratified cube decision → `borg_decisions {topic}`');
    expect(ch).toMatch(/NEVER restate a ratified decision from memory/);
  });
  it('four-surface propagation names ratified-decision drift as a drift-class (PM F3b)', () => {
    const ch = getDronePlaybookChapter();
    expect(ch).toContain('Ratified-decision drift is a four-surface drift-class');
    expect(ch).toContain('cite ratified decisions by topic; never restate one from memory');
    // names the brainstorm / comment / review surfaces (the gh#738 path)
    expect(ch).toContain('Surface 1, brainstorm');
    expect(ch).toContain('Surface 3, review');
  });
});
