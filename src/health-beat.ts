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

// ─── Module state (process-singleton, like the SSE stream state) ─────────

let lastEventReceivedAt: Date | null = null;
// Cached monitor-health, refreshed by the ~60s tick so per-event beats don't
// have to spawn pgrep on every inbound entry. `null` = unknown (treated as
// armed by the payload mapping below).
let cachedMonitorHealthy: boolean | null = null;
// gh#633: cached transport-agnostic wake-armed (claude monitor OR codex bridge
// liveness), refreshed by the ~60s tick so per-event beats reuse it without
// re-probing. `null` = unknown (treated as armed by the payload mapping below).
let cachedWakeArmed: boolean | null = null;

/** Record that an inbound cube event was just received (the receipt evidence). */
export function recordEventReceipt(now: Date = new Date()): void {
  lastEventReceivedAt = now;
}

export function getLastEventReceivedAt(): Date | null {
  return lastEventReceivedAt;
}

export function getCachedMonitorHealthy(): boolean | null {
  return cachedMonitorHealthy;
}

/** Cached transport-agnostic wake-armed (gh#633), for cheap per-event beats. */
export function getCachedWakeArmed(): boolean | null {
  return cachedWakeArmed;
}

/**
 * Reset module state. TEST-ONLY — the beat state is a process singleton in
 * normal operation; nothing in production code should call this.
 * @internal
 */
export function __resetHealthBeatStateForTest(): void {
  lastEventReceivedAt = null;
  cachedMonitorHealthy = null;
  cachedWakeArmed = null;
}

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
export function buildHealthPayload(
  sseConnected: boolean,
  inboxMonitorHealthy: boolean | null,
  wakeArmed: boolean | null,
  agentKind: 'claude' | 'codex' | 'opencode',
  hostname: string | null,
  version: string
): HealthPayload {
  return {
    sse_connected: sseConnected,
    inbox_monitor_armed: inboxMonitorHealthy !== false,
    // gh#633: same false-deaf-avoidance map as inbox_monitor_armed — only a
    // POSITIVELY-false probe reports false; healthy (true) and indeterminate
    // (null) both report armed. Prevents a transient/undeterminable wake-path
    // probe from masquerading as a dead wake path.
    wake_armed: wakeArmed !== false,
    // gh#634: live runtime agent_kind (caller passes resolveSessionAgentKind()).
    agent_kind: agentKind,
    hostname,
    version,
    last_event_at: lastEventReceivedAt ? lastEventReceivedAt.toISOString() : null,
  };
}

export interface BeatTransport {
  fetchImpl: typeof fetch;
  getToken: () => Promise<string>;
}

/**
 * Best-effort POST of a beat. Swallows ALL errors (token fetch, network,
 * non-2xx) — a beat that can't be delivered must never propagate into the
 * stream loop. Body carries NO token material; auth is via headers.
 */
