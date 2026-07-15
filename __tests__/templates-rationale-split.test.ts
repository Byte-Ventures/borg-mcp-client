// Demonstrative role-text rationale split on the shipped Coordinator role.
// Proves the mechanism and authoring convention end-to-end.
import { describe, it, expect } from 'vitest';
import {
  TEMPLATES,
  WAKE_PATH_MONITOR_DISCIPLINE,
  GIT_OPERATIONAL_DISCIPLINE_COORDINATOR,
  PUSH_DISCIPLINE_COORDINATOR,
  ROLE_SCOPED_SAFETY_DISCIPLINES,
  UNIVERSAL_SAFETY_DISCIPLINES,
  ANTI_PASSIVE_STANDING_DISCIPLINE,
  RELEASE_CYCLE_SHAPES,
  WORKER_BUNDLE_DRY_RUN_DISCIPLINE,
} from 'borgmcp-shared/templates';
import { compressRoleText, parseRationalePointer } from '../src/regen-format';
import { parseRoleSections } from 'borgmcp-shared/role-section';

// Keep safety-adjacent constants in the carve-out so compressRoleText cannot
// replace their operational content with rationale stubs.
describe('safety-discipline compression carve-out', () => {
  it('ROLE_SCOPED_SAFETY_DISCIPLINES includes ANTI_PASSIVE_STANDING_DISCIPLINE', () => {
    expect(ROLE_SCOPED_SAFETY_DISCIPLINES).toContain(ANTI_PASSIVE_STANDING_DISCIPLINE);
  });
  it('ROLE_SCOPED_SAFETY_DISCIPLINES includes RELEASE_CYCLE_SHAPES', () => {
    expect(ROLE_SCOPED_SAFETY_DISCIPLINES).toContain(RELEASE_CYCLE_SHAPES);
  });
  it('ROLE_SCOPED_SAFETY_DISCIPLINES includes WORKER_BUNDLE_DRY_RUN_DISCIPLINE', () => {
    expect(ROLE_SCOPED_SAFETY_DISCIPLINES).toContain(WORKER_BUNDLE_DRY_RUN_DISCIPLINE);
  });
});

const coordinator = TEMPLATES['software-dev'].roles.find((r) => r.name === 'Coordinator')!;
const stored = coordinator.detailed_description ?? '';
const compressed = compressRoleText('Coordinator', stored);

// A distinctive fragment of the relocated WHY paragraph.
const WHY_FRAGMENT = 'Coordinator deadlock-resolution failures cascade';
const WHY_TAIL = 'the absence of resolution is expensive';

describe('Coordinator rationale split on shipped role text', () => {
  it('has a `Deadlock-resolution rationale:` plain-label section parseRoleSections resolves (sans-colon heading)', () => {
    const section = parseRoleSections(stored).find(
      (s) => s.kind === 'label' && s.heading === 'Deadlock-resolution rationale'
    );
    expect(section).toBeDefined();
    expect(section!.body).toContain(WHY_FRAGMENT);
    expect(section!.body).toContain(WHY_TAIL);
  });

  it('compresses that section to a stub via formatRationalePointer (WHY prose absent, stub present, heading kept)', () => {
    expect(compressed).not.toContain(WHY_FRAGMENT);
    expect(compressed).not.toContain(WHY_TAIL);
    expect(compressed).toContain('borg_role-rationale "Coordinator" "Deadlock-resolution rationale"');
    expect(compressed).toContain('Deadlock-resolution rationale:');
  });

  it('the emitted stub round-trips via parseRationalePointer (sans-colon section key)', () => {
    const stubLine = compressed.split('\n').find((l) => l.includes('borg_role-rationale'));
    expect(stubLine).toBeDefined();
    const parsed = parseRationalePointer(stubLine!);
    expect(parsed).toEqual({ role: 'Coordinator', section: 'Deadlock-resolution rationale' });
  });

  it('⛔ SR-safety: every safety discipline + sampled LIVE rules stay INLINE (fetch-free) in the compressed render', () => {
    // Safety constants never compressed.
    expect(compressed).toContain(WAKE_PATH_MONITOR_DISCIPLINE);
    expect(compressed).toContain(GIT_OPERATIONAL_DISCIPLINE_COORDINATOR);
    expect(compressed).toContain(PUSH_DISCIPLINE_COORDINATOR);
    expect(compressed).toContain(WORKER_BUNDLE_DRY_RUN_DISCIPLINE);
    // Sampled LIVE operational rules stay inline.
    expect(compressed).toContain('No rebases, ever, on any branch');
    expect(compressed).toContain('No force-pushes, ever');
    expect(compressed).toContain('Coordinator owns ALL merges into the primary branch');
    expect(compressed).toContain('Forcing function'); // the deadlock RULES adjacent to the moved WHY stay inline
  });

  it('⛔ no safety discipline text appears inside ANY rationale section body', () => {
    const safety = [...UNIVERSAL_SAFETY_DISCIPLINES, ...ROLE_SCOPED_SAFETY_DISCIPLINES];
    for (const section of parseRoleSections(stored)) {
      if (section.kind === 'label' && section.heading != null && section.heading.toLowerCase().endsWith('rationale')) {
        for (const s of safety) {
          expect(section.body).not.toContain(s);
        }
      }
    }
  });

  it('completeness (contract #1): compressed-core + every resolved stub reconstructs the stored role text', () => {
    const storedSections = parseRoleSections(stored);
    const resolve = (heading: string) =>
      storedSections.find((s) => s.kind === 'label' && s.heading === heading)?.body ?? '__MISSING__';
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

  it('modest-but-real compression: the render is smaller than stored (the moved WHY)', () => {
    expect(compressed.length).toBeLessThan(stored.length);
  });
});
