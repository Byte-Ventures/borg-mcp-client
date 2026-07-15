/**
 * gh#520 — `borg setup --help` must show help, not run the setup wizard.
 *
 * claude.ts's setup branch now early-exits with setupHelpText() when the next
 * arg is a help flag, before importing the wizard (./setup.js). These tests pin
 * the pure decision (isHelpFlag) + the help text; the claude.ts wiring is thin
 * glue (print + exit before the wizard import).
 */
import { describe, it, expect } from 'vitest';
import { isHelpFlag, setupHelpText, topLevelHelpText, assimilateHelpText } from '../src/cli-help';

describe('gh#520 — borg setup --help', () => {
  it('isHelpFlag recognizes --help and -h only', () => {
    expect(isHelpFlag('--help')).toBe(true);
    expect(isHelpFlag('-h')).toBe(true);
    expect(isHelpFlag(undefined)).toBe(false);
    expect(isHelpFlag('')).toBe(false);
    expect(isHelpFlag('setup')).toBe(false);
    expect(isHelpFlag('--worktree')).toBe(false);
    expect(isHelpFlag('-help')).toBe(false);
  });

  it('setupHelpText shows setup usage + version (so the wizard does not run)', () => {
    const t = setupHelpText('9.9.9');
    expect(t).toContain('borg setup');
    expect(t).toContain('9.9.9');
    expect(t).toContain('Usage:');
    expect(t).toContain('--help');
    expect(t).toContain('setup wizard');
    // gh#557: the no-browser/device flow is documented for remote terminals.
    expect(t).toContain('--no-browser');
    // It is help, not a credential prompt / wizard step.
    expect(t).not.toMatch(/sign in to continue|enter your|paste/i);
  });
});

describe('gh#611 — top-level borg --help', () => {
  it('surfaces setup --no-browser for SSH/headless discovery', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('borgmcp 9.9.9');
    expect(t).toContain('borg setup --no-browser');
    expect(t).toContain('SSH/headless');
  });
});

describe('gh#818 P2 — top-level --help leads with purpose + docs link', () => {
  it('fronts a plain-language purpose before naming the "cube" abstraction', () => {
    const t = topLevelHelpText('9.9.9');
    // The plain-purpose sentence comes first; the jargon ("cube") is
    // introduced AFTER the value statement, never as the opener.
    const purposeIdx = t.indexOf('run several AI coding agents on one project');
    const cubeIdx = t.indexOf('cube');
    expect(purposeIdx).toBeGreaterThanOrEqual(0);
    expect(cubeIdx).toBeGreaterThan(purposeIdx);
  });

  it('includes a resolvable get-started docs link (never a /docs 404 path)', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('https://borgmcp.ai/get-started');
    // Guard the CR constraint: no bare /docs deep-link that 404s.
    expect(t).not.toContain('borgmcp.ai/docs');
  });

  it('glosses the "assimilate" jargon rather than using it bare', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('assimilate');
    expect(t).toContain('joined a cube');
  });

  it('preserves the Usage block + passthrough note (no-regress)', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('Usage:');
    expect(t).toContain('borg assimilate [role]');
    expect(t).toContain('Join or create a Borg Cloud cube');
    expect(t).toContain('pre-provisioned self-hosted cube');
    expect(t).not.toContain('Join a cube (creates one if needed)');
    expect(t).toContain('passed through to the selected agent CLI');
  });
});

describe('gh#556 Part 2 — launch-all in top-level help', () => {
  it('lists `borg launch-all [cube]`', () => {
    expect(topLevelHelpText('9.9.9')).toContain('borg launch-all [cube]');
  });

  it('distinguishes bare menu, direct --cli launch, and launch-all --cli fleet launch', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('borg                     Launch your agent CLI; in a TTY, bare borg may show the launch menu');
    expect(t).toContain('borg --cli claude|codex|opencode  Launch that agent CLI directly');
    expect(t).toContain('borg launch-all [cube] --cli claude|codex|opencode');
  });
});

describe('model configuration ownership', () => {
  it('assimilateHelpText documents the assimilate command + version + every flag', () => {
    const t = assimilateHelpText('9.9.9');
    expect(t).toContain('borg assimilate');
    expect(t).toContain('9.9.9');
    expect(t).toContain('Usage:');
    for (const flag of [
      '--worktree',
      '--template',
      '--no-template',
      '--cube-name',
      '--host',
      '--enroll',
      '--here',
      '--yes',
      '--cli',
      '--model',
    ]) {
      expect(t).toContain(flag);
    }
    expect(t).toContain('hidden invitation prompt');
    expect(t).toContain('invitation is never an argument');
    expect(t).toContain('Borg Cloud cube to join/create');
    expect(t).toContain('pre-provisioned grant');
    expect(t).toContain('not dogfood/release-ready');
    expect(t).toContain('never creates a cube or falls back to Borg Cloud');
    expect(t).toContain('docs/LOCAL_SERVER.md');
    expect(t).not.toContain('--server');
  });

  it('limits the temporary Borg override to Claude', () => {
    const t = assimilateHelpText('9.9.9');
    expect(t).toContain('--model claude:<model>');
    expect(t).not.toContain('--model ollama:');
  });

  it('directs local model configuration to the agent CLI', () => {
    const t = assimilateHelpText('9.9.9');
    expect(t).toMatch(/configure the selected agent CLI directly/i);
    expect(t).toMatch(/OpenCode supports Ollama/i);
    expect(t).not.toContain('BORG_OLLAMA_BASE_URL');
  });

  it('top-level help no longer advertises Borg-managed models', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).not.toContain('--model');
    expect(t).not.toContain('ollama:');
  });
});
