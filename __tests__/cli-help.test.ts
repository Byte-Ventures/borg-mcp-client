/**
 * gh#520 — `borg setup --help` must show help, not run the setup wizard.
 *
 * claude.ts's setup branch now early-exits with setupHelpText() when the next
 * arg is a help flag, before importing the wizard (./setup.js). These tests pin
 * the pure decision (isHelpFlag) + the help text; the claude.ts wiring is thin
 * glue (print + exit before the wizard import).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { NEW_CUBE_TEMPLATE_PRESENTATIONS } from 'borgmcp-shared/templates';
import {
  assimilateHelpText,
  cleanupHelpText,
  cloneHelpText,
  clientSubcommandHelpText,
  cubeInitHelpText,
  isHelpFlag,
  launchSeatHelpText,
  launchAllHelpText,
  quickstartHelpText,
  doctorHelpText,
  resetLocalSeatHelpText,
  recoverEnrollmentHelpText,
  serverHelpText,
  seatsHelpText,
  setupHelpText,
  setupNextStepsText,
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
    expect(t).toContain('  borg quickstart          Create a cube and a drone for every role, then launch them');
    // The removed Cloud device-code flow must not resurface in help.
    expect(t).not.toContain('--no-browser');
  });
});

describe('client subcommand help', () => {
  it.each([
    ['setup', setupHelpText],
    ['clone', cloneHelpText],
    ['quickstart', quickstartHelpText],
    ['assimilate', assimilateHelpText],
    ['reset-local-connection', resetLocalSeatHelpText],
    ['recover-enrollment', recoverEnrollmentHelpText],
    ['cleanup', cleanupHelpText],
    ['drones', seatsHelpText],
    ['launch', launchSeatHelpText],
    ['launch-all', launchAllHelpText],
    ['doctor', doctorHelpText],
  ] as const)('routes borg %s --help before command parsing', (command, render) => {
    expect(clientSubcommandHelpText(command, ['--help'], '9.9.9')).toBe(render('9.9.9'));
    expect(clientSubcommandHelpText(command, ['-h'], '9.9.9')).toBe(render('9.9.9'));
    expect(clientSubcommandHelpText(command, [], '9.9.9')).toBeNull();
  });

  it('documents every accepted launch-all option', () => {
    const text = launchAllHelpText('9.9.9');
    for (const flag of [
      '--mode', '--only', '--dry-run', '--no-attach', '--yes', '--force',
      '--launch-delay', '--help',
    ]) expect(text).toContain(flag);
    expect(text).not.toContain('--cli');
    expect(text).toContain('--mode <tmux|terminals|pastelist>');
    expect(text).not.toContain('--mode <tmux|windows|pastelist>');
    expect(text).toContain(
      `Modes:\n` +
      `  terminals  Open each drone in its own terminal tab, with the drone's name as\n` +
      `             the tab title. Default on macOS when iTerm2 or Terminal.app is\n` +
      `             installed. Terminal.app opens one named window for each drone\n` +
      `             instead; tabs would need macOS automation permissions, which borg\n` +
      `             does not request.\n` +
      `  tmux       Open all drones in one shared tmux session. Default on Linux.\n` +
      `  pastelist  Print the launch commands so you can run them yourself.\n`,
    );
  });

  it('defines the clone, quickstart, and assimilate responsibilities and clone flags', () => {
    const clone = cloneHelpText('9.9.9');
    for (const flag of ['--template', '--role', '--yes', '-y', '--checkout-only', '--no-launch']) {
      expect(clone).toContain(flag);
    }
    expect(clone).toMatch(/clone.*quickstart/is);
    expect(clone).toMatch(/non-interactive.*--yes.*--template/is);
    expect(clone).toContain('--no-launch                        Same as --checkout-only');
    expect(clone).toMatch(/--checkout-only.*non-interactive/is);
    expect(quickstartHelpText('9.9.9')).toMatch(/current repository.*full roster/is);
    expect(assimilateHelpText('9.9.9')).toMatch(/one drone.*one role/is);
  });

  it('documents local drone discovery and relaunch without bypassing the worktree', () => {
    const top = topLevelHelpText('9.9.9');
    expect(top).toContain('borg drones');
    expect(top).toContain('borg launch <drone-label-or-id-prefix>');

    const seats = seatsHelpText('9.9.9');
    expect(seats).toBe(
      `borg drones (borgmcp 9.9.9) — list this machine's registered drones\n\n` +
      `Usage:\n` +
      `  borg drones         Show drone, cube, worktree, agent CLI, and local state\n` +
      `  borg drones --help  Show this help\n\n` +
      `The local registry belongs to this machine only.\n`,
    );
    expect(seats).toMatch(/local.*registry/i);

    const launch = launchSeatHelpText('9.9.9');
    expect(launch).toContain('borg launch <drone-label-or-id-prefix>');
    expect(launch).toContain('--cube');
    expect(launch).toMatch(/worktree/i);
  });

  it('routes the renamed argv token without keeping a borg seats alias', () => {
    const source = readFileSync(new URL('../src/claude.ts', import.meta.url), 'utf8');
    expect(source).toContain("process.argv[2] === 'drones'");
    expect(source).not.toContain("process.argv[2] === 'seats'");
    expect(clientSubcommandHelpText('seats', ['--help'], '9.9.9')).toBeNull();
  });

  it('describes journal-aware enrollment recovery and its exact scope', () => {
    const text = recoverEnrollmentHelpText('9.9.9');
    expect(text).toContain('restore or clear one failed server enrollment');
    expect(text).toContain('restores or clears only the failed enrollment transaction');
    expect(text).toContain('does not touch other server enrollments or accounts');
    expect(topLevelHelpText('9.9.9')).toContain(
      'borg recover-enrollment  Restore or clear ONLY one failed server enrollment transaction',
    );
  });
});

describe('setup completion copy', () => {
  it('prints the local wrapper flow without remote enrollment flags', () => {
    const text = setupNextStepsText();
    expect(text).not.toContain('`borg server setup`');
    expect(text).toContain('`borg server start`');
    expect(text).toContain('`borg quickstart`');
    expect(text).toMatch(/second terminal/i);
    expect(text).not.toMatch(/--host|--enroll|borg-mcp-server/);
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
      `  start    Start the verified server in the foreground; press Ctrl-C to stop.\n` +
      `  service install  Install and start the loopback-only per-user service so it continues after the terminal closes.\n` +
      `  service uninstall  Remove the managed service and preserve local state.\n` +
      `  status   Report verified runtime evidence.\n` +
      `  update   Verify and activate a local server artifact.\n` +
      `  invite   Create a single-use invitation in an interactive terminal.\n` +
      `  cert-reissue  Widen the server certificate to cover another address without replacing the CA.\n` +
      `  client-list   List enrolled clients, states, and cube grants while the server is live; committed changes take effect on the next request.\n` +
      `  client-grant  Grant a client read, write, or manage access to a cube while the server is live; committed changes take effect on the next request.\n` +
      `  dashboard   View the running local server dashboard.\n` +
      `  cube init   Initialize this Git repository's cube; does not create a drone.\n\n` +
      `Managed-service behavior is server-owned. This client forwards install and uninstall but does not expose stop.\n\n` +
      `Run borg server <command> --help for server command options.\n`,
    );
  });

  it('pins command-specific cube init usage and options', () => {
    const templateOptions = NEW_CUBE_TEMPLATE_PRESENTATIONS.map(({ name }) => name).join('|');
    const defaultTemplate = NEW_CUBE_TEMPLATE_PRESENTATIONS[0].name;
    expect(cubeInitHelpText('9.9.9')).toBe(
      `borg server cube init (borgmcp 9.9.9) — initialize this Git repository's cube without creating a drone\n\n` +
      `Usage:\n` +
      `  borg server cube init [options]\n\n` +
      `Options:\n` +
      `  --host <host>                    Borg server host or URL (bare hosts default to HTTPS)\n` +
      `  --enroll                         Prompt for a hidden enrollment invitation\n` +
      `  --cube-name <name>               Repository cube name (otherwise edit the proposed name)\n` +
      `  --template ${templateOptions}  New-cube template (default: ${defaultTemplate})\n` +
      `  --yes, -y                        Accept new-cube defaults; never adopt by name\n` +
      `  --help, -h                       Show this help\n\n` +
      `An existing repository association skips all prompts. One accessible exact-name legacy\n` +
      `cube requires explicit interactive adoption; ambiguous matches fail closed. An enrolled\n` +
      `owner client may create a repository cube; ordinary clients require an explicit cube grant.\n`,
    );
    expect(cubeInitHelpText('9.9.9')).not.toMatch(/--worktree|--here|--cli|--model/);
  });

  it('derives accepted template copy for both creation commands from shared presentations', () => {
    const templateOptions = NEW_CUBE_TEMPLATE_PRESENTATIONS.map(({ name }) => name).join('|');
    const defaultTemplate = NEW_CUBE_TEMPLATE_PRESENTATIONS[0].name;
    for (const help of [cubeInitHelpText('9.9.9'), assimilateHelpText('9.9.9')]) {
      expect(help).toContain(`--template ${templateOptions}`);
      expect(help).toContain(`New-cube template (default: ${defaultTemplate})`);
    }
  });
});

describe('borg update help', () => {
  it('advertises the whole-product journey at top level', () => {
    expect(topLevelHelpText('9.9.9')).toContain('borg update');
  });

  it('documents preflight, ordering, config refresh, skip, partial completion, and restart semantics', () => {
    const text = updateHelpText('9.9.9');
    expect(text).toContain('borg update');
    expect(text).toContain('--yes');
    expect(text).toMatch(/published.*borgmcp-shared/is);
    expect(text).toMatch(/canonical npm/i);
    expect(text).toMatch(/alternate registries/i);
    expect(text).toMatch(/client.*first/is);
    expect(text).toMatch(/server.*skipped/i);
    expect(text).toMatch(/partial/i);
    expect(text).toMatch(/stale borgmcp package launch paths/i);
    expect(text).toMatch(/managed agent hooks/i);
    expect(text).toMatch(/preserving their other settings/i);
    expect(text).toMatch(/entries that point to another command unchanged/i);
    expect(text).toMatch(/restart.*agent/i);
  });
});

describe('borg doctor help', () => {
  it('advertises a read-only agent integration check', () => {
    expect(topLevelHelpText('9.9.9')).toContain('borg doctor');
    const text = doctorHelpText('9.9.9');
    expect(text).toContain('read-only');
    expect(text).toContain('hook commands');
    expect(text).toContain('OpenCode');
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

  it('explains mandatory explicit log addressing without implying secrecy', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('every log message requires `to: "broadcast"` or a non-empty selector list');
    expect(t).toContain('no omitted or taxonomy-selected audience');
    expect(t).toContain('not secrecy from other cube members');
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

  it('keeps direct --cli launch without teaching the removed launch-all flag', () => {
    const t = topLevelHelpText('9.9.9');
    expect(t).toContain('borg                     Show the launch menu in a repository root; resume directly in a linked worktree');
    expect(t).toContain('borg --cli claude|codex|opencode  Launch that agent CLI directly');
    expect(t).not.toContain('borg launch-all [cube] --cli claude|codex|opencode');
  });
});

describe('model configuration ownership', () => {
  it('assimilateHelpText documents the assimilate command + version + every flag', () => {
    const t = assimilateHelpText('9.9.9');
    expect(t).toContain('borg assimilate');
    expect(t).toContain('9.9.9');
    expect(t).toContain('Usage:');
    expect(t).not.toContain('(default: claude)');
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
    expect(t).toContain("Resume this worktree's saved drone");
    expect(t).not.toContain('Assimilate in the current worktree');
    expect(t).not.toContain('Stay in the current worktree');
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
