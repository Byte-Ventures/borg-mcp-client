#!/usr/bin/env node
/**
 * Borg CLI launcher
 *
 * Spawns Claude Code with a minimal kickoff prompt so the SessionStart
 * hook's injected drone playbook actually fires on the first turn.
 * Without this, Claude sits waiting for user input and the autonomous
 * "look at the log and act" directive never executes.
 *
 * Commands:
 *   borg                → Launch Claude with kickoff prompt
 *   borg setup          → Re-route to the setup wizard
 *   borg spawn <name>   → Create a sibling git worktree + launch a
 *                         fresh drone inside it (see spawn.ts)
 *   borg server <cmd>   → Forward a lifecycle command to borg-mcp-server
 */

import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import {
  BORG_LAUNCH_EXPECTED_SEAT_ENV,
  codexLaunchSeatExpectationConfigArgs,
  findProjectRoot,
  getActiveCube,
  inboxPathForDrone,
  LaunchSeatIdentityChangedError,
  setCodexWakeTarget,
  pruneDeadCodexWakeTargets,
  type ActiveCube,
  type BorgCli,
} from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import { formatSeatReattachRefusal, inspectLiveInboxMonitor } from './seat-reattach-guard.js';
import { handleVersionFlag, getPackageVersion } from './version.js';
import { clientSubcommandHelpText, topLevelHelpText } from './cli-help.js';
import { runSpawn } from './spawn.js';
import { buildClaudeLaunchArgs } from './claude-launch-args.js';
import { parseCleanupArgs, runCleanup } from './cleanup-cmd.js';
import { parseAssimilateArgs } from './parse-assimilate-args.js';
import { runAssimilate } from './assimilate-cmd.js';
import { buildDefaultAssimilateDeps } from './assimilate-deps.js';
import {
  parseResetLocalSeatArgs,
  runResetLocalSeat,
  buildDefaultResetLocalSeatDeps,
} from './reset-local-seat-cmd.js';
import { parseLaunchAllArgs } from './parse-launch-all-args.js';
import { unknownSubcommand } from './unknown-subcommand.js';
import { parseRecoverEnrollmentArgs, runRecoverEnrollment } from './recover-enrollment-cmd.js';
import { runLaunchAll } from './launch-all-cmd.js';
import { buildDefaultLaunchAllDeps } from './launch-all-deps.js';
import {
  buildDefaultSeatCommandDeps,
  parseLaunchSeatArgs,
  parseSeatsArgs,
  runLaunchSeat,
  runSeats,
} from './seat-commands.js';
import { discoverDroneCandidates } from './launch-all-discovery.js';
import {
  configureSelectedLaunchCli,
  discoverLiveLaunchMenuCandidates,
  isMainGitWorktree,
  isTerminalLaunchMenuSeatStatus,
  runBareLaunchMenu,
  shouldShowLaunchMenu,
  terminalLaunchMenuSeatNotice,
  type LaunchMenuAction,
} from './bare-launch-menu.js';
import type { SeatStatus } from './seat-probe.js';
import { setTerminalTitle } from './terminal-title.js';
import { initConsolePrefix, consolePrefix } from './console-prefix.js';
import { initDebugFromArgv } from './debug.js';
import { configuredCliNames, defaultCliChoiceDeps, detectCliAvailability, detectCliConfiguration, parseCliFlag, resolveCliChoice } from './cli-platform.js';
import { prepareCodexRemoteLaunch, resolveCodexLaunchCwd, withCodexCwdArg, defaultCodexRemoteDeps, checkCodexBridgeHealthy } from './codex-remote.js';
import {
  BORG_CODEX_REMOTE_WAKE_ENV,
  codexAgentKindConfigArgs,
  codexRemoteWakeConfigArgs,
  codexStateRootConfigArgs,
  withAgentRuntimeEnv,
} from './agent-runtime.js';
import { findLoadedCodexThread } from './codex-app-server.js';
import {
  buildAgentKickoffPrompt,
  buildKickoffWakePathClause,
  recordCodexWakeTarget,
  socketPathFromRemoteArgs,
} from './codex-launch.js';
import { codexBorgSessionConfigArgs } from './launch-gate.js';
import {
  addCodexSessionStartHook,
  addCodexUserPromptSubmitHook,
  addProjectSessionStartHook,
  addUserPromptSubmitHook,
  removeSessionStartHook,
} from './config-utils.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { configureResolvedCli } from './resolved-cli-config.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { allocateOpenCodePort, connectOpenCodeDrone, createOpenCodeLaunchKickoff, injectInitialKickoff, openCodeLaunchBinding } from './opencode-drone.js';
import { buildOpenCodeLaunchArgs, defaultApprovalIo, resolveLaunchBorgApprovals } from './cli-tool-approval.js';
import { isClientOwnedCubeInitArgv, runEarlyServerFacade } from './server-facade.js';
import { runEarlyUpdate } from './update-cmd.js';
import { runDoctor, warnIfAgentIntegrationUnhealthy } from './agent-integration-health.js';

