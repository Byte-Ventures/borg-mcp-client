const CLI_TITLES = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
};
/** Build the first-run choices from the CLIs that are actually installed. */
export function setupAgentChoices(detected) {
    return [...new Set(detected)].map((cli) => ({
        title: CLI_TITLES[cli],
        value: cli,
        selected: true,
    }));
}
/**
 * Keep only detected agents and return them in detection order. The selected
 * set is invocation-local; it is deliberately never persisted.
 */
export function normalizeSetupAgentSelection(detected, selected) {
    if (!Array.isArray(selected))
        return [];
    const selectedSet = new Set(selected);
    return [...new Set(detected)].filter((cli) => selectedSet.has(cli));
}
/** Turn the prompt result into the terminal outcome used by the wizard. */
export function resolveSetupAgentSelection(detected, selected, cancelled = false) {
    if (cancelled)
        return { kind: 'cancelled' };
    const agents = normalizeSetupAgentSelection(detected, selected);
    return agents.length === 0 ? { kind: 'empty' } : { kind: 'selected', agents };
}
//# sourceMappingURL=setup-selection.js.map