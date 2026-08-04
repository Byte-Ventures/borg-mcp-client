import { describe, expect, it } from 'vitest';
import {
  formatPatchedRoleSectionResult,
  formatUpdatedCubeResult,
  formatUpdatedRoleResult,
} from '../src/index';
import { SERVER_ADVISORY_MAX_CHARS, sanitizeServerAdvisory } from '../src/remote-client';

const cube = { name: 'borg', id: 'cube-1' };
const role = { name: 'Builder', id: 'role-1' };

describe('management context advisories', () => {
  it.each([
    ['update-cube', (advisory: unknown) => formatUpdatedCubeResult(cube, advisory)],
    ['update-role', (advisory: unknown) => formatUpdatedRoleResult(role, advisory)],
    ['patch-role-section', (advisory: unknown) => formatPatchedRoleSectionResult('replace', 'Workflow', role, advisory)],
  ])('%s renders a sanitized advisory when present', (_path, render) => {
    expect(render('Use the updated context.\u0000\u001b[31m')).toContain('Advisory: Use the updated context.');
    expect(render('Use the updated context.\u0000\u001b[31m')).not.toContain('\u0000');
    expect(render(undefined)).not.toContain('Advisory:');
  });

  it('bounds advisory text and removes C0/C1 controls', () => {
    const advisory = sanitizeServerAdvisory(`\u0001${'x'.repeat(600)}\u0085`);
    expect(advisory).toHaveLength(SERVER_ADVISORY_MAX_CHARS);
    expect(advisory).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
