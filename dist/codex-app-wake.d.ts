import { getActiveCube, getCodexWakeTarget, setCodexWakeTarget, type ActiveCube } from './cubes.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { checkCodexBridgeHealthy } from './codex-remote.js';
export declare const CODEX_WAKE_PROMPT = "New Borg cube-log activity arrived.";
export declare function formatCodexWakePrompt(inboxLine: string): string;
export declare const CODEX_CATCHUP_PROMPT = "Borg cube activity arrived while you were busy. Wake triage: run `borg_read-log unread_only=true` and DRAIN \u2014 repeat until the returned page is under the limit and behind_by is 0 \u2014 so no entries are skipped. Then handle actionable entries; if none, resume the prior interrupted work.";
export declare function isCodexRemoteWakeEnabled(env?: NodeJS.ProcessEnv): boolean;
export { resolveSessionAgentKind } from './agent-runtime.js';
export interface CodexWakeTarget {
    enabled: boolean;
}
export declare function resolveCodexWakeTarget(env?: NodeJS.ProcessEnv): CodexWakeTarget;
/**
 * gh#633: resolve a codex drone's transport-agnostic "wake-path-armed" signal
 * from its OWN runtime wake mechanism — the app-server bridge's process
 * liveness, the codex analogue of the claude tail-F Monitor health. Fed into
 * the health beat so the HOP-2 wake-path-deaf classifier reads a
 * transport-agnostic armed signal instead of the claude-shaped monitor_armed
 * (which is false-by-design for codex and falsely flagged them, gh#633).
 *
 * Tri-state (boolean|null; caller maps null→armed for false-deaf-avoidance):
 *   - false ONLY on a positively-dead bridge: no wake target registered (the
 *     bridge cannot deliver wakes), OR the app-server pid is dead.
 *   - true when the wake target resolves AND the app-server pid is alive.
 *   - null when the bridge health is indeterminate (target read or pid check
 *     could not resolve) → armed (don't false-flag on uncertainty).
 */
export declare function probeCodexBridgeArmed(active: {
    cubeId: string;
    droneId: string;
}, deps?: {
    getCodexWakeTarget?: typeof getCodexWakeTarget;
    checkBridge?: typeof checkCodexBridgeHealthy;
}): Promise<boolean | null>;
/** gh#857 WI-2: last successful wake delivery time (for the heartbeat gate). */
export declare function getLastDeliveredAt(): number | null;
export interface CodexWakeDeps {
    getActiveCube?: typeof getActiveCube;
    getCodexWakeTarget?: typeof getCodexWakeTarget;
    setCodexWakeTarget?: typeof setCodexWakeTarget;
    createClient?: (socketPath: string) => Pick<CodexAppServerClient, 'connect' | 'readThread' | 'startTurn' | 'loadedThreadIds' | 'close'>;
    env?: NodeJS.ProcessEnv;
    cwd?: () => string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    jitter?: () => number;
    maxAttempts?: number;
    hasPendingWork?: (active: ActiveCube) => Promise<boolean>;
    isStreamOwner?: () => boolean;
    onAppServerSocketDead?: () => void;
}
export declare function wakeCodexViaAppServer(reason?: string, env?: NodeJS.ProcessEnv, deps?: CodexWakeDeps): void;
/**
 * gh#857 WI-2: codex /loop-equivalent heartbeat cadence. Codex retains this
 * independent 20-minute drain because it has no Claude-style per-entry inbox
 * Monitor. Claude recovery is adaptive: 3h ±30m while the Monitor is healthy
 * or indeterminate, and 15m ±3m only while it is explicitly broken.
 */
export declare const CODEX_HEARTBEAT_CADENCE_MS: number;
/**
 * gh#857/client#76: one tick of the codex catch-up backstop. The cadence only
 * initiates a token-free unread-state preflight; a DRAIN turn is injected when
 * that authoritative scan finds real work that a per-entry wake missed. Recent
 * delivery still suppresses redundant preflights. Unlike the per-entry path it
 * does not consult deliveredWakeKeys because the unread cursor is authoritative.
 * Best-effort: a failed preflight, mid-turn thread, transient error, or unresolved
 * target skips this tick and lets the next cadence retry. Never throws.
 */
export declare function fireCodexHeartbeatTick(deps?: CodexWakeDeps, cadenceMs?: number): Promise<void>;
/**
 * gh#857 WI-2: start the codex /loop-equivalent heartbeat — a setInterval firing
 * fireCodexHeartbeatTick every cadence. CODEX-ONLY: claude wakes via the tail-F
 * inbox Monitor + /loop ScheduleWakeup and has NO app-server socket to inject
 * into, so the heartbeat is intrinsically a codex mechanism. The gate reads
 * agentKind and remote-wake capability LOCALLY from this child's own env,
 * never a mutable/server-recorded field, so a mislabel can't silently defeat
 * the backstop (gh#633 lesson). Agent CLI identity and remote transport are
 * separate: a Codex CLI without a live remote transport has no app-server
 * heartbeat to run. The timer is unref'd so it never keeps the process alive.
 * Returns the timer, or null when this is not a remotely-wakeable Codex
 * session. Injectable for tests.
 */
export declare function startCodexHeartbeat(opts?: {
    agentKind?: 'claude' | 'codex' | 'opencode';
    remoteWakeEnabled?: boolean;
    intervalMs?: number;
    tick?: () => void;
}): ReturnType<typeof setInterval> | null;
export declare function resetCodexWakeForTests(): void;
//# sourceMappingURL=codex-app-wake.d.ts.map