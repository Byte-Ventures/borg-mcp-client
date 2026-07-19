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
 *   borg sync           → Advance the current worktree across the 5
 *                         lifecycle states (see sync.ts, gh#33)
 */
import { spawn } from 'child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import { findProjectRoot, getActiveCube, inboxPathForDrone, setCodexWakeTarget, pruneDeadCodexWakeTargets } from './cubes.js';
import { monitorStateRootForWorktree } from './inbox-monitor.js';
import { handleVersionFlag, getPackageVersion } from './version.js';
import { isHelpFlag, setupHelpText, topLevelHelpText, assimilateHelpText, resetLocalSeatHelpText } from './cli-help.js';
import { runSpawn } from './spawn.js';
import { buildClaudeLaunchArgs } from './claude-launch-args.js';
import { parseSyncArgs, runSync } from './sync.js';
import { parseCleanupArgs, runCleanup } from './cleanup-cmd.js';
import { parseAssimilateArgs } from './parse-assimilate-args.js';
import { runAssimilate } from './assimilate-cmd.js';
import { buildDefaultAssimilateDeps } from './assimilate-deps.js';
import { parseResetLocalSeatArgs, runResetLocalSeat, buildDefaultResetLocalSeatDeps, } from './reset-local-seat-cmd.js';
import { parseLaunchAllArgs } from './parse-launch-all-args.js';
import { unknownSubcommand } from './unknown-subcommand.js';
import { runLaunchAll } from './launch-all-cmd.js';
import { buildDefaultLaunchAllDeps } from './launch-all-deps.js';
import { discoverDroneCandidates } from './launch-all-discovery.js';
import { explicitCliLaunchHint, runBareLaunchMenu, shouldResolveExplicitCliLaunchHintTargets, shouldShowLaunchMenu, } from './bare-launch-menu.js';
import { setTerminalTitle } from './terminal-title.js';
import { initConsolePrefix, consolePrefix } from './console-prefix.js';
import { initDebugFromArgv } from './debug.js';
import { defaultCliChoiceDeps, detectCliAvailability, installedCliNames, parseCliFlag, resolveCliChoice } from './cli-platform.js';
import { prepareCodexRemoteLaunch, resolveCodexLaunchCwd, withCodexCwdArg, defaultCodexRemoteDeps, checkCodexBridgeHealthy } from './codex-remote.js';
import { BORG_CODEX_REMOTE_WAKE_ENV, codexAgentKindConfigArgs, codexRemoteWakeConfigArgs, withAgentRuntimeEnv, } from './agent-runtime.js';
import { findLoadedCodexThread } from './codex-app-server.js';
import { buildAgentKickoffPrompt, buildKickoffWakePathClause, recordCodexWakeTarget, socketPathFromRemoteArgs, } from './codex-launch.js';
import { codexBorgSessionConfigArgs } from './launch-gate.js';
import { addCodexSessionStartHook, addCodexUserPromptSubmitHook, addProjectSessionStartHook, addUserPromptSubmitHook, removeSessionStartHook, } from './config-utils.js';
import { ensureCliMcpConfigured } from './ensure-mcp-config.js';
import { installBorgPlugin } from './opencode-plugin.js';
import { connectOpenCodeDrone, computeOpenCodePort, createOpenCodeLaunchKickoff, injectInitialKickoff } from './opencode-drone.js';
import { buildOpenCodeLaunchArgs, defaultApprovalIo, resolveLaunchBorgApprovals } from './cli-tool-approval.js';
async function main() {
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
    // Re-route subcommands.
    if (process.argv[2] === 'setup') {
        // gh#520: `borg setup --help` must show help, not run the wizard.
        if (isHelpFlag(process.argv[3])) {
            process.stdout.write(setupHelpText(getPackageVersion()));
            process.exit(0);
        }
        await import('./setup.js');
        return;
    }
    if (process.argv[2] === 'assimilate') {
        // `borg assimilate --help` (or `... <role> --help`) must show help, not be
        // rejected by the parser as an unknown flag.
        if (process.argv.slice(3).some(isHelpFlag)) {
            process.stdout.write(assimilateHelpText(getPackageVersion()));
            process.exit(0);
        }
        const parsed = parseAssimilateArgs(process.argv.slice(3));
        if (!parsed.ok) {
            process.stderr.write(chalk.red(`${consolePrefix()}◼ borg assimilate: ${parsed.error}\n`));
            process.stderr.write(`Run \`borg --help\` for usage.\n`);
            process.exit(1);
        }
        const deps = buildDefaultAssimilateDeps();
        const code = await runAssimilate({ role: parsed.role, flags: parsed.flags }, deps);
        process.exit(code);
    }
    if (process.argv[2] === 'reset-local-seat') {
        if (process.argv.slice(3).some(isHelpFlag)) {
            process.stdout.write(resetLocalSeatHelpText(getPackageVersion()));
            process.exit(0);
        }
        const parsed = parseResetLocalSeatArgs(process.argv.slice(3));
        if (!parsed.ok) {
            process.stderr.write(chalk.red(`${consolePrefix()}◼ borg reset-local-seat: ${parsed.error}\n`));
            process.stderr.write(`Run \`borg --help\` for usage.\n`);
            process.exit(1);
        }
        const code = await runResetLocalSeat(parsed.flags, buildDefaultResetLocalSeatDeps());
        process.exit(code);
    }
    if (process.argv[2] === 'spawn') {
        // Deprecated; the stub prints a redirect message and exits 2.
        const code = await runSpawn();
        process.exit(code);
    }
    if (process.argv[2] === 'sync') {
        const parsed = parseSyncArgs(process.argv.slice(3));
        if (!parsed.ok) {
            process.stderr.write(chalk.red(`${consolePrefix()}◼ borg sync: ${parsed.error}\n`));
            process.stderr.write(`Run \`borg --help\` for usage.\n`);
            process.exit(1);
        }
        const code = await runSync({}, parsed.options);
        process.exit(code);
    }
    if (process.argv[2] === 'cleanup') {
        const parsed = parseCleanupArgs(process.argv.slice(3));
        if (!parsed.ok) {
            process.stderr.write(chalk.red(`${consolePrefix()}◼ borg cleanup: ${parsed.error}\n`));
            process.stderr.write(`Run \`borg --help\` for usage.\n`);
            process.exit(1);
        }
        const code = await runCleanup({}, parsed.options);
        process.exit(code);
    }
    if (process.argv[2] === 'launch-all') {
        const parsed = parseLaunchAllArgs(process.argv.slice(3));
        if (!parsed.ok) {
            process.stderr.write(chalk.red(`${consolePrefix()}◼ borg launch-all: ${parsed.error}\n`));
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
        process.stderr.write(chalk.red(`${consolePrefix()}◼ unknown command: ${unknownCmd}\n`));
        process.stderr.write(`Run \`borg --help\` for usage.\n`);
        process.exit(1);
    }
    const parsedCli = parseCliFlag(process.argv.slice(2));
    if (parsedCli.error) {
        process.stderr.write(chalk.red(`${consolePrefix()}◼ ${parsedCli.error}\n`));
        process.stderr.write(`Run \`borg --help\` for usage.\n`);
        process.exit(1);
    }
    const prompt = async (message) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            return await rl.question(message);
        }
        finally {
            rl.close();
        }
    };
    let cli = await resolveCliChoice(parsedCli.cli, defaultCliChoiceDeps(prompt, () => process.stdin.isTTY === true));
    ensureDetectedCliConfigured();
    // Active cube for this directory — needed for the launch menu's option-3
    // availability, the terminal title, and the inbox-Monitor clause below.
    const active = await getActiveCube();
    let launchAllTargetsAvailable;
    const hasLaunchAllTargets = async () => {
        if (!active)
            return false;
        if (launchAllTargetsAvailable === undefined) {
            const candidates = await discoverDroneCandidates({ targetCubeId: active.cubeId }, buildDefaultLaunchAllDeps());
            launchAllTargetsAvailable = candidates.length > 0;
        }
        return launchAllTargetsAvailable;
    };
    const stdinIsTTY = process.stdin.isTTY === true;
    const stdoutIsTTY = process.stdout.isTTY === true;
    const explicitCliHint = explicitCliLaunchHint({
        explicitCli: parsedCli.cli,
        stdinIsTTY,
        stdoutIsTTY,
        hasActiveCube: active !== null,
        hasLaunchAllTargets: shouldResolveExplicitCliLaunchHintTargets({
            explicitCli: parsedCli.cli,
            stdinIsTTY,
            stdoutIsTTY,
            hasActiveCube: active !== null,
        }) ? await hasLaunchAllTargets() : false,
    });
    if (explicitCliHint)
        process.stderr.write(explicitCliHint);
    // gh#853: bare `borg` (no args) interactive launch menu. TTY-only + bare-args-
    // only (shouldShowLaunchMenu) so every scripted/programmatic `borg` and every
    // explicit subcommand/flag is untouched; the get-started breadcrumb already
    // exited above, so it keeps precedence over the menu. The option-set and
    // selection→action mapping are pure (bare-launch-menu.ts) — this is the glue
    // that computes inputs and dispatches the chosen action.
    if (shouldShowLaunchMenu({
        extraArgs: process.argv.slice(2),
        stdinIsTTY,
        stdoutIsTTY,
    })) {
        const otherInstalledClis = installedCliNames(detectCliAvailability()).filter((c) => c !== cli);
        const action = await runBareLaunchMenu({ defaultCli: cli, otherInstalledClis, hasLaunchAllTargets: await hasLaunchAllTargets() }, prompt);
        if (action.kind === 'launch-all') {
            const parsed = parseLaunchAllArgs([]); // empty args → active cube, auto backend
            const code = parsed.ok ? await runLaunchAll(parsed.args, buildDefaultLaunchAllDeps()) : 1;
            process.exit(code);
        }
        // option 1 → configured default; option 2 → the other agent, ONE-SHOT
        // (we deliberately do NOT call setProjectCliPreference — the saved
        // preference is changed only via `borg --cli <agent>`).
        cli = action.cli;
    }
    // client#20: inspect only the SELECTED harness after the one-shot launch
    // menu choice. Explicit consent enables a narrow per-process override;
    // Borg never rewrites the user's approval policy here.
    const approvalCwd = cli === 'codex'
        ? resolveCodexLaunchCwd(parsedCli.rest, process.cwd())
        : process.cwd();
    const launchApproval = await resolveLaunchBorgApprovals(cli, defaultApprovalIo(prompt, () => process.stdin.isTTY === true, {
        cwd: approvalCwd,
        env: process.env,
        codexArgs: parsedCli.rest,
    }));
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
    setTerminalTitle(active ? { label: active.droneLabel, cubeName: active.name } : null, basename(process.cwd()));
    // gh#929: the claude wake-path/Monitor-arming clause is the SHARED
    // wakePathArming (same core the SessionStart hook + /clear orientation use)
    // + the NEVER-TaskStop reminder. Codex / opencode / no-active-cube → empty.
    const monitorClause = buildKickoffWakePathClause(cli, active && cli === 'claude' ? inboxPathForDrone(active.cubeId, active.droneId) : null, active && cli === 'claude'
        ? monitorStateRootForWorktree(findProjectRoot(process.cwd()))
        : null);
    const codexWakeNonce = cli === 'codex' ? `borg-wake-${randomUUID()}` : null;
    let codexWakePathClause;
    let remoteArgs = [];
    // gh#673 P1: mark the agent session as borg-launched. Claude Code's MCP
    // child + hook commands inherit this env, gating the borg activation
    // surface (launch-gate.ts). ACTIVATION-only — never a security gate.
    // OpenCode MCP children get BORG_SESSION from the pinned env in the
    // opencode.json config (same mechanism as codex's pinned env).
    // Pin CLI identity independently of a model selection and the optional
    // Codex remote-wake transport. In particular, clear a stale Codex marker
    // before a Codex -> Claude relaunch can reach its MCP child.
    let launchEnv = { ...withAgentRuntimeEnv(process.env, cli), BORG_SESSION: '1' };
    if (cli === 'opencode' && launchApproval.openCodePermission) {
        launchEnv.OPENCODE_PERMISSION = launchApproval.openCodePermission;
    }
    let codexSocketPath = null;
    let codexServerCleanup = null;
    if (cli === 'codex' && !passthroughArgs.includes('--remote')) {
        console.error(`${consolePrefix()}${chalk.gray('◼ Starting Codex remote-wake app-server…')}`);
        const remote = await prepareCodexRemoteLaunch(defaultCodexRemoteDeps());
        if (remote.warning) {
            console.error(`${consolePrefix()}${chalk.yellow(`warning: ${remote.warning}`)}`);
            codexWakePathClause =
                `⚠ Codex wake-path capability check failed: remote-control is unavailable for this session. Run borg_regen manually whenever you return, and expect only fallback wakeups until relaunch.`;
        }
        else {
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
    }
    else if (cli === 'codex' && passthroughArgs.includes('--remote')) {
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
    let openCodeKickoff = null;
    let launchArgs;
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
            ...remoteArgs,
            ...withCodexCwdArg([...passthroughArgs, kickoff], process.cwd()),
        ];
    }
    else if (cli === 'opencode') {
        // OpenCode launch: start TUI with the kickoff passed via --prompt
        // (auto-submits it as the first message). BORG_SESSION is pinned in
        // opencode.json. A unique port is assigned so the MCP child can connect
        // via the HTTP API for context-streaming (injectOpenCodeEntry).
        const dronePort = active
            ? computeOpenCodePort(active.droneId)
            : 14096;
        installBorgPlugin();
        openCodeKickoff = createOpenCodeLaunchKickoff(kickoff);
        launchArgs = buildOpenCodeLaunchArgs(process.cwd(), dronePort, openCodeKickoff.prompt, passthroughArgs);
    }
    else {
        // gh#702: borg-launched claude drones auto-allow ONLY mcp__borg__* so they
        // never prompt on borg coordination calls; Bash/file/web still prompt.
        launchArgs = buildClaudeLaunchArgs(passthroughArgs, kickoff);
    }
    const cliDisplayName = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : 'OpenCode';
    console.error(`${consolePrefix()}${chalk.blue(`◼ Launching ${cliDisplayName}…`)}`);
    const agentProcess = spawn(cli, launchArgs, {
        stdio: 'inherit',
        shell: false,
        env: launchEnv,
    });
    // gh#opencode: find the opened session after launch. The kickoff was already
    // submitted via --prompt, so we just discover the session ID for inbox
    // entry injection. Fire-and-forget; never delay the launch.
    if (cli === 'opencode' && openCodeKickoff) {
        const launchKickoff = openCodeKickoff;
        const dronePort = active
            ? computeOpenCodePort(active.droneId)
            : 14096;
        const serverUrl = `http://127.0.0.1:${dronePort}`;
        // Fire-and-forget; never delay the launch or crash on failure.
        connectOpenCodeDrone({ serverUrl, directory: process.cwd(), droneLabel: active?.droneLabel ?? 'opencode', cubeName: active?.name ?? 'borg' })
            .then(() => injectInitialKickoff(launchKickoff))
            .catch(() => { });
    }
    // gh#857 WI-2: wake-target recording is codex-only (app-server bridge).
    // OpenCode has no remote-wake mechanisms yet; claude uses the inbox Monitor.
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
    agentProcess.on('error', (err) => {
        if (codexServerCleanup) {
            try {
                codexServerCleanup();
            }
            catch {
                // best-effort
            }
        }
        if (err.code === 'ENOENT') {
            console.error(`${consolePrefix()}${chalk.red(`\n◼ Failed to launch ${cli}`)}`);
            const cliName = cli === 'opencode' ? 'opencode' : cli;
            console.error(`${consolePrefix()}${chalk.gray(`Make sure ${cliName} is installed.\n`)}`);
        }
        else {
            console.error(`${consolePrefix()}${chalk.red(`\n◼ Failed to launch ${cli}: ${err.message}\n`)}`);
        }
        process.exit(1);
    });
    agentProcess.on('exit', (code) => {
        if (codexServerCleanup) {
            try {
                codexServerCleanup();
            }
            catch {
                // best-effort
            }
        }
        process.exit(code ?? 0);
    });
}
function ensureDetectedCliConfigured() {
    const found = detectCliAvailability();
    if (found.claude) {
        try {
            ensureCliMcpConfigured('claude');
            // gh#673 P2 (WI-1): the orientation hook lives PROJECT-LOCAL in
            // <root>/.claude/settings.local.json — ensured on every bare
            // `borg` launch so pre-P2 worktrees self-heal. The legacy GLOBAL
            // hook is then removed: safe because this ensure precedes every
            // borg-launched agent spawn (other projects get their local hook
            // at their own next launch/assimilate), and P1's BORG_SESSION
            // gate already no-ops the global hook in non-borg sessions.
            addProjectSessionStartHook(findProjectRoot(process.cwd()));
            removeSessionStartHook();
            addUserPromptSubmitHook();
        }
        catch (err) {
            console.error(`${consolePrefix()}${chalk.yellow(`warning: Claude Code integration check failed: ${err?.message ?? err}`)}`);
        }
    }
    if (found.codex) {
        try {
            ensureCliMcpConfigured('codex');
            addCodexSessionStartHook();
            addCodexUserPromptSubmitHook();
        }
        catch (err) {
            console.error(`${consolePrefix()}${chalk.yellow(`warning: Codex integration check failed: ${err?.message ?? err}`)}`);
        }
    }
    if (found.opencode) {
        try {
            ensureCliMcpConfigured('opencode');
        }
        catch (err) {
            console.error(`${consolePrefix()}${chalk.yellow(`warning: OpenCode integration check failed: ${err?.message ?? err}`)}`);
        }
    }
}
main().catch((error) => {
    console.error(`${consolePrefix()}${chalk.red(`\n◼ Error: ${error.message}\n`)}`);
    process.exit(1);
});
//# sourceMappingURL=claude.js.map