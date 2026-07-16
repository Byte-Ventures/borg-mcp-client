/**
 * gh#528 — npm-managed Codex remote-wake.
 *
 * borg owns a per-launch DIRECT Codex app-server (`codex app-server --listen
 * unix://<socket>`) as the primary wake path, instead of the standalone
 * `codex app-server daemon start` (which only exists for standalone-installer
 * Codex — npm-managed Codex has no daemon, so those sessions had no push-wake
 * and relied on periodic log-drain catch-up). Per-launch direct
 * app-server works for both install kinds and starts fresh each launch (so it
 * always loads the current borgmcp MCP — no daemon-restart version refresh
 * needed). The TUI is then launched with `codex --remote unix://<socket>` and
 * Borg delivers wakes by connecting to that socket (see codex-app-wake.ts).
 */
export interface CodexAppServerHandle {
    pid: number | undefined;
    socketPath: string;
    /** Kill the owned app-server + remove its socket/pidfile. Wire to TUI exit. */
    cleanup: () => void;
}
export interface CodexRemoteLaunch {
    args: string[];
    env: Record<string, string>;
    warning?: string;
    /** Present when borg owns a per-launch app-server that must be cleaned up on TUI exit. */
    server?: CodexAppServerHandle;
}
export interface CodexChild {
    pid: number | undefined;
    kill: () => void;
    /** Snapshot app-server exit state + bounded stderr captured by the production spawn. */
    diagnostics?: () => CodexChildDiagnostics;
}
export interface CodexChildDiagnostics {
    exited: boolean;
    exitCode: number | null;
    signal: string | null;
    error?: string | null;
    stderr: string;
}
export interface PrepareCodexRemoteDeps {
    /** Spawn the long-lived `codex app-server --listen unix://<socketPath>` child. */
    spawnAppServer: (socketPath: string) => CodexChild;
    /** Readiness probe: a real CodexAppServerClient connect + thread/loaded/list round-trip. */
    probeReady: (socketPath: string) => Promise<boolean>;
    /** Delay between readiness polls (injected so tests don't actually wait). */
    sleep: (ms: number) => Promise<void>;
    /** 0700 runtime dir (default ~/.config/borgmcp/codex-remote). */
    runtimeDir?: string;
    /** Unique socket id generator (default 32-hex). Injected for deterministic tests. */
    socketId?: () => string;
    /** Readiness timeout (default 30000ms) + poll interval (default 250ms). */
    readyTimeoutMs?: number;
    pollIntervalMs?: number;
    /** Whether a pid is alive (default process.kill(pid, 0)). Injected for tests. */
    isAlive?: (pid: number) => boolean;
}
export declare const DEFAULT_CODEX_REMOTE_DIR: string;
export declare function withCodexCwdArg(args: string[], cwd: string): string[];
/** Resolve the project directory Codex itself will use for this launch.
 * Relative explicit paths are interpreted from the wrapper's current working
 * directory, matching Codex's CLI path resolution. The final occurrence wins,
 * matching clap's override behavior for repeated options. */
export declare function resolveCodexLaunchCwd(args: string[], fallbackCwd: string): string;
export declare function defaultIsAlive(pid: number): boolean;
/**
 * gh#633: process-liveness probe for the borg-owned codex app-server — the
 * transport-agnostic analogue of the claude tail-F Monitor's pgrep check
 * (checkInboxMonitorHealthy / stream-status.ts:48). Codex drones wake via this
 * app-server bridge, NOT a tail-F Monitor, so wake_path_client_monitor_armed is
 * false-by-design for them; the HOP-2 wake-path-deaf classifier mis-read that
 * as deaf (gh#633). This gives HOP-2 the codex wake path's ACTUAL health.
 *
 * Uses the app-server PIDFILE (written at spawn, beside the socket) +
 * process.kill(pid, 0) — NOT pgrep. The codex TUI is also launched
 * `codex --remote unix://<socketPath>`, so a `pgrep -f <socketPath>` would ALSO
 * match the live TUI and FALSE-ARM when the app-server has crashed but the TUI
 * still runs (the deaf-but-alive case). The pidfile holds the EXACT app-server
 * pid, so kill(0) reflects the app-server's liveness specifically — and it's
 * cheaper than pgrep (no subprocess). Mirrors pruneStaleSockets' pid check.
 *
 * Tri-state (mirrors checkInboxMonitorHealthy's boolean|null contract):
 *   - true:  pidfile resolves to a LIVE pid → app-server (bridge) is up → armed.
 *   - false: pidfile resolves to a DEAD pid → an unclean exit (crash/kill -9)
 *            left a stale pidfile (cleanup never ran) → bridge down → HOP-2
 *            correctly flags a genuinely-deaf codex drone (no SLI-lie).
 *   - null:  pidfile missing / unreadable / unparseable → cannot determine →
 *            caller maps null→armed (false-deaf-avoidance, same as the claude
 *            monitor branch). A CLEAN app-server exit removes the pidfile, but
 *            then the drone is shutting down → the silent-stall watchdog
 *            backstops it via a separate layer.
 *
 * Residual (negligible, gh#633 / Coordinator 6f28fe3f): PID reuse — if the
 * crashed app-server's pid is recycled by an unrelated process before the next
 * launch's pruneStaleSockets removes the stale pidfile, kill(0) reports alive →
 * a brief false-arm. The window is tiny (exact-pid reuse during the crash gap)
 * and self-heals on the next launch's prune; far smaller than existsSync's
 * always-on stale-file masking.
 */
export declare function checkCodexBridgeHealthy(socketPath: string | null, deps?: {
    isAlive?: (pid: number) => boolean;
    readPidFile?: (pidPath: string) => string;
}): boolean | null;
/**
 * Start a borg-owned per-launch Codex app-server, probe it for readiness, and
 * return the `--remote` launch args + an owned handle (or a fail-loud warning).
 * Async + lifecycle-owning: the caller MUST call `result.server?.cleanup()` on
 * TUI exit.
 */
export declare function prepareCodexRemoteLaunch(deps: PrepareCodexRemoteDeps): Promise<CodexRemoteLaunch>;
/**
 * Production deps for prepareCodexRemoteLaunch — spawn the real `codex
 * app-server` child + probe it with the real CodexAppServerClient. Shared by
 * claude.ts and assimilate-deps.ts so there's ONE wiring.
 *
 * The readiness probe uses Codex app-server RPCs ONLY (connect + thread/loaded/
 * list) — it never calls a borg /api/drone/* endpoint — so it can never advance
 * last_seen/last_regen_at and mask a deaf Codex (the gh#46/gh#406 signal-truth
 * invariant; the app-server socket is the wake-DELIVERY wire, not a liveness
 * signal).
 */
export declare function defaultCodexRemoteDeps(): Pick<PrepareCodexRemoteDeps, 'spawnAppServer' | 'probeReady' | 'sleep'>;
//# sourceMappingURL=codex-remote.d.ts.map