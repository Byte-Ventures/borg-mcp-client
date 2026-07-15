/**
 * gh#855 — pure helpers for FRESH codex wake-target re-resolution.
 *
 * Root cause of codex deaf-when-idle: the wake target (socket + thread) was
 * resolved once at launch and never refreshed, so a missed/stale launch probe
 * left the drone permanently deaf. Phase 1 makes the waking borg-mcp child
 * authoritative about its OWN live app-server socket — the socket is injected
 * into the child's pinned env at spawn (codex-remote.ts, via the #851 `-c
 * mcp_servers.borg.env.X` channel) — and re-resolves the loaded thread FRESH on
 * every wake (loadedThreadIds is a re-runnable RPC).
 *
 * These are the pure pieces; the IO orchestration lives in codex-app-wake.ts.
 */

/** Pinned-env var carrying THIS drone's live app-server socket (set at spawn). */
export const BORG_CODEX_APP_SERVER_SOCKET_ENV = 'BORG_CODEX_APP_SERVER_SOCKET';

/** The live app-server socket for this borg-mcp child, or null (un-upgraded launch). */
export function codexAppServerSocketFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[BORG_CODEX_APP_SERVER_SOCKET_ENV];
  return v && v.length > 0 ? v : null;
}

/**
 * The per-launch codex config override that pins THIS app-server's live socket
 * into the borg-mcp child's [mcp_servers.borg.env] — the same `-c` channel the
 * #851 BORG_SESSION marker rides (codex MCP children read only the pinned env,
 * never inherited env). The socketPath is borg-generated (randomBytes under
 * ~/.config/borgmcp/codex-remote), never user input; TOML-quoted exactly like
 * the BORG_SESSION override, so there is zero injection surface.
 */
export function codexAppServerSocketConfigArgs(socketPath: string): string[] {
  return ['-c', `mcp_servers.borg.env.${BORG_CODEX_APP_SERVER_SOCKET_ENV}="${socketPath}"`];
}

export interface CodexThreadInfo {
  id: string;
  cwd?: string;
  updatedAt?: number;
}

/**
 * Pick the loaded thread to wake on the live socket. Each borg-owned app-server
 * is fresh-per-launch / single-session, so the common case is exactly one loaded
 * thread. When more than one is loaded, prefer the thread whose cwd matches this
 * drone's working directory (sibling worktrees have distinct cwds), then the
 * newest by updatedAt — always deterministic. No loaded thread → null (no wake
 * this cycle; the next wake retries, so a transient empty list never causes
 * permanent deafness).
 */
export function pickFreshThread(threads: CodexThreadInfo[], opts: { cwd: string }): string | null {
  if (threads.length === 0) return null;
  if (threads.length === 1) return threads[0].id;
  const cwdMatches = threads.filter((t) => t.cwd === opts.cwd);
  const pool = cwdMatches.length > 0 ? cwdMatches : threads;
  let best = pool[0];
  for (const t of pool) {
    if ((t.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = t;
  }
  return best.id;
}

/**
 * Pure prune: drop wake-target entries whose app-server socket is positively
 * dead (liveness === false), so the file self-heals. Keeps alive (true) and
 * indeterminate (null) entries — false-deaf-avoidance, mirroring
 * checkCodexBridgeHealthy's tri-state. Returns the surviving map + whether
 * anything changed (so the caller writes only on change).
 */
export function pruneDeadWakeTargets<T extends { socketPath: string }>(
  targets: Record<string, T>,
  socketLiveness: (socketPath: string) => boolean | null
): { targets: Record<string, T>; changed: boolean } {
  const out: Record<string, T> = {};
  let changed = false;
  for (const [key, t] of Object.entries(targets)) {
    if (socketLiveness(t.socketPath) === false) {
      changed = true;
      continue;
    }
    out[key] = t;
  }
  return { targets: out, changed };
}

/**
 * Whether the freshly-resolved target differs from what's already recorded —
 * so the self-healing cache write happens only on change (no file thrash on a
 * busy cube re-resolving the same socket+thread every wake).
 */
export function wakeTargetChanged(
  existing: { socketPath: string; threadId: string } | null,
  fresh: { socketPath: string; threadId: string }
): boolean {
  return (
    !existing || existing.socketPath !== fresh.socketPath || existing.threadId !== fresh.threadId
  );
}

// ─── gh#857 Phase 2: durable retry + heartbeat (pure helpers) ───────────────

/** Base backoff for the first retry of a dropped/deferred wake. */
export const WAKE_RETRY_BASE_MS = 5_000;
/** Backoff ceiling — a wedged thread is retried at most this often. */
export const WAKE_RETRY_CAP_MS = 60_000;
/**
 * Age cap: a pending wake older than this is given up (dropped from the queue).
 * Generous on purpose — the WI-2 heartbeat is the backstop beyond it, and the
 * server read-cursor means the next delivery (heartbeat or a fresh entry) drains
 * everything anyway, so an aged-out single wake is never a permanent miss.
 */
export const WAKE_RETRY_MAX_AGE_MS = 45 * 60_000;
/**
 * Hard iteration ceiling for the retry-drain loop — a defensive belt ALONGSIDE
 * the time-based age cap. In prod the age cap (real clock) terminates the loop in
 * ~45-50 attempts; this ceiling only matters if the clock fails to advance
 * (pathological / a non-advancing injected clock in tests) where a time-only
 * guard would hot-spin forever. Set far above any real attempt count.
 */
export const WAKE_RETRY_MAX_ATTEMPTS = 1000;

/**
 * Exponential backoff (ms) for the Nth retry of a pending wake (0-based),
 * doubling from WAKE_RETRY_BASE_MS, saturating at WAKE_RETRY_CAP_MS, plus
 * caller-supplied jitter so co-located sibling drones don't retry in lockstep.
 */
export function wakeRetryBackoffMs(attempts: number, jitter = 0): number {
  const n = Math.max(0, attempts);
  const exp = WAKE_RETRY_BASE_MS * 2 ** n;
  return Math.min(exp, WAKE_RETRY_CAP_MS) + jitter;
}

/** True once a pending wake has outlived the age cap (give up; heartbeat backstops). */
export function wakeRetryExpired(
  firstEnqueuedAt: number,
  now: number,
  maxAgeMs = WAKE_RETRY_MAX_AGE_MS
): boolean {
  return now - firstEnqueuedAt >= maxAgeMs;
}

/**
 * WI-2 double-fire avoidance: the periodic heartbeat fires only when no wake (or
 * prior heartbeat) delivery landed within the cadence window — so an active cube
 * with flowing per-entry wakes doesn't get redundant heartbeat injections. A
 * never-delivered seat (null) always fires.
 */
export function shouldFireHeartbeat(
  lastDeliveredAt: number | null,
  now: number,
  cadenceMs: number
): boolean {
  if (lastDeliveredAt === null) return true;
  return now - lastDeliveredAt >= cadenceMs;
}