export type AssimilateDepsBuilder = typeof buildDefaultAssimilateDeps;

export class OpenCodeTargetedLaunchConfigError extends Error {
  readonly code = 'OPENCODE_TARGETED_LAUNCH_CONFIG';

  constructor(droneLabel: string, worktree: string) {
    super(
      `borg launch: did not launch '${droneLabel}' — borg could not update or verify the OpenCode configuration ` +
      'that a targeted launch needs to open the correct drone. Check that the OpenCode configuration file is ' +
      `writable, then try again. As a fallback, run \`borg\` in ${worktree} to resume that worktree's drone directly.`,
    );
    this.name = 'OpenCodeTargetedLaunchConfigError';
  }
}

export function createOpenCodeLaunchPlan(
  cwd: string,
  port: number,
  prompt: string,
  passthroughArgs: string[] = [],
): { launchArgs: string[]; envPort: string; serverUrl: string } {
  const binding = openCodeLaunchBinding(port);
  return {
    launchArgs: buildOpenCodeLaunchArgs(cwd, Number(binding.cliPort), prompt, passthroughArgs),
    envPort: binding.envPort,
    serverUrl: binding.serverUrl,
  };
}

export function launchOpenCodeProcess(options: {
  cwd: string;
  port: number;
  prompt: string;
  passthroughArgs: string[];
  env: NodeJS.ProcessEnv;
  droneLabel: string;
  cubeName: string;
  kickoff: ReturnType<typeof createOpenCodeLaunchKickoff>;
  spawnProcess?: typeof spawn;
  connect?: typeof connectOpenCodeDrone;
}): {
  launchArgs: string[];
  launchEnv: NodeJS.ProcessEnv;
  process: ReturnType<typeof spawn>;
} {
  const plan = createOpenCodeLaunchPlan(options.cwd, options.port, options.prompt, options.passthroughArgs);
  const launchEnv = { ...options.env, BORG_OPENCODE_PORT: plan.envPort };
  // OpenCode's bind can still race this allocation; client#298 tracks the
  // residual pre-bind window outside this slice.
  const child = (options.spawnProcess ?? spawn)('opencode', plan.launchArgs, {
    stdio: 'inherit',
    shell: false,
    env: launchEnv,
  });
  (options.connect ?? connectOpenCodeDrone)({
    serverUrl: plan.serverUrl,
    directory: options.cwd,
    droneLabel: options.droneLabel,
    cubeName: options.cubeName,
  })
    .then(() => injectInitialKickoff(options.kickoff))
    .catch(() => {});
  return { launchArgs: plan.launchArgs, launchEnv, process: child };
}

export async function runAssimilateEntry(
  args: readonly string[],
  buildDeps: AssimilateDepsBuilder = buildDefaultAssimilateDeps,
): Promise<number> {
  const parsed = parseAssimilateArgs([...args]);
  if (!parsed.ok) {
    process.stderr.write(
      chalk.red(`${consolePrefix()}◼ borg assimilate: ${parsed.error}\n`)
    );
    process.stderr.write(`Run \`borg --help\` for usage.\n`);
    return 1;
  }
  return runAssimilate({ role: parsed.role, flags: parsed.flags }, buildDeps());
}

