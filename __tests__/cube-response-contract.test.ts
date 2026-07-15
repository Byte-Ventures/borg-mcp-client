/**
 * gh#457 output-shape compat regression suite (client side).
 *
 * Verifies that the client reads `cube_directive` from server responses
 * and that formatRegenMarkdown renders it correctly.
 *
 * The canonical gh#9 failure: worker renamed the DB column but the
 * published client still read `result.cube.ground_rules` → undefined →
 * _(none)_ displayed despite data being intact in the DB.
 */

import { describe, expect, it } from 'vitest';
import { formatRegenMarkdown } from '../src/regen-format';

function makeRegenResult(overrides: { cube?: Partial<Record<string, unknown>> } = {}) {
  return {
    cube: {
      id: 'cube-1',
      name: 'my-cube',
      cube_directive: '# My Directive\n\nProject conventions here.',
      ...overrides.cube,
    },
    role: {
      id: 'role-1',
      name: 'Builder',
      detailed_description: 'Build things.',
    },
    drone: {
      id: 'drone-1',
      label: 'one-of-one-builder',
    },
    roles: [
      { id: 'role-1', name: 'Builder', short_description: 'Builds things.', is_default: true },
    ],
    drones: [
      { id: 'drone-1', label: 'one-of-one-builder', role_id: 'role-1', last_seen: new Date().toISOString() },
    ],
    recentLog: [],
  };
}

// gh#912-followup (directive-chapter): the cube directive is NO LONGER inlined
// in regen — the "## Cube directive" section is a MAX-FORCING borg_cube pointer;
// the drone fetches the directive content via the existing borg_cube. So regen
// renders the pointer, never the directive body (or any legacy field).
describe('formatRegenMarkdown cube_directive rendering (pointer, gh#912-followup)', () => {
  it('renders a borg_cube pointer under the Cube directive heading, NOT the directive body', () => {
    const result = makeRegenResult();
    const markdown = formatRegenMarkdown(result);
    expect(markdown).toContain('## Session start — required before acting');
    expect(markdown).toContain('borg_cube');
    expect(markdown).toContain('borg_playbook'); // consolidated session-start block lists both
    expect(markdown).not.toContain('# My Directive\n\nProject conventions here.');
  });

  it('emits the pointer (not the body) regardless of an empty cube_directive — no crash', () => {
    const result = makeRegenResult({ cube: { cube_directive: '' } });
    const markdown = formatRegenMarkdown(result);
    expect(markdown).toContain('## Session start — required before acting');
    expect(markdown).toContain('borg_cube');
  });

  it('emits the pointer (not the body) when cube_directive is absent — no crash (gh#9 class)', () => {
    // The pointer is a static string and does not read cube_directive, so an
    // absent field neither crashes nor leaks any other field.
    const result = makeRegenResult({ cube: { cube_directive: undefined } });
    const markdown = formatRegenMarkdown(result);
    expect(markdown).toContain('## Session start — required before acting');
    expect(markdown).toContain('borg_cube');
  });

  it('never renders a legacy directive field (ground_rules) in regen', () => {
    const result = makeRegenResult({ cube: { cube_directive: undefined, ground_rules: '# Should not render' } });
    const markdown = formatRegenMarkdown(result);
    expect(markdown).not.toContain('# Should not render');
    expect(markdown).toContain('borg_cube');
  });

  it('never inlines cube_directive OR ground_rules content — only the pointer', () => {
    const result = makeRegenResult({
      cube: {
        cube_directive: '# Correct directive',
        ground_rules: '# Old field — must be ignored',
      },
    });
    const markdown = formatRegenMarkdown(result);
    expect(markdown).not.toContain('# Correct directive');
    expect(markdown).not.toContain('# Old field — must be ignored');
    expect(markdown).toContain('borg_cube');
  });
});
