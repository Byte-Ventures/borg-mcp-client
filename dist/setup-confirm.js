/**
 * gh#818 P3 — disclose + confirm the `borg setup` global-config mutation.
 *
 * Step-1 of the setup wizard writes the user's GLOBAL agent config
 * (registers the borg MCP server + hooks). Before gh#818 this happened
 * silently on first run. This module adds informed-consent disclosure:
 * it lists WHICH files will be written (well-known `os.homedir()` paths)
 * and asks to continue before the first mutation.
 *
 * Pure / dep-injected (mirrors `resolveCliChoice` + `setup-action.ts`) so
 * the decision is unit-testable without spawning a prompt or touching argv.
 *
 * SECURITY (SR-light, gh#818 221c43df): the disclosure lists file PATHS +
 * at most the PUBLIC `BORG_API_URL` — there is NO token/secret in the
 * written config to echo. Local credentials live in the local 0600-permission
 * seat store, and the written config never contains a token or secret.
 */
/**
 * The set of global config files Step-1 writes, scoped to the detected
 * agent CLIs. Paths mirror `config-utils.ts`:
 *   Claude Code: ~/.claude.json (MCP server) + ~/.claude/settings.json (hook)
 *   Codex:       ~/.codex/config.toml (MCP server) + ~/.codex/hooks.json (hooks)
 *   OpenCode:    ~/.config/opencode/opencode.json (MCP server)
 */
export function configMutationTargets(deps) {
    const targets = [];
    if (deps.claude) {
        targets.push({
            file: '~/.claude.json',
            change: 'registers the borg MCP server',
        });
        targets.push({
            file: '~/.claude/settings.json',
            change: 'adds a UserPromptSubmit hook',
        });
    }
    if (deps.codex) {
        targets.push({
            file: '~/.codex/config.toml',
            change: 'registers the borg MCP server',
        });
        targets.push({
            file: '~/.codex/hooks.json',
            change: 'adds SessionStart + UserPromptSubmit hooks',
        });
    }
    if (deps.opencode) {
        targets.push({
            file: '~/.config/opencode/opencode.json',
            change: 'registers the borg MCP server (with BORG_SESSION activation)',
        });
    }
    return targets;
}
/**
 * Disclosure text: the files Step-1 will write + an undo note. Pure so SR
 * can pin "lists paths only, no secret". Lists the public `BORG_API_URL`
 * only by reference (the MCP-server registration env), never a credential.
 */
export function formatConfigMutationDisclosure(targets) {
    const lines = [];
    lines.push('borg setup will register the borg MCP server in your agent config:');
    for (const t of targets) {
        lines.push(`  • ${t.file}  (${t.change})`);
    }
    lines.push('These changes are additive and reversible — remove the "borg" entries to undo.');
    return lines.join('\n');
}
/**
 * Decide whether to proceed with the Step-1 config mutation.
 *
 * The six CR-binding build-gate items (gh#818, 3b3e85a5) live here:
 *   1. (THE load-bearing headless no-regress) non-TTY → 'proceed' WITHOUT
 *      prompting. We return before touching `confirm`, so a non-TTY run
 *      (CI / pipe / headless) never reads stdin → no hang.
 *   2. `--yes`/`-y` → 'proceed' without prompting (scripted-but-TTY +
 *      explicit non-interactive). No collision with --no-browser/--device.
 *   3. TTY + interactive → ask; decline → 'abort' (the caller exits BEFORE
 *      any write).
 *   6. This dep-injected shape IS the testable seam.
 */
export async function confirmConfigMutation(deps) {
    if (!deps.isTTY)
        return 'proceed'; // item 1 — never block on stdin
    if (deps.yes)
        return 'proceed'; // item 2 — explicit bypass
    const ok = await deps.confirm(); // item 3 — interactive consent
    return ok ? 'proceed' : 'abort';
}
/**
 * Scan argv for the `--yes` / `-y` bypass. Kept separate so the flag set
 * is pinned in tests (item 2 — no collision with the existing
 * --no-browser/--device scan in setup.ts).
 */
export function parseYesFlag(argv) {
    return argv.includes('--yes') || argv.includes('-y');
}
/**
 * gh#844 — whether Step-1 has ANY config mutation worth disclosing.
 *
 * The disclosure + confirm prompt exists to obtain informed consent for the
 * config writes Step-1 performs (gh#818). On a pure refresh — the normal
 * setup re-run where every DETECTED agent CLI already has the full
 * borg setup (MCP server registered AND every hook write already applied) —
 * there is no mutation to consent to, so the prompt is redundant and skipped.
 *
 * CRITICAL (gh#844 SR finding 8d9c732e): the gate must cover the FULL disclosed
 * mutation set — MCP registration AND every hook write (claude UserPromptSubmit
 * + the legacy SessionStart removal; codex SessionStart + UserPromptSubmit) —
 * not MCP registration alone. Otherwise an MCP-configured user with a pending
 * hook write (e.g. a pre-gh#673 upgrader whose legacy global hook must be
 * removed) would have settings.json mutated with consent silently skipped.
 * Caller derives `claudeHookPending`/`codexHookPending` from the SAME peeks
 * that gate the individual writers, so the gate and the writers cannot drift.
 *
 * Scoped to DETECTED CLIs: a claude-only user is never gated on codex config
 * state (and vice-versa). A naive `!isMcpServerConfigured() ||
 * !isCodexMcpServerConfigured()` gate would mis-fire for single-CLI users —
 * the absent CLI's config is unconfigured, so the OR would always be true.
 */
export function setupMutationPending(deps) {
    return ((deps.claude && (!deps.claudeMcpConfigured || deps.claudeHookPending)) ||
        (deps.codex && (!deps.codexMcpConfigured || deps.codexHookPending)) ||
        (deps.opencode && !deps.opencodeMcpConfigured));
}
//# sourceMappingURL=setup-confirm.js.map