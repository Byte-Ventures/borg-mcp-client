/**
 * Pure CLI help-text + flag helpers.
 *
 * Kept in its own module (not in claude.ts) so importing them in tests does NOT
 * run claude.ts's `main()` side effects — the same pattern as parse-assimilate-args.ts
 * and cli-platform.ts.
 */
import { NEW_CUBE_TEMPLATE_PRESENTATIONS } from 'borgmcp-shared/templates';
const NEW_CUBE_TEMPLATE_OPTIONS = NEW_CUBE_TEMPLATE_PRESENTATIONS.map(({ name }) => name).join('|');
const DEFAULT_NEW_CUBE_TEMPLATE = NEW_CUBE_TEMPLATE_PRESENTATIONS[0].name;
/** True for the standard help flags `--help` / `-h`. */
export function isHelpFlag(arg) {
    return arg === '--help' || arg === '-h';
}
export function cleanupHelpText(version) {
    return (`borg cleanup (borgmcp ${version}) — review orphaned Borg-managed worktrees\n\n` +
        `Usage:\n` +
        `  borg cleanup          Report what is safe to remove; change nothing\n` +
        `  borg cleanup --prune  Remove only worktrees proven safe to prune\n` +
        `  borg cleanup --help   Show this help\n`);
}
export function launchAllHelpText(version) {
    return (`borg launch-all (borgmcp ${version}) — launch a cube's saved drone worktrees\n\n` +
        `Usage:\n` +
        `  borg launch-all [cube] [options]\n\n` +
        `Options:\n` +
        `  --mode <tmux|terminals|pastelist>     Select the launch backend\n` +
        `  --only <name>                         Launch one role or drone label\n` +
        `  --dry-run                             Show what would launch\n` +
        `  --no-attach                           Do not attach to the tmux session\n` +
        `  --yes, -y                             Skip the large-fleet confirmation\n` +
        `  --force                               Override live-session skips\n` +
        `  --launch-delay <ms>                   Wait between launches\n` +
        `  --help, -h                            Show this help\n\n` +
        `Modes:\n` +
        `  terminals  Open each drone in its own terminal tab, with the drone's name as\n` +
        `             the tab title. Default on macOS when iTerm2 or Terminal.app is\n` +
        `             installed. Terminal.app opens one named window for each drone\n` +
        `             instead; tabs would need macOS automation permissions, which borg\n` +
        `             does not request.\n` +
        `  tmux       Open all drones in one shared tmux session. Default on Linux.\n` +
        `  pastelist  Print the launch commands so you can run them yourself.\n`);
}
export function quickstartHelpText(version) {
    return (`borg quickstart (borgmcp ${version}) — create, staff, and launch this repository's cube\n\n` +
        `Usage:\n` +
        `  borg quickstart [options]\n\n` +
        `Options:\n` +
        `  --template <name>                  Choose without prompting:\n` +
        `                                     ${NEW_CUBE_TEMPLATE_OPTIONS}\n` +
        `  --role <slug>[:<count>]            Fully specify the roster (repeatable)\n` +
        `  --yes, -y                          Accept the displayed plan\n` +
        `  --help, -h                         Show this help\n\n` +
        `For the current repository, quickstart creates and launches a full roster.\n` +
        `Use --role to replace that roster with an explicit selection. Quickstart\n` +
        `requires a running Borg server and never starts one. Rerun the same command\n` +
        `after a partial failure; existing drones are kept and skipped.\n`);
}
export function cloneHelpText(version) {
    return (`borg clone (borgmcp ${version}) — clone a repository and run quickstart\n\n` +
        `Usage:\n` +
        `  borg clone <repository-url> [directory] [options]\n\n` +
        `Options:\n` +
        `  --template <name>                  Choose without prompting:\n` +
        `                                     ${NEW_CUBE_TEMPLATE_OPTIONS}\n` +
        `  --role <slug>[:<count>]            Fully specify the roster (repeatable)\n` +
        `  --yes, -y                          Accept the displayed plan\n` +
        `  --checkout-only                    Stop after the checkout is ready\n` +
        `  --no-launch                        Same as --checkout-only\n` +
        `  --help, -h                         Show this help\n\n` +
        `Clone checks out a new repository, then delegates the complete setup directly to\n` +
        `quickstart. Non-interactive full setup requires both --yes and --template.\n` +
        `A repeated command reuses a checkout only when its origin matches. Default\n` +
        `destination names avoid non-repository collisions. Credential-bearing URLs are\n` +
        `refused; use a Git credential helper or SSH configuration instead.\n`);
}
export function seatsHelpText(version) {
    return (`borg drones (borgmcp ${version}) — list this machine's registered drones\n\n` +
        `Usage:\n` +
        `  borg drones         Show drone, cube, worktree, agent CLI, and local state\n` +
        `  borg drones --help  Show this help\n\n` +
        `The local registry belongs to this machine only.\n`);
}
export function launchSeatHelpText(version) {
    return (`borg launch (borgmcp ${version}) — reopen one registered drone from its worktree\n\n` +
        `Usage:\n` +
        `  borg launch <drone-label-or-id-prefix>\n` +
        `  borg launch <drone-label-or-id-prefix> --cube <name>\n` +
        `  borg launch --help\n\n` +
        `Options:\n` +
        `  --cube <name>                Disambiguate the same drone label across cubes\n` +
        `  --help, -h                   Show this help\n`);
}
export function doctorHelpText(version) {
    return (`borg doctor (borgmcp ${version}) — inspect Borg agent integrations without changing them\n\n` +
        `Usage:\n` +
        `  borg doctor          Run read-only checks for hook commands, OpenCode integration, and startup diagnostics\n` +
        `  borg doctor --help   Show this help\n`);
}
export function clientSubcommandHelpText(command, args, version) {
    if (!args.some(isHelpFlag))
        return null;
    switch (command) {
        case 'setup': return setupHelpText(version);
        case 'clone': return cloneHelpText(version);
        case 'assimilate': return assimilateHelpText(version);
        case 'quickstart': return quickstartHelpText(version);
        case 'reset-local-connection': return resetLocalSeatHelpText(version);
        case 'recover-enrollment': return recoverEnrollmentHelpText(version);
        case 'cleanup': return cleanupHelpText(version);
        case 'drones': return seatsHelpText(version);
        case 'launch': return launchSeatHelpText(version);
        case 'launch-all': return launchAllHelpText(version);
        case 'doctor': return doctorHelpText(version);
        default: return null;
    }
}
export function setupNextStepsText() {
    return (`◼ Next steps:\n` +
        `1. Run \`borg server start\` and leave that terminal open.\n` +
        `2. In a second terminal, cd into your project's Git repository and run \`borg quickstart\`.\n`);
}
/**
 * Help text for top-level `borg --help`.
 *
 * Kept pure so tests can pin user-facing discoverability without importing
 * claude.ts, which launches agent CLIs as a side effect.
 */
