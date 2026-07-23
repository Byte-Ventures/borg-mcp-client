import { describe, it, expect } from 'vitest';
import {
  ANTI_PASSIVE_STANDING_DISCIPLINE,
  RELEASE_CYCLE_SHAPES,
  ROLE_SCOPED_SAFETY_DISCIPLINES,
  TEMPLATES,
} from 'borgmcp-shared/templates';
import { parseRoleSections } from 'borgmcp-shared/role-section';

describe('template playbook maintenance', () => {
  it('retains exported compatibility disciplines used by clients', () => {
    expect(ROLE_SCOPED_SAFETY_DISCIPLINES).toContain(ANTI_PASSIVE_STANDING_DISCIPLINE);
    expect(ROLE_SCOPED_SAFETY_DISCIPLINES).toContain(RELEASE_CYCLE_SHAPES);
  });

  it('does not preserve deleted playbook history in rationale sections', () => {
    for (const template of Object.values(TEMPLATES)) {
      for (const role of template.roles) {
        const rationaleSections = parseRoleSections(role.detailed_description).filter(
          (section) => section.heading?.toLowerCase().endsWith('rationale'),
        );
        expect(rationaleSections, `${template.name}/${role.name}`).toEqual([]);
      }
    }
  });

  it('keeps the deletion-first maintenance rule in the software Coordinator playbook', () => {
    const coordinator = TEMPLATES['software-dev'].roles.find(
      (role) => role.name === 'Coordinator',
    );
    expect(coordinator?.detailed_description).toContain(
      'Delete obsolete, redundant, historical, cautionary, and example-heavy prose',
    );
    expect(coordinator?.detailed_description).toContain(
      'do not relocate it into new runbooks, decisions, contracts, rationale, or case-study archives',
    );
  });
});