async function main() {
  const updateExitCode = await runEarlyUpdate(process.argv);
  if (updateExitCode !== null) process.exit(updateExitCode);

  // Cube initialization is client-owned, so enable debug before its early
  // facade dispatch. Server lifecycle commands keep their argv verbatim:
  // their separate executable owns and parses `--debug`.
  if (isClientOwnedCubeInitArgv(process.argv)) {
    initDebugFromArgv(process.argv);
  }

  const serverExitCode = await runEarlyServerFacade(process.argv);
  if (serverExitCode !== null) process.exit(serverExitCode);

  // `--debug` / BORG_DEBUG: enable HTTP request/response logging to stderr
  // (observability for failures like the cross-account assimilate 404).
  // Done first so debug covers everything below; strips `--debug` from argv
  // so subcommand parsers (which reject unknown flags) never see it. Covers
  // the top-level dispatcher + `borg setup` + `borg assimilate` — all route
  // through this main.
  initDebugFromArgv(process.argv);

  // Honor `--version` / `-v` before any other work.
  handleVersionFlag();

  // Resolve drone self-identification prefix (gh#25) before any error
  // emission so messages carry `[drone-X · cube]` from launch onward.
  await initConsolePrefix();

  // Local-only client: bare `borg` performs NO automatic external network I/O
  // (no npm-registry stale-version check) before authority selection. Only the
  // explicitly selected local server may be contacted. A version comparison is
  // available as an explicit operator action via `borg --version`.

  // Intercept --help / -h before handing off to Claude.
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    process.stdout.write(topLevelHelpText(getPackageVersion()));
    process.exit(0);
  }

  const subcommandHelp = clientSubcommandHelpText(
    process.argv[2],
    process.argv.slice(3),
    getPackageVersion(),
  );
  if (subcommandHelp !== null) {
    process.stdout.write(subcommandHelp);
    process.exit(0);
  }

  // Re-route subcommands.
  if (process.argv[2] === 'setup') {
    await import('./setup.js');
    return;
  }
  if (process.argv[2] === 'doctor') {
    process.exit(runDoctor());
  }
  if (process.argv[2] === 'assimilate') {
    const code = await runAssimilateEntry(process.argv.slice(3));
    process.exit(code);
  }
  if (process.argv[2] === 'reset-local-connection') {
    const parsed = parseResetLocalSeatArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(
        chalk.red(`${consolePrefix()}◼ borg reset-local-connection: ${parsed.error}\n`)
      );
      process.stderr.write(`Run \`borg --help\` for usage.\n`);
      process.exit(1);
    }
    const code = await runResetLocalSeat(parsed.flags, buildDefaultResetLocalSeatDeps());
    process.exit(code);
  }
  if (process.argv[2] === 'recover-enrollment') {
    const parsed = parseRecoverEnrollmentArgs(process.argv.slice(3));
    if (!parsed.ok) {
      if (parsed.error === 'help') {
        process.stdout.write(clientSubcommandHelpText('recover-enrollment', [], getPackageVersion()) ?? '');
        process.exit(0);
      }
      process.stderr.write(chalk.red(`${consolePrefix()}◼ borg recover-enrollment: ${parsed.error}\n`));
      process.exit(1);
    }
    const prompt = async (message: string): Promise<string> => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(message); } finally { rl.close(); }
    };
    const code = await runRecoverEnrollment(parsed.flags, {
      prompt,
      stderr: (line) => process.stderr.write(line),
      stdout: (line) => process.stdout.write(line),
    });
    process.exit(code);
  }
  if (process.argv[2] === 'spawn') {
    // Deprecated; the stub prints a redirect message and exits 2.
    const code = await runSpawn();
    process.exit(code);
  }
  if (process.argv[2] === 'cleanup') {
    const parsed = parseCleanupArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(
        chalk.red(`${consolePrefix()}◼ borg cleanup: ${parsed.error}\n`)
      );
      process.stderr.write(`Run \`borg --help\` for usage.\n`);
      process.exit(1);
    }
    const code = await runCleanup({}, parsed.options);
    process.exit(code);
  }
  if (process.argv[2] === 'seats') {
    const parsed = parseSeatsArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(chalk.red(`${consolePrefix()}◼ borg seats: ${parsed.error}\n`));
      process.stderr.write(`Run \`borg seats --help\` for usage.\n`);
      process.exit(1);
    }
    process.exit(await runSeats(buildDefaultSeatCommandDeps()));
  }
  if (process.argv[2] === 'launch') {
    const parsed = parseLaunchSeatArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(chalk.red(`${consolePrefix()}◼ borg launch: ${parsed.error}\n`));
      process.stderr.write(`Run \`borg launch --help\` for usage.\n`);
      process.exit(1);
    }
    process.exit(await runLaunchSeat(
      { target: parsed.target, ...(parsed.cube ? { cube: parsed.cube } : {}) },
      buildDefaultSeatCommandDeps(),
    ));
  }
  if (process.argv[2] === 'launch-all') {
    const parsed = parseLaunchAllArgs(process.argv.slice(3));
    if (!parsed.ok) {
      process.stderr.write(
        chalk.red(`${consolePrefix()}◼ borg launch-all: ${parsed.error}\n`)
      );
      process.stderr.write(`Run \`borg --help\` for usage.\n`);
      process.exit(1);
    }
    const deps = buildDefaultLaunchAllDeps();
    const code = await runLaunchAll(parsed.args, deps);
    process.exit(code);
  }

  // gh#911: an unknown NON-FLAG argv[2] that isn't a known subcommand must
  // ERROR, not silently fall through and launch an agent with the typo'd word
  // as its prompt (the `borg evict-drone X` footgun). Bare `borg` and
  // recognized flags still fall through to launch below.
  const unknownCmd = unknownSubcommand(process.argv[2]);
  if (unknownCmd !== null) {
    process.stderr.write(
      chalk.red(`${consolePrefix()}◼ unknown command: ${unknownCmd}\n`)
    );
    process.stderr.write(`Run \`borg --help\` for usage.\n`);
    process.exit(1);
  }

  const parsedCli = parseCliFlag(process.argv.slice(2));
  if (parsedCli.error) {
    process.stderr.write(chalk.red(`${consolePrefix()}◼ ${parsedCli.error}\n`));
    process.stderr.write(`Run \`borg --help\` for usage.\n`);
    process.exit(1);
  }

  const prompt = async (message: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(message);
    } finally {
      rl.close();
    }
  };

  let cli = await resolveCliChoice(
    parsedCli.cli,
    defaultCliChoiceDeps(prompt, () => process.stdin.isTTY === true)
  );
  let launchAction: LaunchMenuAction | undefined;

  // Active cube for this directory — needed for the launch menu's option-3
  // availability, the terminal title, and the inbox-Monitor clause below.
  let active = await getActiveCube();
  const launchAllDeps = buildDefaultLaunchAllDeps();
  const isMainWorktree = isMainGitWorktree((args) =>
    launchAllDeps.runSync('git', args, { cwd: process.cwd() })
  );

  const stdinIsTTY = process.stdin.isTTY === true;
  const stdoutIsTTY = process.stdout.isTTY === true;

  // gh#853: bare `borg` (no args) interactive launch menu. TTY-only + bare-args-
  // only (shouldShowLaunchMenu) so every scripted/programmatic `borg` and every
  // explicit subcommand/flag is untouched; the get-started breadcrumb already
  // exited above, so it keeps precedence over the menu. The option-set and
  // selection→action mapping are pure (bare-launch-menu.ts) — this is the glue
  // that computes inputs and dispatches the chosen action.
  if (
    shouldShowLaunchMenu({
      extraArgs: process.argv.slice(2),
      stdinIsTTY,
      stdoutIsTTY,
      isMainWorktree,
    })
  ) {
    const seatCommandDeps = buildDefaultSeatCommandDeps();
    let currentDroneStatus: SeatStatus | null = null;
    if (active) {
      try {
        currentDroneStatus = await launchAllDeps.probeSeat(active);
      } catch {
        currentDroneStatus = 'indeterminate';
      }
      if (isTerminalLaunchMenuSeatStatus(currentDroneStatus)) {
        process.stderr.write(terminalLaunchMenuSeatNotice(currentDroneStatus));
        active = null;
      }
    }
    const siblingContext = await discoverLiveLaunchMenuCandidates({
      readAllProjectIdentities: launchAllDeps.readAllProjectIdentities,
      discoverDroneCandidates: (cubeId) => discoverDroneCandidates(
        { targetCubeId: cubeId },
        { ...launchAllDeps, stderr: () => {} },
      ),
      getActiveSeatForWorktree: seatCommandDeps.getActiveSeatForWorktree,
      pathExists: launchAllDeps.pathExists,
      probeSeat: (candidate) => launchAllDeps.probeSeat(candidate.seat),
    });
    const otherConfiguredClis = configuredCliNames(
      detectCliAvailability(),
      detectCliConfiguration(),
    ).filter((c) => c !== cli);
    const action = await runBareLaunchMenu(
      {
        defaultCli: cli,
        otherConfiguredClis,
        hasLaunchAllTargets: siblingContext.launchAllCubeId !== undefined,
        ...(active && currentDroneStatus
          ? {
              currentDrone: {
                droneLabel: active.droneLabel,
                worktree: active.worktree ?? findProjectRoot(process.cwd()),
                status: currentDroneStatus,
              },
            }
          : {}),
        droneCandidates: siblingContext.candidates,
        ...(siblingContext.launchAllCubeId
          ? { launchAllCubeId: siblingContext.launchAllCubeId }
          : {}),
      },
      prompt
    );
    if (action.kind === 'launch-seat') {
      process.exit(await runLaunchSeat(
        { target: action.target },
        buildDefaultSeatCommandDeps(),
      ));
    }
    if (action.kind === 'launch-all') {
      const deps = buildDefaultLaunchAllDeps();
      const selectedIdentity = action.cubeId
        ? (await deps.readAllProjectIdentities()).find(({ cube }) => cube.cubeId === action.cubeId)
        : undefined;
      const parsed = parseLaunchAllArgs([]);
      const code = parsed.ok
        ? await runLaunchAll(
          parsed.args,
          selectedIdentity ? { ...deps, getActiveCube: async () => selectedIdentity.cube } : deps,
        )
        : 1;
      process.exit(code);
    }
    // option 1 → configured default; option 2 → the other agent, ONE-SHOT
    // (we deliberately do NOT call setProjectCliPreference — the saved
    // preference is changed only via `borg --cli <agent>`).
    launchAction = action;
  }

  // Configure only the CLI that will actually launch. This must follow the
  // one-shot menu: the resolved default can differ from the menu selection.
  cli = configureSelectedLaunchCli(
    cli,
    launchAction,
    (selectedCli) => ensureResolvedCliConfigured(selectedCli, active),
  );

  if (active && !parsedCli.force) {
    const inboxPath = inboxPathForDrone(active.cubeId, active.droneId);
    const stateRoot = monitorStateRootForWorktree(findProjectRoot(process.cwd()));
    const holder = inspectLiveInboxMonitor(inboxPath, stateRoot);
    if (holder !== null) {
      process.stderr.write(formatSeatReattachRefusal(holder, 'borg --force'));
      process.exit(1);
    }
  }

  // client#20: inspect only the SELECTED harness after the one-shot launch
  // menu choice. A narrow per-process override is applied by default; Borg
  // never rewrites the user's approval policy here.
  const approvalCwd = cli === 'codex'
    ? resolveCodexLaunchCwd(parsedCli.rest, process.cwd())
    : process.cwd();
  const launchApproval = await resolveLaunchBorgApprovals(
    cli,
    defaultApprovalIo(prompt, () => process.stdin.isTTY === true, {
      cwd: approvalCwd,
      env: process.env,
      codexArgs: parsedCli.rest,
    }),
    { skipOverride: parsedCli.noBorgApprovalOverride }
  );
  if (launchApproval.warning) {
    console.error(`${consolePrefix()}${chalk.yellow(`warning: ${launchApproval.warning}`)}`);
  }

  // Forward any user-supplied flags (e.g. --resume <id>, --cwd, etc.) to
  // the selected agent CLI unchanged.
  //
  // The kickoff prompt goes at the end as the positional user-message
  // argument so the SessionStart hook + drone playbook get a turn to
  // execute on session start. Works for fresh sessions and resumed ones.
  //
  // The /loop wrapper (dynamic mode — no fixed interval) lets Claude
  // self-pace iterations. We instruct it to arm a persistent Monitor on
  // the inbox file so it wakes the moment another drone posts to the
  // cube (the MCP client appends a line to that file in real time via
  // the long-poll poller). One adaptive ScheduleWakeup recovery deadline
  // backs it up: 3h ±30m while Monitor status is healthy or indeterminate,
  // 15m ±3m only while explicitly broken; a real Monitor wake replaces it.
  const passthroughArgs = parsedCli.rest;

  // `active` (resolved above for the launch menu) also gates the inbox-Monitor
  // instruction: only arm it when this project is assimilated to a cube —
  // otherwise we don't know which inbox file to watch and a Monitor on a
  // not-yet-relevant path produces no signal. The user can assimilate and
  // relaunch to engage real-time wake; the /loop heartbeat covers the meantime.

  // Set the terminal title so sibling drone sessions are
  // distinguishable in Cmd-Tab / tab bars / Mission Control. No-op
  // when stdout isn't a TTY (piped invocation, CI). Claude Code does
  // not set its own title, so this persists for the session.
  setTerminalTitle(
    active ? { label: active.droneLabel, cubeName: active.name } : null,
    basename(process.cwd())
  );

  // gh#929: the claude wake-path/Monitor-arming clause is the SHARED
  // wakePathArming (same core the SessionStart hook + /clear orientation use)
  // + the NEVER-TaskStop reminder. Codex / opencode / no-active-cube → empty.
  const monitorClause = buildKickoffWakePathClause(
    cli,
    active && cli === 'claude' ? inboxPathForDrone(active.cubeId, active.droneId) : null,
    active && cli === 'claude'
      ? monitorStateRootForWorktree(findProjectRoot(process.cwd()))
      : null
  );

  const codexWakeNonce = cli === 'codex' ? `borg-wake-${randomUUID()}` : null;
  let codexWakePathClause: string | undefined;
  let remoteArgs: string[] = [];
  // gh#673 P1: mark the agent session as borg-launched. Claude Code's MCP
  // child + hook commands inherit this env, gating the borg activation
  // surface (launch-gate.ts). ACTIVATION-only — never a security gate.
  // OpenCode MCP children get BORG_SESSION from the pinned env in the
  // opencode.json config (same mechanism as codex's pinned env).
  // Pin CLI identity independently of a model selection and the optional
  // Codex remote-wake transport. In particular, clear a stale Codex marker
  // before a Codex -> Claude relaunch can reach its MCP child.
  let launchEnv: NodeJS.ProcessEnv = { ...withAgentRuntimeEnv(process.env, cli), BORG_SESSION: '1' };
  if (cli === 'opencode' && launchApproval.openCodePermission) {
    launchEnv.OPENCODE_PERMISSION = launchApproval.openCodePermission;
  }
  let codexSocketPath: string | null = null;
  let codexServerCleanup: (() => void) | null = null;
  if (cli === 'codex' && !passthroughArgs.includes('--remote')) {
    console.error(`${consolePrefix()}${chalk.gray('◼ Starting Codex remote-wake app-server…')}`);
    const remote = await prepareCodexRemoteLaunch(defaultCodexRemoteDeps());
    if (remote.warning) {
      console.error(`${consolePrefix()}${chalk.yellow(`warning: ${remote.warning}`)}`);
      codexWakePathClause =
        `⚠ Codex wake-path capability check failed: remote-control is unavailable for this session. Run borg_regen manually whenever you return, and expect only fallback wakeups until relaunch.`;
    } else {
      codexWakePathClause =
        `Codex wake-path capability check passed: remote-control socket established for this session.`;
    }
    remoteArgs = remote.args;
    launchEnv = {
      ...withAgentRuntimeEnv(process.env, cli),
      ...remote.env,
      BORG_SESSION: '1',
    };
    codexSocketPath = socketPathFromRemoteArgs(remote.args);
    codexServerCleanup = remote.server?.cleanup ?? null;
  } else if (cli === 'codex' && passthroughArgs.includes('--remote')) {
    codexWakePathClause =
      `Codex wake-path capability check: using caller-provided --remote socket; if no wake arrives, run borg_regen manually when returning to the session.`;
    codexSocketPath = socketPathFromRemoteArgs(passthroughArgs);
    if (codexSocketPath) {
      launchEnv = {
        ...withAgentRuntimeEnv(process.env, cli),
        [BORG_CODEX_REMOTE_WAKE_ENV]: '1',
        BORG_SESSION: '1',
      };
    }
  }

  const kickoff = buildAgentKickoffPrompt({
    cli,
    codexWakeNonce,
    monitorClause,
    codexWakePathClause,
  });
  // This stays separate from the shared kickoff so Claude and Codex preserve
  // their existing launch prompts. OpenCode records this nonce-bearing copy
  // and later uses the nonce to bind its separately spawned MCP child.
  let openCodeKickoff: ReturnType<typeof createOpenCodeLaunchKickoff> | null = null;
  let openCodePort: number | undefined;
  let launchArgs: string[];
  if (cli === 'codex') {
    // gh#673 P1-codex: codex MCP children only see the pinned
    // [mcp_servers.borg.env], never inherited env (V2 probe) — deliver
    // the borg-launch marker and selected CLI identity via per-invocation
    // -c overrides instead (V2b-proven). Remote wake remains a separate
    // transport capability, explicitly disabled when this launch has no
    // socket so legacy static config cannot spuriously arm a bridge.
    // client#20: the exact approval overrides above are launch-scoped and
    // consented. They remain separate from activation/identity/wake config.
    launchArgs = [
      ...launchApproval.codexArgs,
      ...codexBorgSessionConfigArgs(),
      ...codexAgentKindConfigArgs(),
      ...codexRemoteWakeConfigArgs(codexSocketPath !== null),
      ...codexStateRootConfigArgs(),
      ...codexLaunchSeatExpectationConfigArgs(),
      ...remoteArgs,
      ...withCodexCwdArg([...passthroughArgs, kickoff], process.cwd()),
    ];
  } else if (cli === 'opencode') {
    // OpenCode launch: start TUI with the kickoff passed via --prompt
    // (auto-submits it as the first message). BORG_SESSION is pinned in
    // opencode.json. The OS-selected loopback port lets the MCP child connect
    // to OpenCode's local HTTP API without a shared deterministic collision space.
    openCodePort = await allocateOpenCodePort();
    installBorgPlugin();
    openCodeKickoff = createOpenCodeLaunchKickoff(kickoff);
    launchArgs = [];
  } else {
    // gh#702: borg-launched claude drones auto-allow ONLY mcp__borg__* so they
    // never prompt on borg coordination calls; Bash/file/web still prompt.
    launchArgs = buildClaudeLaunchArgs(passthroughArgs, kickoff);
  }

  const cliDisplayName = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : 'OpenCode';
  console.error(`${consolePrefix()}${chalk.blue(`◼ Launching ${cliDisplayName}…`)}`);

  const agentProcess = cli === 'opencode' && openCodeKickoff && openCodePort !== undefined
    ? launchOpenCodeProcess({
        cwd: process.cwd(),
        port: openCodePort,
        prompt: openCodeKickoff.prompt,
        passthroughArgs,
        env: launchEnv,
        droneLabel: active?.droneLabel ?? 'opencode',
        cubeName: active?.name ?? 'borg',
        kickoff: openCodeKickoff,
      }).process
    : spawn(cli, launchArgs, { stdio: 'inherit', shell: false, env: launchEnv });

  // gh#857 WI-2: wake-target recording is codex-only (app-server bridge).
  // OpenCode uses HTTP entry injection; Claude uses the inbox Monitor.
  if (cli === 'codex' && active && codexSocketPath) {
    void recordCodexWakeTarget({
      deps: { setCodexWakeTarget, findLoadedCodexThread },
      cubeId: active.cubeId,
      droneId: active.droneId,
      socketPath: codexSocketPath,
      passthroughArgs,
      previewNeedle: codexWakeNonce ?? kickoff.slice(0, 120),
      cwd: process.cwd(),
      launchedAtSeconds: Math.floor(Date.now() / 1000),
    });
    // gh#855: self-heal the wake-target file — drop entries whose app-server
    // socket is positively dead (crashed prior launches), mirroring the
    // socket-dir pruneStaleSockets. Best-effort; never blocks the launch.
    void pruneDeadCodexWakeTargets((sock) => checkCodexBridgeHealthy(sock));
  }

  agentProcess.on('error', (err: NodeJS.ErrnoException) => {
    if (codexServerCleanup) {
      try {
        codexServerCleanup();
      } catch {
        // best-effort
      }
    }
    if (err.code === 'ENOENT') {
      console.error(`${consolePrefix()}${chalk.red(`\n◼ Failed to launch ${cli}`)}`);
      const cliName = cli === 'opencode' ? 'opencode' : cli;
      console.error(`${consolePrefix()}${chalk.gray(`Make sure ${cliName} is installed.\n`)}`);
    } else {
      console.error(`${consolePrefix()}${chalk.red(`\n◼ Failed to launch ${cli}: ${err.message}\n`)}`);
    }
    process.exit(1);
  });

  agentProcess.on('exit', (code) => {
    if (codexServerCleanup) {
      try {
        codexServerCleanup();
      } catch {
        // best-effort
      }
    }
    process.exit(code ?? 0);
  });
}

