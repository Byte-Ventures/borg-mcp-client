interface ConnectDeps {
    serverUrl: string;
    directory: string;
    droneLabel: string;
    cubeName: string;
}
export type OpenCodeDeliveryState = 'queued' | 'delivered-unconfirmed' | 'retried' | 'failed';
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
 * Queue one durable inbox entry for delivery into the bound OpenCode session.
 * The SSE entry ID becomes a stable OpenCode message ID, so retries and replay
 * can confirm an earlier ambiguous submission without running it twice.
 */
export declare function injectOpenCodeEntry(text: string, entryId?: string, allowSubmit?: boolean): Promise<boolean>;
export declare function probeOpenCodeDroneArmed(): Promise<boolean | null>;
export declare function disconnectOpenCodeDrone(): void;
export interface OpenCodeConnectionState {
    connected: boolean;
    sessionId: string | null;
    totalEntriesInjected: number;
    totalEntriesRetried: number;
    deliveryStates: Record<OpenCodeDeliveryState, number>;
}
export declare function getOpenCodeConnectionState(): OpenCodeConnectionState;
export declare function computeOpenCodePort(droneId: string, base?: number): number;
/** Test-only cleanup for module state and the local cross-process binding. */
export declare function __resetOpenCodeDroneForTests(): void;
export {};
//# sourceMappingURL=opencode-drone.d.ts.map