export function topLevelHelpText(version) {
    return (`borgmcp ${version} — run several AI coding agents on one project, together.\n` +
        `              They coordinate through a shared log (a "cube"). For Claude Code, Codex & OpenCode.\n\n` +
        `Docs & quickstart: https://github.com/Byte-Ventures/borg-mcp-client#readme\n\n` +
        `Install Claude Code, Codex, or OpenCode first. Type \`borg ...\` in your terminal;\n` +
        `type \`borg_...\` inside your agent session once you've joined a cube ("assimilate").\n` +
        `Inside a cube, every log message requires \`to: "broadcast"\` or a non-empty selector list.\n` +
        `There is no omitted or taxonomy-selected audience.\n` +
        `Direct routing controls delivery and wakes, not secrecy from other cube members.\n\n` +
        `Usage:\n` +
        `  borg                     Show the launch menu in a repository root; resume directly in a linked worktree\n` +
        `  borg setup               Set up borg MCP server + agent CLI integration\n` +
        `  borg update              Update the client and installed local server together\n` +
        `  borg doctor              Check agent hook commands, OpenCode integration, and startup diagnostics\n` +
        `  borg clone <url> [dir]   Clone a repository, then create and launch its cube\n` +
        `  borg quickstart          Create a cube and a drone for every role, then launch them\n` +
        `  borg assimilate [role]   Join or create a cube with one drone under one role\n` +
        `  borg assimilate --host <host>   Join or create on an explicit server\n` +
        `  borg assimilate --worktree <name>   Spawn a worktree drone (in ~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg server cube init    Initialize this repository's cube without creating a drone\n` +
        `  borg reset-local-connection  Clear ONLY this worktree's saved connection to its cube (offline; after a rejection)\n` +
        `  borg recover-enrollment  Restore or clear ONLY one failed server enrollment transaction\n` +
        `  borg cleanup [--prune]   Report (or --prune) worktrees orphaned by evicted drones\n` +
        `  borg drones              List this machine's registered drones and worktrees\n` +
        `  borg launch <drone-label-or-id-prefix>  Reopen one registered drone from its worktree\n` +
        `  borg launch-all [cube]   Launch all drone worktrees of a cube (default: active cube)\n` +
        `  borg server <command> [arguments]\n` +
        `  borg --cli claude|codex|opencode  Launch that agent CLI directly\n` +
        `  borg --version           Show installed version\n\n` +
        `All other arguments are passed through to the selected agent CLI.\n`);
}
export function recoverEnrollmentHelpText(version) {
    return (`borg recover-enrollment (borgmcp ${version}) — restore or clear one failed server enrollment\n\n` +
        `Usage:\n` +
        `  borg recover-enrollment [--host <host>] [--yes]\n` +
        `  borg recover-enrollment --help\n\n` +
        `This operation restores or clears only the failed enrollment transaction for one server.\n` +
        `It does not touch other server enrollments or accounts. It never requires manual file editing.\n`);
}
/** Help for the whole-product, npm-owned update journey. */
export function updateHelpText(version) {
    return (`borg update${version ? ` (borgmcp ${version})` : ''} — update Borg's client and local server together\n\n` +
        `Usage:\n` +
        `  borg update             Confirm interactively, then update\n` +
        `  borg update --yes       Update without prompting (required outside a TTY)\n` +
        `  borg update --registry <url>\n` +
        `                          Acknowledge this exact configured npm registry for one update\n` +
        `  borg update --help      Show this help\n\n` +
        `Before changing anything, Borg reads the exact published client and server manifests,\n` +
        `requires matching exact borgmcp-shared pins, and verifies canonical npm ownership. The client is\n` +
        `installed first and the update continues under that new client before the server controller\n` +
        `and runtime are updated. An alternate configured registry requires an exact per-invocation\n` +
        `--registry acknowledgement; registry changes refuse before any subsequent package mutation,\n` +
        `and unsupported or ambiguous package-manager provenance fails closed.\n\n` +
        `If no local server is installed, the server phase is skipped. A failure after the client\n` +
        `succeeds is reported as partial completion with status-specific recovery. Borg never starts\n` +
        `a stopped server. After package verification, Borg replaces stale borgmcp package launch paths\n` +
        `in MCP registrations and managed agent hooks while preserving their other settings. It\n` +
        `leaves absent registrations and borg entries that point to another command unchanged. Borg\n` +
        `never restarts agent processes;\n` +
        `restart active agent sessions yourself.\n`);
}
/** Product Design-approved client-owned copy for `borg server --help`. */
export function serverHelpText() {
    return (`Usage: borg server <command> [arguments]\n\n` +
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
        `Run borg server <command> --help for server command options.\n`);
}
/** Client-owned help for the server-owned service command namespace. */
export function serverServiceHelpText() {
    return (`Usage: borg server service <command> [arguments]\n\n` +
        `Commands:\n` +
        `  install    Install and start the loopback-only per-user service.\n` +
        `  uninstall  Remove the managed service and preserve local state.\n`);
}
/** Client-owned help for repository cube initialization without a drone. */
export function cubeInitHelpText(version) {
    return (`borg server cube init (borgmcp ${version}) — initialize this Git repository's cube without creating a drone\n\n` +
        `Usage:\n` +
        `  borg server cube init [options]\n\n` +
        `Options:\n` +
        `  --host <host>                    Borg server host or URL (bare hosts default to HTTPS)\n` +
        `  --enroll                         Prompt for a hidden enrollment invitation\n` +
        `  --cube-name <name>               Repository cube name (otherwise edit the proposed name)\n` +
        `  --template ${NEW_CUBE_TEMPLATE_OPTIONS}  New-cube template (default: ${DEFAULT_NEW_CUBE_TEMPLATE})\n` +
        `  --yes, -y                        Accept new-cube defaults; never adopt by name\n` +
        `  --help, -h                       Show this help\n\n` +
        `An existing repository association skips all prompts. One accessible exact-name legacy\n` +
        `cube requires explicit interactive adoption; ambiguous matches fail closed. An enrolled\n` +
        `owner client may create a repository cube; ordinary clients require an explicit cube grant.\n`);
}
/**
 * Help text for `borg assimilate --help` — the home for the full assimilate flag
 * set. Model/provider configuration belongs to the selected agent CLI.
 */
