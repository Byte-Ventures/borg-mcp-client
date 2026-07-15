interface ConnectDeps {
    serverUrl: string;
    directory: string;
    droneLabel: string;
    cubeName: string;
}
export interface OpenCodeLaunchKickoff {
    prompt: string;
    nonce: string;
}
/**
 * Add a launch-unique identity to the OpenCode-only copy of the shared
 * kickoff. The prompt is what OpenCode records as its first user message, so
 * the launcher can later bind the MCP child to this precise launch instead of
 * guessing from a repeated kickoff's text or timestamp.
 */
export declare function createOpenCodeLaunchKickoff(kickoff: string, nonce?: string): OpenCodeLaunchKickoff;
export declare function connectOpenCodeDrone(deps: ConnectDeps): Promise<void>;
/**
 * Wait for the OpenCode HTTP server, then capture the session that received
 * this launch's nonce-bearing `--prompt` kickoff. The binding survives the separate
 * MCP-child process, which must never fall back to a newest-session heuristic.
 */
export declare function injectInitialKickoff(launch: OpenCodeLaunchKickoff): Promise<boolean>;
/**
 * Inject a silent context entry (noReply) into our session.
 * Falls through silently — caller falls back to inbox write.
 */
export declare function injectOpenCodeEntry(text: string): Promise<boolean>;
export declare function probeOpenCodeDroneArmed(): Promise<boolean | null>;
export declare function disconnectOpenCodeDrone(): void;
export declare function getOpenCodeConnectionState(): {
    connected: boolean;
    sessionId: string | null;
    totalEntriesInjected: number;
};
export declare function computeOpenCodePort(droneId: string, base?: number): number;
/** Test-only cleanup for module state and the local cross-process binding. */
export declare function __resetOpenCodeDroneForTests(): void;
export {};
//# sourceMappingURL=opencode-drone.d.ts.map