/**
 * Pure CLI help-text + flag helpers.
 *
 * Kept in its own module (not in claude.ts) so importing them in tests does NOT
 * run claude.ts's `main()` side effects — the same pattern as parse-assimilate-args.ts
 * and cli-platform.ts.
 */
/** True for the standard help flags `--help` / `-h`. */
export function isHelpFlag(arg) {
    return arg === '--help' || arg === '-h';
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
        `type \`borg_...\` inside your agent session once you've joined a cube ("assimilate").\n\n` +
        `Usage:\n` +
        `  borg                     Launch your agent CLI; in a TTY, bare borg may show the launch menu\n` +
        `  borg setup               Set up borg MCP server + agent CLI integration\n` +
        `  borg assimilate [role]   Join or create a cube\n` +
        `  borg assimilate --host <host>   Join or create on an explicit server\n` +
        `  borg assimilate --worktree <name>   Spawn a worktree drone (in ~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg reset-local-seat    Clear ONLY this worktree's saved local seat (offline; after a rejection)\n` +
        `  borg sync [--prune]      Sync this worktree's branch to origin/main\n` +
        `  borg cleanup [--prune]   Report (or --prune) worktrees orphaned by evicted drones\n` +
        `  borg launch-all [cube]   Launch all drone worktrees of a cube (default: active cube)\n` +
        `  borg launch-all [cube] --cli claude|codex|opencode\n` +
        `                           Launch all drone worktrees with that agent CLI\n` +
        `  borg server <command> [arguments]\n` +
        `  borg --cli claude|codex|opencode  Launch that agent CLI directly\n` +
        `  borg --version           Show installed version\n\n` +
        `All other arguments are passed through to the selected agent CLI.\n`);
}
/** Product Design-approved client-owned copy for `borg server --help`. */
export function serverHelpText() {
    return (`Usage: borg server <command> [arguments]\n\n` +
        `Commands:\n` +
        `  setup    Prepare local server identity and data; does not start the server.\n` +
        `  start    Start the verified server in the foreground.\n` +
        `  stop     Stop the managed local server.\n` +
        `  status   Report verified runtime evidence.\n` +
        `  update   Verify and activate a local server artifact.\n` +
        `  invite   Create a single-use invitation in an interactive terminal.\n\n` +
        `Run borg server <command> --help for server command options.\n`);
}
/**
 * Help text for `borg assimilate --help` — the home for the full assimilate flag
 * set. Model/provider configuration belongs to the selected agent CLI.
 */
export function assimilateHelpText(version) {
    return (`borg assimilate (borgmcp ${version}) — join or create a cube under a role\n\n` +
        `Usage:\n` +
        `  borg assimilate [role]               Join the active cube under [role] (default role if omitted)\n` +
        `  borg assimilate [role] --worktree <name>   Spawn the drone in an isolated git worktree\n` +
        `                                       (~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg assimilate --here               Assimilate in the current worktree (no sibling spawn)\n` +
        `  borg assimilate --host <host>        Join an authorized self-hosted cube\n` +
        `  borg assimilate --host <host> --enroll   Operator-terminal enrollment, then create/join (preview)\n` +
        `  borg assimilate --help               Show this help\n\n` +
        `Flags:\n` +
        `  --worktree <name>          Create + launch the drone in a sibling git worktree\n` +
        `  --here                     Stay in the current worktree (no sibling spawn)\n` +
        `  --cube-name <name>         Cube to join/create (otherwise confirm repo basename)\n` +
        `  --host <host>              Borg server host or URL (bare hosts default to HTTPS)\n` +
        `  --enroll                   Prompt for a hidden enrollment invitation in the operator terminal\n` +
        `  --template <name>          Bootstrap a new cube from a bundled role template\n` +
        `  --no-template              Create the cube with no template roles\n` +
        `  --cli claude|codex|opencode         Agent CLI to launch (default: claude)\n` +
        `  --model claude:<model>   Legacy Claude model override (configure models in the agent CLI)\n` +
        `  --yes, -y                  Skip confirmation prompts\n\n` +
        `An enrolled owner client may create an idempotent repository cube; ordinary clients\n` +
        `require an explicit cube grant. Agent seats begin only after enrollment. Preview only.\n` +
        `See docs/LOCAL_SERVER.md for self-hosted setup and current status.\n\n` +
        `For local or provider-specific models, configure the selected agent CLI directly.\n` +
        `OpenCode supports Ollama and other providers through its own model configuration.\n`);
}
/**
 * Help text for `borg reset-local-seat --help`. The offline, network-free seat
 * reset recommended by the pin-matched SESSION_REJECTED diagnostic (#1082).
 */
export function resetLocalSeatHelpText(version) {
    return (`borg reset-local-seat (borgmcp ${version}) — clear ONLY this worktree's saved local seat\n\n` +
        `Offline and network-free: it contacts no server and revokes nothing server-side. It clears\n` +
        `just this worktree's saved local seat — its credential and cube binding together — from the\n` +
        `local seat store on this machine. Server, trust anchor, cube, and every sibling worktree are\n` +
        `left untouched.\n\n` +
        `Use it after \`borg assimilate\` reports this worktree's session was revoked or superseded\n` +
        `(a pin-matched rejection), then ask the operator for a new invitation and re-enroll.\n\n` +
        `Usage:\n` +
        `  borg reset-local-seat                 Reset this worktree's saved seat (TTY confirms [y/N])\n` +
        `  borg reset-local-seat --host <host>   No-op unless this worktree's seat is on <host>\n` +
        `  borg reset-local-seat --yes           Reset without a prompt (required when non-interactive)\n` +
        `  borg reset-local-seat --help          Show this help\n\n` +
        `Flags:\n` +
        `  --host <host>              Only act if this worktree's saved seat is on <host> (else no-op)\n` +
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