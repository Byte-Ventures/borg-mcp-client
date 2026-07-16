import { describe, it, expect } from 'vitest';
import { renderAssimilationWelcome } from '../src/assimilate-welcome';

describe('renderAssimilationWelcome — structural shape', () => {
  it('includes role name and cube name verbatim', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).toContain('coordinator');
    expect(out).toContain('my-project');
  });

  it('names the concrete drone, role seat, and cube', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).toContain('Attached `one-of-one-coordinator` to `coordinator` in cube `my-project`.');
  });

  it('points at identity and roster verification as the next step', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).toContain('`borg_whoami`');
    expect(out).toContain('`borg_roster`');
  });

  it('clarifies the verification tools run in the launched agent', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).toContain('In the launched agent, run');
    expect(out).not.toContain('inside Claude');
  });

  it('gives second-drone guidance so the user can reach the multi-agent state (gh#653 B5)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).toContain('borg assimilate');
    expect(out).toContain('another terminal');
  });

  it('does not dump multiple tool names (gh#P1 info dump reduction)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).not.toContain('borg_role');
    expect(out).not.toContain('borg_cube');
    expect(out).not.toContain('borg_read-log');
  });

  it('does not contain "collective" (gh#P1 softened sci-fi tone)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).not.toContain('collective');
  });

  it('starts with the ✓ glyph', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out.trimStart().startsWith('✓')).toBe(true);
  });

  it('renders all lines ≤80 columns (terminal-scrollback legibility)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    for (const line of out.split('\n')) {
      expect(line.length, `line over 80 cols: "${line}"`).toBeLessThanOrEqual(80);
    }
  });
});

describe('renderAssimilationWelcome — color degradation', () => {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m/;

  it('emits ANSI green for ✓ glyph when useColor=true', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', true);
    expect(out).toMatch(ANSI);
    expect(out).toContain('\x1b[32m');
    expect(out).toContain('\x1b[0m');
  });

  it('emits no ANSI escape sequences when useColor=false (NO_COLOR / non-TTY / CI parity)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', false);
    expect(out).not.toMatch(ANSI);
  });

  it('body text carries no ANSI even when useColor=true (color is glyph-only, not body)', () => {
    const out = renderAssimilationWelcome('one-of-one-coordinator', 'coordinator', 'my-project', true);
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.includes('✓')) continue;
      expect(line, `body line had ANSI: ${JSON.stringify(line)}`).not.toMatch(ANSI);
    }
  });
});

describe('renderAssimilationWelcome — edge cases (cube-agnostic; no role mapping table)', () => {
  it('renders a single-char role name', () => {
    const out = renderAssimilationWelcome('one', 'a', 'b', false);
    expect(out).toContain('`a`');
    expect(out).toContain('`b`');
  });

  it('renders an all-digits role name', () => {
    const out = renderAssimilationWelcome('one', '12345', 'my-project', false);
    expect(out).toContain('`12345`');
  });

  it('renders an all-hyphens role name', () => {
    const out = renderAssimilationWelcome('one', '---', 'my-project', false);
    expect(out).toContain('`---`');
  });

  it('renders a leading-hyphen role name', () => {
    const out = renderAssimilationWelcome('one', '-foo', 'my-project', false);
    expect(out).toContain('`-foo`');
  });

  it('renders a max-64-char role name without truncation', () => {
    const maxName = 'a'.repeat(64);
    const out = renderAssimilationWelcome('one', maxName, 'my-project', false);
    expect(out).toContain(maxName);
  });

  it('renders an unknown-template role name verbatim (no mapping table needed)', () => {
    const out = renderAssimilationWelcome('one', 'fact-checker', 'writers-room', false);
    expect(out).toContain('`fact-checker`');
    expect(out).toContain('`writers-room`');
  });

  it('handles cube name at regex boundaries (same constraint as role.name)', () => {
    const maxName = 'a'.repeat(64);
    const out = renderAssimilationWelcome('one', 'builder', maxName, false);
    expect(out).toContain(maxName);
  });
});
