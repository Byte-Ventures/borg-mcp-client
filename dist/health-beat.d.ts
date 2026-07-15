/**
 * gh#541 WU-2 — client health beat (the Part B "receipt watermark" producer).
 *
 * The MCP-client child process emits a periodic + event-driven health BEAT to
 * the server's `POST /api/drone/health` (WU-1). The beat reports:
 *   - `last_event_at`        — when this client last RECEIVED an inbound cube
 *                              event (the wake-path RECEIPT evidence). This is
 *                              produced BELOW the agent classifier (WU-0 proved
 *                              child-process HTTP is independent of the agent
 *                              tool-call path), so it stays fresh even during a
 *                              classifier outage and even when the agent /loop
 *                              never wakes — which is exactly what lets the
 *                              watchdog (WU-3) tell DEAF (Monitor down) apart
 *                              from POST-BLOCKED.
 *   - `sse_connected`        — the SSE wire state.
 *   - `inbox_monitor_armed`  — whether a tail-Monitor is watching the inbox.
 *
 * The beat carries NO token material in the body (auth is the X-Drone-Session
 * header, same as every other drone endpoint). It is strictly BEST-EFFORT: a
 * failed POST is swallowed and must never crash the SSE stream.
 *
 * Side-effecting deps (fetch, token, cube/status/monitor probes, clock) are
 * injected so the producer is unit-tested without real network/keychain/pgrep.
 */
/** The cube context needed to address + auth a beat (subset of ActiveCube). */
export interface HealthBeatActive {
    cubeId: string;
    droneId: string;
    sessionToken: string;
    apiUrl: string;
    serverTrustIdentity?: string;
}
export interface HealthPayload {
    sse_connected: boolean;
    inbox_monitor_armed: boolean;
    /**
     * gh#633: transport-AGNOSTIC wake-path-armed signal. The client computes it
     * from its OWN runtime wake mechanism — claude=tail-F inbox Monitor health,
     * codex=app-server bridge liveness — so the HOP-2 wake-path-deaf classifier
     * reads one boolean without branching on (mis-recordable) agent_kind. For a
     * claude drone this equals inbox_monitor_armed; for codex it reflects the
     * bridge (which has no tail-F Monitor by design).
     */
    wake_armed: boolean;
    /**
     * gh#634: the drone's agent_kind from LIVE runtime detection
     * (resolveSessionAgentKind). Assimilation captures agent_kind only at join,
     * so a relaunch of an existing seat needs this always-running child to
     * refresh the recorded value through recordDroneHealth's COALESCE update.
     */
    agent_kind: 'claude' | 'codex' | 'opencode';
    /**
     * gh#408: live runtime hostname. Assimilate captures hostname only at first
     * join; the beat carries the relaunched process's current machine name so
     * the server can self-heal the recorded display value.
     */
    hostname: string | null;
    /**
     * gh#646: installed borgmcp client version from getPackageVersion().
     * Stored separately from liveness so a relaunched/upgraded drone can refresh
     * its recorded version without re-assimilating.
     */
    version: string;
    last_event_at: string | null;
}
/** Record that an inbound cube event was just received (the receipt evidence). */
export declare function recordEventReceipt(now?: Date): void;
export declare function getLastEventReceivedAt(): Date | null;
export declare function getCachedMonitorHealthy(): boolean | null;
/** Cached transport-agnostic wake-armed (gh#633), for cheap per-event beats. */
export declare function getCachedWakeArmed(): boolean | null;
/**
 * Reset module state. TEST-ONLY — the beat state is a process singleton in
 * normal operation; nothing in production code should call this.
 * @internal
 */
export declare function __resetHealthBeatStateForTest(): void;
/**
 * Build the beat payload from the current receipt watermark + the supplied
 * wire/monitor state.
 *
 * `inbox_monitor_armed` maps the tri-state monitor probe to the boolean the
 * server schema requires: ONLY a POSITIVELY-broken probe (`false`) reports
 * `false`; both healthy (`true`) and unknown (`null`) report `true`. This
 * mirrors `shouldShowWakePathWarning` (which fires only on `=== false`) and is
 * the design's false-deaf-avoidance posture — an undeterminable probe must not
 * masquerade as a dead Monitor.
 */
export declare function buildHealthPayload(sseConnected: boolean, inboxMonitorHealthy: boolean | null, wakeArmed: boolean | null, agentKind: 'claude' | 'codex' | 'opencode', hostname: string | null, version: string): HealthPayload;
export interface BeatTransport {
    fetchImpl: typeof fetch;
    getToken: () => Promise<string>;
}
/**
 * Best-effort POST of a beat. Swallows ALL errors (token fetch, network,
 * non-2xx) — a beat that can't be delivered must never propagate into the
 * stream loop. Body carries NO token material; auth is via headers.
 */
export declare function postHealthBeat(active: HealthBeatActive, payload: HealthPayload, deps: BeatTransport): Promise<void>;
/** Build the current payload and post it (best-effort). */
export declare function emitHealthBeat(active: HealthBeatActive, opts: {
    sseConnected: boolean;
    inboxMonitorHealthy: boolean | null;
    wakeArmed: boolean | null;
    agentKind: 'claude' | 'codex' | 'opencode';
    hostname: string | null;
    version: string;
} & BeatTransport): Promise<void>;
export interface HealthBeatTickDeps extends BeatTransport {
    getActiveCube: () => Promise<HealthBeatActive | null>;
    getStreamConnected: () => boolean;
    getInboxPath: (active: HealthBeatActive) => string | null;
    checkMonitor: (inboxPath: string | null) => boolean | null;
    isCodexRemoteWake: () => boolean;
    probeBridgeArmed: (active: HealthBeatActive) => Promise<boolean | null>;
    probeOpenCodeDrone?: (active: HealthBeatActive) => Promise<boolean | null>;
    resolveAgentKind: () => 'claude' | 'codex' | 'opencode';
    resolveHostname: () => string | null;
    resolveVersion: () => string;
}
/**
 * One tick of the periodic beat: resolve the active cube, probe the live
 * wire + Monitor state, cache the monitor result (so cheap per-event beats can
 * reuse it without re-spawning pgrep), and emit the beat. No active cube → no
 * beat. Best-effort: never throws.
 */
export declare function runHealthBeatOnce(deps: HealthBeatTickDeps): Promise<void>;
/** Default periodic cadence for the health beat. */
export declare const HEALTH_BEAT_INTERVAL_MS = 60000;
/**
 * Start the periodic beat. Fire-and-forget; the timer is `unref`'d so it never
 * keeps the process alive on its own. Returns the timer handle (tests clear it).
 */
export declare function startHealthBeatTick(deps: HealthBeatTickDeps, intervalMs?: number): NodeJS.Timeout;
//# sourceMappingURL=health-beat.d.ts.map