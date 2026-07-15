import { describe, it, expect } from 'vitest';
import { renderSyncRolesResult, type NonClobberSyncResult } from '../src/sync-roles-render';

/**
 * gh#473 PR2 — the conflict-surfacing output is UX-LOAD-BEARING. The
 * dry-run MUST clearly communicate each conflict (which role/section or
 * taxonomy class, cube-current vs template-new, and how to accept) so the
 * operator SEES what would be clobbered. These tests pin that copy.
 */

const baseResult = (over: Partial<NonClobberSyncResult> = {}): NonClobberSyncResult => ({
  dryRun: true,
  roles: [],
  taxonomy: [],
  applied: { added: [], acceptedConflicts: [] },
  rejectedConflicts: [],
  ...over,
});

describe('renderSyncRolesResult — conflict surfacing', () => {
  it('surfaces a role-section CONFLICT with both sides + the accept key', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            {
              key: 'role:Builder:section:Workflow',
              kind: 'conflict',
              label: 'Workflow',
              cubeValue: 'Workflow:\nBranch off wt-*. EVOLVED.\n',
              templateValue: 'Workflow:\nBranch off wt-*.\n',
            },
          ],
        },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    // Names the role + section.
    expect(out).toContain('Builder');
    expect(out).toContain('Workflow');
    // Surfaces both sides so the operator sees what would be clobbered.
    expect(out).toContain('EVOLVED');
    // Shows the stable accept key.
    expect(out).toContain('role:Builder:section:Workflow');
    // Tells the operator HOW to accept.
    expect(out.toLowerCase()).toMatch(/accept/);
    // Causation-neutral CONFLICT headline (UX 6dea4c27): a 2-way CONFLICT is
    // cube-current ≠ template-new — it does NOT prove the cube evolved the
    // fragment (the template may have changed an untouched one). The headline
    // must NOT over-claim "your cube has EVOLVED" for ALL conflicts.
    expect(out).toContain('differ between your cube and the template');
    expect(out).not.toContain('your cube has EVOLVED');
  });

  it('marks ADD fragments as safe auto-apply (no conflict noise)', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            {
              key: 'role:Builder:section:Project conventions',
              kind: 'add',
              label: 'Project conventions',
              cubeValue: null,
              templateValue: 'Project conventions:\nUse TDD.\n',
            },
          ],
        },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out).toMatch(/add|auto-?appl/i);
    expect(out).toContain('Project conventions');
  });

  it('surfaces a taxonomy-class CONFLICT with its accept key', () => {
    const result = baseResult({
      taxonomy: [
        {
          key: 'taxonomy:class:status-claim',
          kind: 'conflict',
          label: 'status-claim',
          cubeValue: '{"class":"status-claim","default_to":["coordinator","queen"]}',
          templateValue: '{"class":"status-claim","default_to":["coordinator"]}',
        },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out).toContain('status-claim');
    expect(out).toContain('taxonomy:class:status-claim');
    expect(out).toContain('queen'); // the evolved cube value is shown
  });

  it('reports the no-clobber default explicitly when conflicts exist', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            { key: 'role:Builder:section:Workflow', kind: 'conflict', label: 'Workflow', cubeValue: 'a', templateValue: 'b' },
          ],
        },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    // Communicates that conflicts are KEPT (rejected) unless explicitly accepted.
    expect(out.toLowerCase()).toMatch(/keep|kept|reject|not.*applied/);
  });

  it('an all-unchanged sync reads as a clean no-op', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            { key: 'role:Builder:section:Workflow', kind: 'unchanged', label: 'Workflow', cubeValue: 'x', templateValue: 'x' },
          ],
        },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out.toLowerCase()).toMatch(/up to date|no change|in sync|unchanged/);
  });

  it('APPLIED mode reports what was applied and what was kept', () => {
    const result = baseResult({
      dryRun: false,
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            { key: 'role:Builder:section:Workflow', kind: 'conflict', label: 'Workflow', cubeValue: 'a', templateValue: 'b' },
            { key: 'role:Builder:section:Extra', kind: 'add', label: 'Extra', cubeValue: null, templateValue: 'Extra:\nx\n' },
          ],
        },
      ],
      applied: { added: ['role:Builder:section:Extra'], acceptedConflicts: [] },
      rejectedConflicts: ['role:Builder:section:Workflow'],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out).toContain('APPLIED');
    // The kept (rejected) conflict is reported.
    expect(out).toContain('role:Builder:section:Workflow');
    // The applied add is reported.
    expect(out).toContain('role:Builder:section:Extra');
  });

  it('warns about unmatched decision keys (typo / stale — dropped accept)', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            { key: 'role:Builder:section:Workflow', kind: 'conflict', label: 'Workflow', cubeValue: 'a', templateValue: 'b' },
          ],
        },
      ],
      unmatchedDecisions: ['role:Builder:section:Wrkflow', 'role:Ghost:section:Nope'],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    // Warns + states the count.
    expect(out).toMatch(/⚠.*2 decision key/);
    // Says the intended accept had no effect (under-communication guard).
    expect(out.toLowerCase()).toMatch(/ignored|no effect|matched no conflict/);
    // Echoes the exact offending keys.
    expect(out).toContain('role:Builder:section:Wrkflow');
    expect(out).toContain('role:Ghost:section:Nope');
  });

  it('does not emit the unmatched-decisions warning when all keys matched', () => {
    const result = baseResult({
      roles: [
        {
          name: 'Builder',
          status: 'existing',
          fragments: [
            { key: 'role:Builder:section:Workflow', kind: 'conflict', label: 'Workflow', cubeValue: 'a', templateValue: 'b' },
          ],
        },
      ],
      unmatchedDecisions: [],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out).not.toMatch(/matched no conflict/);
  });

  it('lists custom-skipped roles as untouched', () => {
    const result = baseResult({
      roles: [
        { name: 'My Custom Role', status: 'custom-skipped', fragments: [] },
      ],
    });
    const out = renderSyncRolesResult(result, 'software-dev');
    expect(out).toContain('My Custom Role');
    expect(out.toLowerCase()).toMatch(/custom|skip|untouched/);
  });
});

describe('renderSyncRolesResult — deploy-skew defense (gh#9)', () => {
  it('renders a clean actionable message (no crash) on the legacy pre-#473 worker shape', () => {
    // A pre-#473 worker returns { updated, added, unchanged, skipped, dryRun }
    // with no `roles[]`. The 0.9.47+ client must NOT throw `undefined.flatMap`
    // (Queen FINDING 85410466 — client/worker deploy skew, gh#9 class).
    const legacy = { updated: 2, added: 1, unchanged: 5, skipped: 0, dryRun: true };
    const out = renderSyncRolesResult(legacy as unknown as NonClobberSyncResult, 'software-dev');
    // Surfaces an actionable "server out of date / deploy pending" message...
    expect(out.toLowerCase()).toMatch(/out of date|older than #473|deploy pending/);
    // ...and never leaks an `undefined` from the crashed code path.
    expect(out).not.toContain('undefined');
  });
});
