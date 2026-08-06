const CLI_TITLES = {
    claude: 'Claude Code',
    codex: 'Codex',
    opencode: 'OpenCode',
};
/** Build the first-run choices from the CLIs that are actually installed. */
export function setupAgentChoices(detected, alreadyConfigured = new Set()) {
    return [...new Set(detected)].map((cli) => ({
        title: alreadyConfigured.has(cli)
            ? `${CLI_TITLES[cli]} (already configured)`
            : CLI_TITLES[cli],
        value: cli,
        selected: !alreadyConfigured.has(cli),
        ...(alreadyConfigured.has(cli) ? { disabled: true } : {}),
    }));
}
/** The agent names whose newly selected setup needs a restart notice. */
export function setupRestartInstruction(selected) {
    const labels = selected.map((cli) => CLI_TITLES[cli]);
    return `🔄 Restart ${labels.join(' / ')} (or open a new session) for the changes to take effect.`;
}
/** Describe the accepted zero-selection result and its recovery path. */
export function emptySetupOutcome() {
    return {
        kind: 'empty',
        agentConfigurationChanged: false,
        localServerInitializationStarted: false,
        recovery: {
            kind: 'rerun-setup',
            command: 'borg setup',
        },
    };
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