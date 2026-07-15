/**
 * gh#877: drone-lifecycle signals shared across the client wire layers
 * (log-stream SSE + remote-client authedFetch + index tool funnel).
 *
 * Two distinct, NON-conflated outcomes when a drone's session stops resolving:
 *
 *  - DroneEvictedError (server 410 / code DRONE_EVICTED) — TERMINAL. The seat is
 *    gone. The agent shuts down gracefully (print terminal message, TaskStop the
 *    inbox Monitor, do NOT reschedule /loop). This is the SOLE authoritative
 *    teardown trigger (SEC R2): an SSE eviction frame or inbox sentinel is only
 *    a WAKE HINT — the agent confirms via an authed call returning this code.
 *
 *  - DroneFrozenError (server 423 / code DRONE_FROZEN) — REVERSIBLE. The seat
 *    (or its cube) is frozen by a subscription downgrade; it resumes when
 *    billing is restored. The agent must NOT shut down — it keeps looping. We
 *    surface a distinct, friendly message so a frozen seat is never
 *    indistinguishable-to-the-human from an eviction or an outage.
 */
export declare const DRONE_EVICTED_CODE = "DRONE_EVICTED";
export declare const DRONE_FROZEN_CODE = "DRONE_FROZEN";
export declare class DroneEvictedError extends Error {
    constructor(message?: string);
}
export declare class DroneFrozenError extends Error {
    constructor(message?: string);
}
/**
 * Markers the agent's /loop + role playbook branch on. Single-sourced so the
 * SSE wake sentinel (log-stream) and the tool-result funnel (index) agree.
 */
export declare const EVICTED_RESULT_MARKER = "[CUBE-EVICTED]";
export declare const FROZEN_RESULT_MARKER = "[CUBE-FROZEN]";
/**
 * The recognizable tool RESULT the agent sees when an authed call returns the
 * AUTHORITATIVE 410 DRONE_EVICTED. Spells out the sanctioned graceful-shutdown
 * sequence so the agent acts on it deterministically.
 */
export declare function formatEvictedToolResult(detail?: string): string;
/**
 * The recognizable tool RESULT for a REVERSIBLE 423 DRONE_FROZEN. The agent
 * must NOT shut down — the seat resumes when billing is restored.
 */
export declare function formatFrozenToolResult(detail?: string): string;
/**
 * Extract the structured error code from a worker error body. The worker error
 * funnel (sanitizeError → createHttpError) emits `{ code, message }`; some
 * legacy/nested shapes use `{ error: { code } }`. Returns null when absent or
 * unparseable — callers must NOT treat a bare status (410/423) as authoritative
 * without the matching code (SEC R2/R4: spoof + ambiguity resistance).
 */
export declare function errorCodeFromBody(body: string): string | null;
//# sourceMappingURL=drone-lifecycle.d.ts.map