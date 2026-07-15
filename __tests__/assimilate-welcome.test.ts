import { describe, it, expect } from 'vitest';
import { renderAssimilationWelcome } from '../src/assimilate-welcome';

describe('renderAssimilationWelcome — structural shape', () => {
  it('includes role name and cube name verbatim', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).toContain('coordinator');
    expect(out).toContain('my-project');
  });

  it('uses "Joined as" instead of "Assimilated as" (gh#P1 softened tone)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).toContain('Joined as');
    expect(out).not.toContain('Assimilated as');
  });

  it('points at borg_regen as the next step', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).toContain('borg_regen');
  });

  it('clarifies borg_regen is an agent tool, not a shell command (gh#653 B5)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    // a non-expert must know to ASK the agent to run it (tool), not type it in
    // the shell — agent-agnostic phrasing (no hardcoded "Claude" vs "Codex")
    expect(out).toContain('ask your agent to run');
    expect(out).toContain('tool');
    expect(out).not.toContain('inside Claude');
  });

  it('gives second-drone guidance so the user can reach the multi-agent state (gh#653 B5)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).toContain('borg assimilate');
    expect(out).toContain('another terminal');
  });

  it('does not dump multiple tool names (gh#P1 info dump reduction)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).not.toContain('borg_role');
    expect(out).not.toContain('borg_cube');
    expect(out).not.toContain('borg_roster');
    expect(out).not.toContain('borg_read-log');
  });

  it('does not contain "collective" (gh#P1 softened sci-fi tone)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).not.toContain('collective');
  });

  it('starts with the ✓ glyph', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out.trimStart().startsWith('✓')).toBe(true);
  });

  it('renders all lines ≤80 columns (terminal-scrollback legibility)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    for (const line of out.split('\n')) {
      expect(line.length, `line over 80 cols: "${line}"`).toBeLessThanOrEqual(80);
    }
  });
});

describe('renderAssimilationWelcome — color degradation', () => {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\x1b\[[0-9;]*m/;

  it('emits ANSI green for ✓ glyph when useColor=true', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', true);
    expect(out).toMatch(ANSI);
    expect(out).toContain('\x1b[32m');
    expect(out).toContain('\x1b[0m');
  });

  it('emits no ANSI escape sequences when useColor=false (NO_COLOR / non-TTY / CI parity)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', false);
    expect(out).not.toMatch(ANSI);
  });

  it('body text carries no ANSI even when useColor=true (color is glyph-only, not body)', () => {
    const out = renderAssimilationWelcome('coordinator', 'my-project', true);
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.includes('✓')) continue;
      expect(line, `body line had ANSI: ${JSON.stringify(line)}`).not.toMatch(ANSI);
    }
  });
});

describe('renderAssimilationWelcome — edge cases (cube-agnostic; no role mapping table)', () => {
  it('renders a single-char role name', () => {
    const out = renderAssimilationWelcome('a', 'b', false);
    expect(out).toContain('`a`');
    expect(out).toContain('`b`');
  });

  it('renders an all-digits role name', () => {
    const out = renderAssimilationWelcome('12345', 'my-project', false);
    expect(out).toContain('`12345`');
  });

  it('renders an all-hyphens role name', () => {
    const out = renderAssimilationWelcome('---', 'my-project', false);
    expect(out).toContain('`---`');
  });

  it('renders a leading-hyphen role name', () => {
    const out = renderAssimilationWelcome('-foo', 'my-project', false);
    expect(out).toContain('`-foo`');
  });

  it('renders a max-64-char role name without truncation', () => {
    const maxName = 'a'.repeat(64);
    const out = renderAssimilationWelcome(maxName, 'my-project', false);
    expect(out).toContain(maxName);
  });

  it('renders an unknown-template role name verbatim (no mapping table needed)', () => {
    const out = renderAssimilationWelcome('fact-checker', 'writers-room', false);
    expect(out).toContain('`fact-checker`');
    expect(out).toContain('`writers-room`');
  });

  it('handles cube name at regex boundaries (same constraint as role.name)', () => {
    const maxName = 'a'.repeat(64);
    const out = renderAssimilationWelcome('builder', maxName, false);
    expect(out).toContain(maxName);
  });
});
