import { type OpenCodeLaunchTrust } from './opencode-launch-trust.js';
export declare function openCodeStartupDiagnosticLogPath(): string;
export declare function writeOpenCodeStartupDiagnostic(message: string): void;
interface OpenCodeLastObservation {
    injectionSequence: number;
    acceptedSequence: number;
    failureSequence: number;
    lastInjectionAt: number | null;
    lastInjectionResult: OpenCodeInjectionResult | null;
    lastAcceptedEntryId: string | null;
    lastFailureCode: string | null;
}
interface ConnectDeps {
    serverUrl: string;
    apiPassword: string;
    directory: string;
    droneLabel: string;
    cubeName: string;
}
export type OpenCodeDeliveryState = 'queued' | 'delivered-unconfirmed' | 'retried' | 'failed';
type OpenCodeDeliveryOutcome = 'delivered' | 'delivered-unconfirmed' | 'failed';
type OpenCodeInjectionResult = OpenCodeDeliveryOutcome;
export interface OpenCodeLaunchKickoff {
    prompt: string;
    apiPassword: string;
    correlationIdentity: string;
}
/**
 * Create independent launch trust for OpenCode without changing the shared
 * kickoff text. The plugin writes the correlation identity to hidden metadata
 * on the first qualifying human TextPart; the API password stays in env.
 */
export declare function createOpenCodeLaunchKickoff(kickoff: string, trust?: Partial<OpenCodeLaunchTrust>): OpenCodeLaunchKickoff;
export declare function connectOpenCodeDrone(deps: ConnectDeps): Promise<void>;
/**
 * Wait for the OpenCode HTTP server, then capture the session that received
 * this launch's metadata-correlated `--prompt` kickoff. The binding survives
 * the separate MCP-child process, which must never fall back to a newest-session heuristic.
 */
export declare function injectInitialKickoff(launch: OpenCodeLaunchKickoff): Promise<boolean>;
/**
 * Queue one durable inbox entry for delivery into the bound OpenCode session.
 * The delivery identity is stored in TextPart metadata, so retries and replay
 * can confirm an earlier ambiguous submission without supplying an
 * ordering-breaking caller message ID or exposing the identity in delivered
 * text. Retry nonces also carry their durable source entry ID so they reconcile
 * one submission instead of creating a second prompt.
 */
export declare function injectOpenCodeEntry(text: string, entryId?: string, allowSubmit?: boolean, sourceEntryId?: string, isSourcePending?: () => Promise<boolean>): Promise<boolean>;
/** Stop retrying every delivery identity derived from a durable entry that the
 * agent has already consumed. Confirmed history stays available for dedup. */
export declare function settleOpenCodeEntry(sourceEntryId: string): void;
export declare function probeOpenCodeDroneArmed(): Promise<boolean | null>;
export declare function disconnectOpenCodeDrone(): void;
export interface OpenCodeConnectionState {
    connected: boolean;
    sessionId: string | null;
    totalEntriesInjected: number;
    totalEntriesRetried: number;
    lastInjectionAt: number | null;
    lastInjectionResult: OpenCodeInjectionResult | null;
    lastAcceptedEntryId: string | null;
    lastFailureCode: string | null;
    deliveryStates: Record<OpenCodeDeliveryState, number>;
}
export declare function getOpenCodeConnectionState(): OpenCodeConnectionState;
export declare function __getOpenCodeDiagnosticLogPathForTests(): string;
export declare function __getOpenCodeLastObservationForTests(): OpenCodeLastObservation;
export declare function __decodeOpenCodeSessionForTests(value: unknown): unknown;
export declare function __listOpenCodeSessionsForTests(): Promise<unknown[]>;
export declare function computeOpenCodePort(droneId: string, base?: number): number;
export declare function configuredOpenCodePort(env?: NodeJS.ProcessEnv): number | null;
export declare const OPEN_CODE_PORT_MISSING_DIAGNOSTIC = "OpenCode launch port is missing; skipping OpenCode entry injection. Relaunch through borg.";
export declare function openCodeLaunchBinding(port: number): {
    cliPort: string;
    envPort: string;
    serverUrl: string;
};
export declare function allocateOpenCodePort(isPortAvailable?: (port: number) => Promise<boolean>): Promise<number>;
/** Test-only cleanup for module state and the local cross-process binding. */
export declare function __resetOpenCodeDroneForTests(): void;
export {};
//# sourceMappingURL=opencode-drone.d.ts.map