export function assimilateHelpText(version) {
    return (`borg assimilate (borgmcp ${version}) — join or create a cube under a role\n\n` +
        `Usage:\n` +
        `  borg assimilate [role]               Create the drone in a managed git worktree\n` +
        `  borg assimilate [role] --worktree <name>   Name the drone's managed git worktree\n` +
        `                                       (~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg assimilate --here               Resume this worktree's saved drone\n` +
        `  borg assimilate --here --force       Reattach despite a still-live inbox monitor\n` +
        `  borg assimilate --host <host>        Join an authorized self-hosted cube\n` +
        `  borg assimilate --host <host> --enroll   Operator-terminal enrollment, then create/join (preview)\n` +
        `  borg assimilate --help               Show this help\n\n` +
        `Flags:\n` +
        `  --worktree <name>          Name the managed worktree created for the new drone\n` +
        `  --here                     Resume this worktree's saved drone\n` +
        `  --force                    Reattach despite a still-live inbox monitor in this worktree\n` +
        `  --cube-name <name>         Repository cube name (otherwise edit the proposed name)\n` +
        `  --host <host>              Borg server host or URL (bare hosts default to HTTPS)\n` +
        `  --enroll                   Prompt for a hidden enrollment invitation in the operator terminal\n` +
        `  --template ${NEW_CUBE_TEMPLATE_OPTIONS}   New-cube template (default: ${DEFAULT_NEW_CUBE_TEMPLATE})\n` +
        `  --no-template              Unsupported for repository cube creation\n` +
        `  --cli claude|codex|opencode         Agent CLI to launch\n` +
        `  --model claude:<model>   Legacy Claude model override (configure models in the agent CLI)\n` +
        `  --yes, -y                  Accept new-cube defaults; never adopt by name\n\n` +
        `Assimilate adds or resumes one drone under one role; use quickstart when you want\n` +
        `the repository's full roster.\n` +
        `Creation shows repository context, name, template, and one confirmation. An existing\n` +
        `repository association skips all prompts. One accessible exact-name legacy cube requires\n` +
        `explicit interactive adoption; ambiguous matches fail closed. An enrolled owner client may\n` +
        `create an idempotent repository cube; ordinary clients require an explicit cube grant.\n` +
        `A drone is created only after enrollment. Preview only.\n` +
        `See docs/LOCAL_SERVER.md for self-hosted setup and current status.\n\n` +
        `For local or provider-specific models, configure the selected agent CLI directly.\n` +
        `OpenCode supports Ollama and other providers through its own model configuration.\n`);
}
/**
 * Help text for `borg reset-local-connection --help`. The offline, network-free seat
 * reset recommended by the pin-matched SESSION_REJECTED diagnostic (#1082).
 */
