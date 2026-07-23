// gh#496-A(b) Task 2 — render compression mechanism (compressRoleText).
import { describe, it, expect } from 'vitest';
import {
  compressRoleText,
  formatRationalePointer,
  parseRationalePointer,
} from '../src/regen-format';
import {
  UNIVERSAL_SAFETY_DISCIPLINES,
  ROLE_SCOPED_SAFETY_DISCIPLINES,
} from 'borgmcp-shared/templates';

const WAKE_PATH = UNIVERSAL_SAFETY_DISCIPLINES[0]; // WAKE_PATH_MONITOR_DISCIPLINE text
const A_ROLE_SCOPED_SAFETY = ROLE_SCOPED_SAFETY_DISCIPLINES[0]; // a GIT/PUSH discipline text

describe('gh#496-A(b) compressRoleText', () => {
  it('stubs a `… rationale:` section, keeps core + safety inline', () => {
    // Realistic shape: preamble + core section + rationale section + core
    // section with woven trailing safety constant (as real roles end).
    const role =
      'You implement changes to the codebase.\n\n' +
      'Workflow:\n- do the thing\n- ship it\n\n' +
      'Git discipline rationale:\nLong prose about WHY git hygiene matters, case studies, history.\nmore prose\n\n' +
      'Project conventions:\n- TDD where it applies\n' +
      WAKE_PATH;

    const out = compressRoleText('Builder', role);

    // Stub emitted VERBATIM via formatRationalePointer (heading sans-colon).
    expect(out).toContain(formatRationalePointer('Builder', 'Git discipline rationale'));
    // Heading line preserved (reader still sees the topic).
    expect(out).toContain('Git discipline rationale:');
    // Rationale prose is GONE (compressed).
    expect(out).not.toContain('Long prose about WHY git hygiene matters');
    expect(out).not.toContain('case studies, history');
    // Core operational section stays INLINE verbatim.
    expect(out).toContain('Workflow:');
    expect(out).toContain('- do the thing');
    expect(out).toContain('Project conventions:');
    expect(out).toContain('- TDD where it applies');
    // ⛔ Safety discipline stays INLINE, never stubbed.
    expect(out).toContain(WAKE_PATH);
  });

  it('⛔ NEVER stubs a `rationale:`-named section whose body carries a safety discipline', () => {
    const role =
      'pre\n\n' +
      'Safety rationale:\nwhy safety matters... ' + A_ROLE_SCOPED_SAFETY + '\n';
    const out = compressRoleText('Coordinator', role);
    // The safety section survives inline. The adjacent rationale section may
    // still use its on-demand pointer because the parser keeps them separate.
    expect(out).toContain('Git safety:');
    expect(out).toContain('Never rewrite shared history');
    expect(out).toContain(formatRationalePointer('Coordinator', 'Safety rationale'));
    expect(out).not.toContain('why safety matters');
  });

  it('emitted stub round-trips via parseRationalePointer — MULTI-WORD role + heading (#502)', () => {
    const role = 'pre\n\nReview philosophy rationale:\nprose about review philosophy and why.\n';
    const out = compressRoleText('Code Reviewer', role);
    const stubLine = out.split('\n').find((l) => l.includes('borg_role-rationale'));
    expect(stubLine).toBeDefined();
    const parsed = parseRationalePointer(stubLine!);
    expect(parsed).not.toBeNull();
    expect(parsed!.role).toBe('Code Reviewer');
    expect(parsed!.section).toBe('Review philosophy rationale'); // sans-colon = the getRoleRationale key
  });

  it('leaves a role with no `rationale:` sections byte-identical', () => {
    const role = 'You are a Builder.\n\nWorkflow:\n- thing\n\nProject conventions:\n- conv\n';
    expect(compressRoleText('Builder', role)).toBe(role);
  });

  it('handles a rationale section at EOF (no trailing newline)', () => {
    const role = 'pre\n\nDesign rationale:\nwhy we did it this way';
    const out = compressRoleText('Builder', role);
    expect(out).toContain('Design rationale:');
    expect(out).toContain(formatRationalePointer('Builder', 'Design rationale'));
    expect(out).not.toContain('why we did it this way');
  });
});
