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
 */

export const DRONE_EVICTED_CODE = 'DRONE_EVICTED';

export class DroneEvictedError extends Error {
  constructor(
    message = 'This drone has been evicted from the cube. Re-assimilate to rejoin.'
  ) {
    super(message);
    this.name = 'DroneEvictedError';
  }
}

/**
 * Marker the agent's /loop + role playbook branch on. Single-sourced so the
 * SSE wake sentinel (log-stream) and the tool-result funnel (index) agree.
 */
export const EVICTED_RESULT_MARKER = '[CUBE-EVICTED]';

/**
 * The recognizable tool RESULT the agent sees when an authed call returns the
 * AUTHORITATIVE 410 DRONE_EVICTED. Spells out the sanctioned graceful-shutdown
 * sequence so the agent acts on it deterministically.
 */
export function formatEvictedToolResult(detail?: string): string {
  return (
    `${EVICTED_RESULT_MARKER} ${detail ?? 'This drone has been evicted from the cube.'}\n\n` +
    `This is the AUTHORITATIVE terminal signal (server 410 DRONE_EVICTED). Shut down gracefully:\n` +
    `1. Print a clear final message ("evicted from cube — shutting down").\n` +
    `2. TaskStop the inbox Monitor — the SANCTIONED exception to "never TaskStop the Monitor"; eviction is the terminal case.\n` +
    `3. Do NOT reschedule /loop (let the loop end). Do NOT re-assimilate in-session — the seat is gone.`
  );
}

/**
 * Extract the structured error code from a worker error body. The worker error
 * funnel (sanitizeError → createHttpError) emits `{ code, message }`; some
 * legacy/nested shapes use `{ error: { code } }`. Returns null when absent or
 * unparseable — callers must NOT treat a bare status (410) as authoritative
 * without the matching code (SEC R2/R4: spoof + ambiguity resistance).
 */
export function errorCodeFromBody(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as any;
    if (typeof parsed?.code === 'string') return parsed.code;
    if (typeof parsed?.error?.code === 'string') return parsed.error.code;
  } catch {
    // not JSON
  }
  return null;
}