export async function postHealthBeat(
  active: HealthBeatActive,
  payload: HealthPayload,
  deps: BeatTransport
): Promise<void> {
  // The local server protocol has no health-beat capability. Never aim the
  // hosted `/api/drone/health` shape at a selected local authority and never
  // fall back to the hosted API.
  if (active.serverTrustIdentity !== undefined) return;
  try {
    const token = await deps.getToken();
    await deps.fetchImpl(`${active.apiUrl}/api/drone/health`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Drone-Session': active.sessionToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort: never crash the stream on a beat failure.
  }
}

/** Build the current payload and post it (best-effort). */
export async function emitHealthBeat(
  active: HealthBeatActive,
  opts: {
    sseConnected: boolean;
    inboxMonitorHealthy: boolean | null;
    wakeArmed: boolean | null;
    agentKind: 'claude' | 'codex' | 'opencode';
    hostname: string | null;
    version: string;
  } & BeatTransport
): Promise<void> {
  const payload = buildHealthPayload(
    opts.sseConnected,
    opts.inboxMonitorHealthy,
    opts.wakeArmed,
    opts.agentKind,
    opts.hostname,
    opts.version
  );
  await postHealthBeat(active, payload, opts);
}

export interface HealthBeatTickDeps extends BeatTransport {
  getActiveCube: () => Promise<HealthBeatActive | null>;
  getStreamConnected: () => boolean;
  getInboxPath: (active: HealthBeatActive) => string | null;
  checkMonitor: (inboxPath: string | null) => boolean | null;
  // gh#633: the running drone's wake-mechanism (codex remote-wake vs claude)
  // + the codex app-server bridge-armed probe, so the tick computes a
  // transport-agnostic wake_armed without the classifier branching on
  // (mis-recordable) agent_kind.
  isCodexRemoteWake: () => boolean;
  probeBridgeArmed: (active: HealthBeatActive) => Promise<boolean | null>;
  // gh#opencode: optional opencode drone-armed probe (SDK child session health).
  // When provided and agentKind is opencode, used instead of the claude monitor.
  probeOpenCodeDrone?: (active: HealthBeatActive) => Promise<boolean | null>;
  // gh#634: live runtime agent_kind (resolveSessionAgentKind) so the beat
  // self-heals the recorded agent_kind, which is otherwise frozen at first-join.
  resolveAgentKind: () => 'claude' | 'codex' | 'opencode';
  // gh#408: live runtime hostname. Caller owns os.hostname() and truncation so
  // buildHealthPayload stays pure and unit-testable.
  resolveHostname: () => string | null;
  // gh#646: installed borgmcp client version. Caller owns getPackageVersion()
  // so buildHealthPayload remains pure.
  resolveVersion: () => string;
}

/**
 * One tick of the periodic beat: resolve the active cube, probe the live
 * wire + Monitor state, cache the monitor result (so cheap per-event beats can
 * reuse it without re-spawning pgrep), and emit the beat. No active cube → no
 * beat. Best-effort: never throws.
 */
export async function runHealthBeatOnce(deps: HealthBeatTickDeps): Promise<void> {
  try {
    const active = await deps.getActiveCube();
    if (!active) return;
    if (active.serverTrustIdentity !== undefined) return;
    const connected = deps.getStreamConnected();
    const healthy = deps.checkMonitor(deps.getInboxPath(active));
    cachedMonitorHealthy = healthy;
    // gh#633: wake_armed = the running drone's OWN wake-transport health.
    // codex (remote-wake) → app-server bridge liveness; claude → the same
    // tail-F Monitor health (its wake path IS the Monitor). Transport-agnostic:
    // HOP-2 reads one boolean, never branches on (mis-recordable) agent_kind.
    // gh#opencode: opencode drones probe the SDK child session health instead.
    const agentKind = deps.resolveAgentKind();
    const wakeArmed = agentKind === 'opencode'
      ? await deps.probeOpenCodeDrone?.(active) ?? null
      : agentKind === 'codex'
        ? deps.isCodexRemoteWake()
          ? await deps.probeBridgeArmed(active)
          : false
        : healthy;
    cachedWakeArmed = wakeArmed;
    // gh#634: live runtime agent_kind, beated every cycle to self-heal the
    // recorded column (frozen at first-join; relaunch never re-assimilates).
    // These agentKind and hostname are already resolved above.
    const hostname = deps.resolveHostname();
    const version = deps.resolveVersion();
    await emitHealthBeat(active, {
      sseConnected: connected,
      inboxMonitorHealthy: healthy,
      wakeArmed,
      agentKind,
      hostname,
      version,
      fetchImpl: deps.fetchImpl,
      getToken: deps.getToken,
    });
  } catch {
    // Best-effort tick: a probe/beat failure must not kill the interval.
  }
}

/** Default periodic cadence for the health beat. */
export const HEALTH_BEAT_INTERVAL_MS = 60_000;

/**
 * Start the periodic beat. Fire-and-forget; the timer is `unref`'d so it never
 * keeps the process alive on its own. Returns the timer handle (tests clear it).
 */
export function startHealthBeatTick(
  deps: HealthBeatTickDeps,
  intervalMs: number = HEALTH_BEAT_INTERVAL_MS
): NodeJS.Timeout {
  // Do not leave a relaunched seat displaying its prior CLI for an entire
  // cadence. The periodic interval remains the durable refresh mechanism;
  // this best-effort first beat makes the identity transition prompt.
  void runHealthBeatOnce(deps);
  const handle = setInterval(() => {
    void runHealthBeatOnce(deps);
  }, intervalMs);
  handle.unref?.();
  return handle;
}
