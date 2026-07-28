/**
 * gh#520 — `borg setup --help` must show help, not run the setup wizard.
 *
 * claude.ts's setup branch now early-exits with setupHelpText() when the next
 * arg is a help flag, before importing the wizard (./setup.js). These tests pin
 * the pure decision (isHelpFlag) + the help text; the claude.ts wiring is thin
 * glue (print + exit before the wizard import).
 */
import { describe, it, expect } from 'vitest';
import {
  assimilateHelpText,
  cubeInitHelpText,
  isHelpFlag,
  serverHelpText,
  setupHelpText,
  topLevelHelpText,
  updateHelpText,
} from '../src/cli-help';

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
    // Local-only: no Cloud sign-in / device-code flow is offered any more.
    expect(t).not.toMatch(/--no-browser|device-code|Cloud sign-in/i);
    // It is help, not a credential prompt / wizard step.
    expect(t).not.toMatch(/sign in to continue|enter your|paste/i);
  });
});

describe('gh#611 — top-level borg --help', () => {
  it('surfaces borg setup (local MCP + agent CLI integration)', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('borgmcp 9.9.9');
    expect(t).toContain('borg setup');
    // The removed Cloud device-code flow must not resurface in help.
    expect(t).not.toContain('--no-browser');
  });
});

describe('borg server help', () => {
  it('lists the facade in top-level help', () => {
    expect(topLevelHelpText('9.9.9')).toContain('borg server <command> [arguments]');
    expect(topLevelHelpText('9.9.9')).toContain(
      `  borg server cube init    Initialize this repository's cube without creating a drone`,
    );
  });

  it('uses the approved bounded client-owned copy', () => {
    expect(serverHelpText()).toBe(
      `Usage: borg server <command> [arguments]\n\n` +
      `Commands:\n` +
      `  setup    Prepare local server identity and data; does not start the server.\n` +
      `  start    Start the verified server in the foreground.\n` +
      `  stop     Stop the managed local server.\n` +
      `  status   Report verified runtime evidence.\n` +
      `  update   Verify and activate a local server artifact.\n` +
      `  invite   Create a single-use invitation in an interactive terminal.\n` +
      `  dashboard   View the running local server dashboard.\n` +
      `  cube init   Initialize this Git repository's cube; does not create a drone.\n\n` +
      `Run borg server <command> --help for server command options.\n`,
    );
  });

  it('pins command-specific cube init usage and options', () => {
    expect(cubeInitHelpText('9.9.9')).toBe(
      `borg server cube init (borgmcp 9.9.9) — initialize this Git repository's cube without creating a drone\n\n` +
      `Usage:\n` +
      `  borg server cube init [options]\n\n` +
      `Options:\n` +
      `  --host <host>                    Borg server host or URL (bare hosts default to HTTPS)\n` +
      `  --enroll                         Prompt for a hidden enrollment invitation\n` +
      `  --cube-name <name>               Repository cube name (otherwise edit the proposed name)\n` +
      `  --template software-dev|starter  New-cube template (default: software-dev)\n` +
      `  --yes, -y                        Accept new-cube defaults; never adopt by name\n` +
      `  --help, -h                       Show this help\n\n` +
      `An existing repository association skips all prompts. One accessible exact-name legacy\n` +
      `cube requires explicit interactive adoption; ambiguous matches fail closed. An enrolled\n` +
      `owner client may create a repository cube; ordinary clients require an explicit cube grant.\n`,
    );
    expect(cubeInitHelpText('9.9.9')).not.toMatch(/--worktree|--here|--cli|--model/);
  });
});

describe('borg update help', () => {
  it('advertises the whole-product journey at top level', () => {
    expect(topLevelHelpText('9.9.9')).toContain('borg update');
  });

  it('documents preflight, ordering, skip, partial completion, and restart semantics', () => {
    const text = updateHelpText('9.9.9');
    expect(text).toContain('borg update');
    expect(text).toContain('--yes');
    expect(text).toMatch(/published.*borgmcp-shared/is);
    expect(text).toMatch(/canonical npm/i);
    expect(text).toMatch(/alternate registries/i);
    expect(text).toMatch(/client.*first/is);
    expect(text).toMatch(/server.*skipped/i);
    expect(text).toMatch(/partial/i);
    expect(text).toMatch(/restart.*agent/i);
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

  it('includes a resolvable repository-local docs link (no hosted product URL)', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('https://github.com/Byte-Ventures/borg-mcp-client#readme');
    // Local-only: no hosted product docs/get-started link.
    expect(t).not.toContain('borgmcp.ai');
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
    expect(t).toContain('Join or create a cube');
    expect(t).toContain('explicit server');
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
      '--force',
      '--yes',
      '--cli',
      '--model',
    ]) {
      expect(t).toContain(flag);
    }
    expect(t).toContain('hidden enrollment invitation');
    expect(t).toContain('operator terminal');
    expect(t).toContain('Repository cube name');
    expect(t).toContain('require an explicit cube grant');
    expect(t).toContain('Preview only');
    expect(t).not.toContain('falls back to Borg Cloud');
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