export function resetLocalSeatHelpText(version) {
    return (`borg reset-local-connection (borgmcp ${version}) — clear ONLY this worktree's saved connection to its cube\n\n` +
        `Offline and network-free: it contacts no server and revokes nothing server-side. It clears\n` +
        `just this worktree's saved connection — its credential and cube binding together — from the\n` +
        `private store on this machine. Server, trust anchor, cube, and every sibling worktree are\n` +
        `left untouched.\n\n` +
        `Use it after \`borg assimilate\` reports this worktree's session was revoked or superseded\n` +
        `(a pin-matched rejection), then ask the operator for a new invitation and re-enroll.\n\n` +
        `Usage:\n` +
        `  borg reset-local-connection                 Reset this worktree's saved connection (TTY confirms [y/N])\n` +
        `  borg reset-local-connection --host <host>   No-op unless this worktree connects to <host>\n` +
        `  borg reset-local-connection --yes           Reset without a prompt (required when non-interactive)\n` +
        `  borg reset-local-connection --help          Show this help\n\n` +
        `Flags:\n` +
        `  --host <host>              Only act if this worktree connects to <host> (else no-op)\n` +
        `  --yes, -y                  Skip the confirmation prompt (required in non-TTY contexts)\n`);
}
/**
 * Help text for `borg setup --help` (gh#520 — previously this ran the setup
 * wizard instead of showing help). Mirrors the `borg setup` description in the
 * top-level `borg --help`.
 */
export function setupHelpText(version) {
    return (`borg setup (borgmcp ${version}) — set up borg MCP server + agent CLI integration\n\n` +
        `Borg MCP needs Claude Code, Codex, or OpenCode installed first.\n\n` +
        `Usage:\n` +
        `  borg setup               Run the interactive setup wizard\n` +
        `  borg setup --help        Show this help\n`);
}
//# sourceMappingURL=cli-help.js.map