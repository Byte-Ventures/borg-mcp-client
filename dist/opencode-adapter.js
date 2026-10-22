import { buildOpenCodeLaunchArgs } from './cli-tool-approval.js';
/** Host contracts stay separate; V1 does not acquire V2 imports or semantics. */
export function selectOpenCodeAdapter(installation) {
    if (installation.major === 1) {
        return {
            generation: 1,
            installation,
            pluginEntrypoint: 'function',
            serverOwnership: 'tui',
            buildTuiArgs: ({ directory, port, prompt, passthroughArgs = [] }) => buildOpenCodeLaunchArgs(directory, port, prompt, passthroughArgs),
        };
    }
    if (installation.major !== 2)
        throw new Error('Unsupported OpenCode adapter generation.');
    return {
        generation: 2,
        installation,
        pluginEntrypoint: 'setup',
        serverOwnership: 'private-lease',
        buildTuiArgs: ({ directory, port, sessionId, passthroughArgs = [] }) => {
            if (!Number.isInteger(port) || port <= 0 || port > 65_535 || !sessionId) {
                throw new Error('OpenCode 2 needs an authenticated private server and a bound session before opening the TUI.');
            }
            // Borg owns endpoint selection and kickoff admission. A passthrough
            // option must not reconnect the TUI to another server or session.
            const reserved = /^(?:--(?:server|standalone|port|hostname|session|continue|fork|prompt|directory)(?:=|$)|-[scp])/;
            if (passthroughArgs.some((arg) => arg === '--' || reserved.test(arg))) {
                throw new Error('OpenCode 2 launch options conflict with Borg server or session ownership.');
            }
            return [directory, '--server', `http://127.0.0.1:${port}`, '--session', sessionId, ...passthroughArgs];
        },
    };
}
//# sourceMappingURL=opencode-adapter.js.map