export function ensureResolvedCliConfigured(cli: BorgCli, active: ActiveCube | null = null): void {
  const label = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : 'OpenCode';
  const targetedOpenCodeLaunch = cli === 'opencode' &&
    Boolean(process.env[BORG_LAUNCH_EXPECTED_SEAT_ENV]);
  try {
    configureResolvedCli(cli, {
      ensureMcp: (selectedCli) => {
        try {
          ensureCliMcpConfigured(selectedCli);
        } catch (error) {
          if (targetedOpenCodeLaunch && selectedCli === 'opencode') {
            throw new OpenCodeTargetedLaunchConfigError(
              active?.droneLabel ?? '<unknown>',
              active?.worktree ?? process.cwd(),
            );
          }
          throw error;
        }
      },
      addClaudeProjectSessionStartHook: () => {
        // gh#673 P2 (WI-1): the orientation hook lives PROJECT-LOCAL in
        // <root>/.claude/settings.local.json — ensured on every bare
        // `borg` launch so pre-P2 worktrees self-heal. The legacy GLOBAL
        // hook is then removed after the local hook is in place.
        addProjectSessionStartHook(findProjectRoot(process.cwd()));
      },
      removeClaudeGlobalSessionStartHook: removeSessionStartHook,
      addClaudeUserPromptSubmitHook: addUserPromptSubmitHook,
      addCodexSessionStartHook,
      addCodexUserPromptSubmitHook,
      installOpenCodePlugin: installBorgPlugin,
    });
  } catch (err: any) {
    if (err instanceof OpenCodeTargetedLaunchConfigError) throw err;
    console.error(`${consolePrefix()}${chalk.yellow(`warning: ${label} integration check failed: ${err?.message ?? err}`)}`);
  }
  try {
    warnIfAgentIntegrationUnhealthy({
      stderr: (text) => console.error(`${consolePrefix()}${chalk.yellow(text.trimEnd())}`),
    });
  } catch (err: any) {
    console.error(`${consolePrefix()}${chalk.yellow(
      `warning: agent integration health check failed; launch continues: ${err?.message ?? err}`,
    )}`);
  }
}

function isEntryInvocation(): boolean {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryInvocation()) {
  main().catch((error) => {
    if (
      error instanceof LaunchSeatIdentityChangedError ||
      error instanceof OpenCodeTargetedLaunchConfigError
    ) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    console.error(`${consolePrefix()}${chalk.red(`\n◼ Error: ${error.message}\n`)}`);
    process.exit(1);
  });
}
