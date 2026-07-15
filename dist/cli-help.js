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
        `Docs & quickstart: https://borgmcp.ai/get-started\n\n` +
        `Install Claude Code, Codex, or OpenCode first. Type \`borg ...\` in your terminal;\n` +
        `type \`borg_...\` inside your agent session once you've joined a cube ("assimilate").\n\n` +
        `Usage:\n` +
        `  borg                     Launch your agent CLI; in a TTY, bare borg may show the launch menu\n` +
        `  borg setup               Set up OAuth + register MCP server\n` +
        `  borg setup --no-browser  Set up from SSH/headless terminals\n` +
        `  borg assimilate [role]   Join or create a Borg Cloud cube\n` +
        `  borg assimilate --host <host>   Attach to a pre-provisioned self-hosted cube (preview)\n` +
        `  borg assimilate --worktree <name>   Spawn a worktree drone (in ~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg sync [--prune]      Sync this worktree's branch to origin/main\n` +
        `  borg cleanup [--prune]   Report (or --prune) worktrees orphaned by evicted drones\n` +
        `  borg launch-all [cube]   Launch all drone worktrees of a cube (default: active cube)\n` +
        `  borg launch-all [cube] --cli claude|codex|opencode\n` +
        `                           Launch all drone worktrees with that agent CLI\n` +
        `  borg --cli claude|codex|opencode  Launch that agent CLI directly\n` +
        `  borg --version           Show installed version\n\n` +
        `All other arguments are passed through to the selected agent CLI.\n`);
}
/**
 * Help text for `borg assimilate --help` — the home for the full assimilate flag
 * set. Model/provider configuration belongs to the selected agent CLI.
 */
export function assimilateHelpText(version) {
    return (`borg assimilate (borgmcp ${version}) — join or create a Borg Cloud cube under a role\n\n` +
        `Usage:\n` +
        `  borg assimilate [role]               Join the active cube under [role] (default role if omitted)\n` +
        `  borg assimilate [role] --worktree <name>   Spawn the drone in an isolated git worktree\n` +
        `                                       (~/.borg/worktrees/<repo>/<name>)\n` +
        `  borg assimilate --here               Assimilate in the current worktree (no sibling spawn)\n` +
        `  borg assimilate --host <host>        Attach to a pre-provisioned authorized cube and role\n` +
        `  borg assimilate --host <host> --enroll   Preview via hidden invitation prompt; not release-ready\n` +
        `  borg assimilate --help               Show this help\n\n` +
        `Flags:\n` +
        `  --worktree <name>          Create + launch the drone in a sibling git worktree\n` +
        `  --here                     Stay in the current worktree (no sibling spawn)\n` +
        `  --cube-name <name>         Borg Cloud cube to join/create (default: repo basename)\n` +
        `  --host <host>              Borg server host or URL (bare hosts default to HTTPS)\n` +
        `  --enroll                   Preview held local enrollment; invitation is never an argument\n` +
        `  --template <name>          Bootstrap a new Borg Cloud cube from a bundled role template\n` +
        `  --no-template              Create the Borg Cloud cube with no template roles\n` +
        `  --cli claude|codex|opencode         Agent CLI to launch (default: claude)\n` +
        `  --model claude:<model>   Legacy Claude model override (configure models in the agent CLI)\n` +
        `  --yes, -y                  Skip confirmation prompts\n\n` +
        `Self-hosted --host never creates a cube or falls back to Borg Cloud. It requires a\n` +
        `pre-provisioned grant; local enrollment is not dogfood/release-ready. See docs/LOCAL_SERVER.md.\n\n` +
        `For local or provider-specific models, configure the selected agent CLI directly.\n` +
        `OpenCode supports Ollama and other providers through its own model configuration.\n`);
}
/**
 * Help text for `borg setup --help` (gh#520 — previously this ran the setup
 * wizard instead of showing help). Mirrors the `borg setup` description in the
 * top-level `borg --help`.
 */
export function setupHelpText(version) {
    return (`borg setup (borgmcp ${version}) — set up OAuth + register the borg MCP server\n\n` +
        `Borg MCP needs Claude Code, Codex, or OpenCode installed first.\n\n` +
        `Usage:\n` +
        `  borg setup               Run the interactive setup wizard (OAuth sign-in +\n` +
        `                           register the borg MCP server with your agent CLI)\n` +
        `  borg setup --no-browser  Sign in without a local browser (device-code flow)\n` +
        `                           for SSH / headless / container terminals. Alias: --device.\n` +
        `                           Auto-detected on SSH/headless; this forces it.\n` +
        `  borg setup --help        Show this help\n`);
}
//# sourceMappingURL=cli-help.js.map