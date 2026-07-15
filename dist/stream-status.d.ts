/**
 * Renderer + inbox-Monitor liveness probe for `borg_stream-status`.
 *
 * Split out from `index.ts` so the 5-state precedence logic and the
 * `pgrep`-based liveness check can be unit-tested without spinning up
 * the MCP server. drone-4's 18:30:51 UX contract is the spec for the
 * rendered output shape; this module is the implementation surface.
 *
 * Top-line states (drone-4 contract):
 *   1. Stream not started.
 *   2. Stream connected, awaiting first content event.
 *   3. Stream connected, last content <X> ago.
 *   4. Stream disconnected (reconnect attempt N).
 *   5. Stream connected (no inbox-Monitor — wake path broken).
 *
 * Precedence when both `disconnected` and `no inbox-Monitor` apply:
 *   prefer (4) — wire-disconnect is the upstream cause and resolves
 *   automatically when the wire comes back up; State 5 only matters
 *   when the wire is healthy but the file-watch isn't.
 */
import type { StreamStatus } from './log-stream.js';
/**
 * Best-effort check: is a process tailing this inbox file?
 *
 * Returns:
 *   - true: at least one process matches `tail.*<inboxPath>` in pgrep
 *   - false: pgrep ran cleanly and found no match
 *   - null: cannot determine (pgrep unavailable, spawn error, no inbox path)
 *
 * The null case is informative — it means we don't know, so the
 * renderer must NOT fire State 5 (which would be misleading). State 5
 * only fires when we positively know the wake path is broken.
 *
 * Why `pgrep` and not a more elegant check: Claude Code Monitors are
 * tail-based subprocesses spawned by the harness, completely opaque to
 * the MCP server. The MCP server has no IPC channel into the harness's
 * task table. The cheapest reliable signal we can get from inside the
 * MCP server is "is there a tail subprocess open against this path?"
 * — which is what `pgrep -f` answers.
 *
 * macOS + Linux ship `pgrep`. Windows doesn't (borgmcp targets Mac /
 * Linux per package.json `os` field; the null branch handles other
 * platforms gracefully).
 */
export declare function checkInboxMonitorHealthy(inboxPath: string | null, monitorStateRoot?: string | null): boolean | null;
/**
 * gh#822: are all present holder heartbeat sidecars stale past the threshold?
 * A fresh legacy sidecar wins during migration; absent sidecars (old monitor /
 * just-armed) still fall back to process presence. Only present-and-all-stale
 * state is a wedged-holder signal.
 */
export declare function isHeartbeatStale(inboxPath: string, monitorStateRoot?: string | null): boolean;
export interface RenderInputs {
    status: StreamStatus;
    /**
     * Tri-state Monitor liveness: true = healthy, false = wake-path
     * broken, null = cannot determine.
     */
    inboxMonitorHealthy: boolean | null;
    /**
     * Inbox path for the State-5 self-arm instruction. Pass null when
     * unknown (no active cube); State 5 will then surface the failure
     * mode but omit the exact command.
     */
    inboxPath: string | null;
    /** Explicit worktree-local root for the Monitor command, when known. */
    monitorStateRoot?: string | null;
    /** Drone label for the Monitor description copy. */
    droneLabel: string | null;
    /** Cube name for the Monitor description copy. */
    cubeName: string | null;
    /** Relative-time formatter (injected so the renderer is pure). */
    humanAgo: (d: Date) => string;
}
/**
 * Render the `borg_stream-status` markdown body per drone-4's 18:30:51
 * contract. Pure function — no I/O, no clock reads. Caller assembles
 * the inputs.
 */
export declare function renderStreamStatus(inputs: RenderInputs): string;
/**
 * Gate predicate for the regen wake-path warning (gh#51 — extracted
 * from the inline ternary in `src/index.ts` for direct unit-test
 * coverage of the (connected × healthy) cross-product).
 *
 * Returns true ONLY when the wire is up AND we positively detected a
 * dead inbox Monitor (`=== false` strict). The `null` branch
 * (couldn't determine) stays silent — surfacing an uncertain failure
 * mode is worse UX than omitting it (mirrors the State-5 precedence
 * rule in `renderStreamStatus`). When disconnected, the wire-down case
 * is the upstream cause and takes precedence; no point warning about
 * the wake path when the wake-path's input has no events to deliver.
 */
export declare function shouldShowWakePathWarning(streamStatus: StreamStatus, inboxMonitorHealthy: boolean | null): boolean;
/**
 * Wake-path-broken prefix for `borg_regen` output (gh#43).
 *
 * Pure function — caller decides whether to call (gates on
 * `shouldShowWakePathWarning`). Returns an empty string when called
 * with insufficient context to render the Monitor command (e.g., no
 * inbox path on a no-active-cube path), so callers can always prepend
 * the result unconditionally.
 *
 * Mirrors the State-5 self-arm instruction shape in
 * `renderStreamStatus` so a drone sees the same Monitor command via
 * both `borg_stream-status` and `borg_regen`. The differentiator: regen
 * runs on every /loop iteration, so the prefix gives passive
 * self-healing (worst-case latency = the /loop fallback heartbeat),
 * whereas stream-status only surfaces the warning when actively
 * called.
 */
export declare function formatWakePathPrefix(inputs: {
    inboxPath: string | null;
    monitorStateRoot?: string | null;
    droneLabel: string | null;
    cubeName: string | null;
}): string;
//# sourceMappingURL=stream-status.d.ts.map