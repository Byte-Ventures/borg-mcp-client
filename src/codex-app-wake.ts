import {
  getActiveCube,
  getCodexWakeTarget,
  setCodexWakeTarget,
  type ActiveCube,
} from './cubes.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { checkCodexBridgeHealthy } from './codex-remote.js';
import { hasPendingWakeActivity, hasPendingWakeEntry } from './remote-client.js';
import {
  BORG_CODEX_REMOTE_WAKE_ENV,
  resolveSessionAgentKind,
} from './agent-runtime.js';
import {
  codexAppServerSocketFromEnv,
  pickFreshThread,
  wakeTargetChanged,
  wakeRetryBackoffMs,
  wakeRetryExpired,
  WAKE_RETRY_MAX_ATTEMPTS,
  shouldFireHeartbeat,
  type CodexThreadInfo,
} from './codex-wake-resolve.js';
import {
  CUBE_ACTIVITY_RESUME_WAKE_MESSAGE,
  formatCubeActivityWakeMessage,
} from './cube-activity-wake-copy.js';

export const CODEX_WAKE_PROMPT =
  CUBE_ACTIVITY_RESUME_WAKE_MESSAGE;

export function formatCodexWakePrompt(inboxLine: string): string {
  return formatCubeActivityWakeMessage(inboxLine);
}

// gh#708: STATIC catch-up/drain prompt (zero interpolation — no token/secret/PII/
// cube-content; the entry bodies are fetched by codex itself via the
// grant/visibility-gated borg_read-log, never injected into the wake). Delivered
// once after a wake is deferred (mid-turn thread) or retried (transient miss), to
// fire the already-shipped drain so no entry is skipped. gh#857 WI-2 reuses it as
// the periodic heartbeat prompt.
export const CODEX_CATCHUP_PROMPT =
  `${formatCubeActivityWakeMessage('Wake triage: repeat the drain until the returned page is under the limit and behind_by is 0 so no entries are skipped.')} ` +
  'If there are no actionable entries, resume the prior interrupted work.';

export function isCodexRemoteWakeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BORG_CODEX_REMOTE_WAKE_ENV] === '1';
}

export { resolveSessionAgentKind } from './agent-runtime.js';

export interface CodexWakeTarget {
  enabled: boolean;
}

export function resolveCodexWakeTarget(env: NodeJS.ProcessEnv = process.env): CodexWakeTarget {
  if (!isCodexRemoteWakeEnabled(env)) {
    return { enabled: false };
  }
  return { enabled: true };
}

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
export async function probeCodexBridgeArmed(
  active: { cubeId: string; droneId: string },
  deps: {
    getCodexWakeTarget?: typeof getCodexWakeTarget;
    checkBridge?: typeof checkCodexBridgeHealthy;
  } = {}
): Promise<boolean | null> {
  try {
    const resolve = deps.getCodexWakeTarget ?? getCodexWakeTarget;
    const target = await resolve(active.cubeId, active.droneId);
    // No registered wake target → the bridge cannot deliver a wake → not armed.
    if (!target) return false;
    const check = deps.checkBridge ?? checkCodexBridgeHealthy;
    return check(target.socketPath);
  } catch {
    return null;
  }
}

let wakeInFlight = false;
const pendingWakeRequests: Array<{
  reason: string;
  deliveryIdentity?: string;
  sourceEntryId?: string;
  deps: CodexWakeDeps;
}> = [];
const deliveredWakeKeys = new Set<string>();
const deliveredWakeKeyOrder: string[] = [];
const DELIVERED_WAKE_KEY_CAP = 100;

// gh#708/#857: a single in-flight retry-drain loop coalesces ALL wakes deferred
// (mid-turn thread) or missed (transient error) into ONE retried-until-delivered
// drain. The coalesce gate means a burst collapses to one poller, not N.
let retryDrainInFlight = false;
const retryDrainSourceEntryIds = new Set<string>();
let retryDrainHasUnscopedWork = false;

// gh#857 WI-2: timestamp of the last SUCCESSFUL wake delivery (per-entry OR
// retry-drain OR heartbeat). The heartbeat reads this (shouldFireHeartbeat) to
// skip when a delivery already landed inside the cadence window. Module-scoped
// because the wake path and the heartbeat run in the same MCP-client child.
let lastDeliveredAt: number | null = null;

/** gh#857 WI-2: last successful wake delivery time (for the heartbeat gate). */
export function getLastDeliveredAt(): number | null {
  return lastDeliveredAt;
}

// client#89: delivery-state observability. The Codex wake-path health surface
// must distinguish "bridge armed" from "delivery healthy" — a wake deferred
// (mid-turn) or failed and being retried is NOT a healthy wake path, even
// though the app-server socket is alive. These module-scoped fields track the
// last injection attempt/result and the last failure (a secret-free error
// code/class only — never message contents); the deferred-queue state is read
// live from the existing retry-drain fields. Same process as the health probe
// (the wake path and stream-status run in the same MCP-client child), so the
// snapshot is directly visible. NONE of this changes the wake mechanism.
type CodexInjectionResult = 'delivered' | 'deferred' | 'failed';
// HISTORICAL reporting — the last injection attempt/result/failure. These are
// surfaced on the status surface for diagnosis; they are NOT used to decide
// health, because a historical result does not self-clear when work is drained
// by another path (manual read, server read-cursor recovery). Health keys off
// the LIVE signals below.
let lastInjectionAt: number | null = null;
let lastInjectionResult: CodexInjectionResult | null = null;
let lastInjectionFailureCode: string | null = null;
let lastTargetThreadId: string | null = null;
// client#89: a LIVE marker for undelivered directed wakes NOT tracked by the
// retry-drain queue (retryDrainActive / deferredEntryCount cover that queue and
// self-clear on prune/deliver). SET at every injection exit where an
// authoritatively-pending wake could not be delivered and is not queued: the
// heartbeat mid-turn skip / no-target return / transient failure, the per-entry
// no-target return for a still-pending scoped entry, and the retry-drain age-out
// hand-off. CLEARED when any delivery lands (markDelivered) and when the
// heartbeat authoritatively finds no pending work. It is a LIVE signal, not a
// historical result, so a seat that recovers by any path returns to healthy.
let deliveryDeferred = false;

export interface CodexDeliveryState {
  /** Opaque thread id of the last-resolved wake target (never a socket path). */
  lastTargetThreadId: string | null;
  /** HISTORICAL last attempt time (reporting only; not a health input). */
  lastInjectionAt: number | null;
  /** HISTORICAL last attempt result (reporting only; not a health input). */
  lastInjectionResult: CodexInjectionResult | null;
  /** Secret-free error code/class of the last failed injection; never contents. */
  lastInjectionFailureCode: string | null;
  /** LIVE: entries currently deferred/retrying (not yet confirmed delivered). */
  deferredEntryCount: number;
  /** LIVE: a coalesced retry-drain loop is currently retrying deferred/missed wakes. */
  retryDrainActive: boolean;
  /** LIVE: an undelivered directed wake not tracked by the retry-drain queue. */
  deliveryDeferred: boolean;
  lastDeliveredAt: number | null;
}

/** Snapshot of the Codex wake-path delivery state for the health/status surface. */
export function getCodexDeliveryState(): CodexDeliveryState {
  return {
    lastTargetThreadId,
    lastInjectionAt,
    lastInjectionResult,
    lastInjectionFailureCode,
    deferredEntryCount: retryDrainSourceEntryIds.size + (retryDrainHasUnscopedWork ? 1 : 0),
    retryDrainActive: retryDrainInFlight,
    deliveryDeferred,
    lastDeliveredAt,
  };
}

/** Reduce a caught error to a secret-free code/class — never its message. */
function injectionFailureCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error && err.name) return err.name;
  return 'unknown';
}

function recordInjectionResult(
  result: CodexInjectionResult,
  now: () => number,
  failureCode?: string,
): void {
  lastInjectionAt = now();
  lastInjectionResult = result;
  lastInjectionFailureCode = result === 'failed' ? (failureCode ?? 'unknown') : null;
}

/**
 * client#89: pure wake-path health for Codex, folding the LIVE delivery state
 * into the raw "bridge armed" probe. A wake still pending redelivery — a live
 * retry-drain, a non-empty deferred queue, or an undelivered heartbeat pending
 * — is NOT a confirmed-healthy path (returns null = degraded). A positively-
 * dead bridge dominates (false). Historical last-attempt results are NOT used
 * here: they do not self-clear when work is drained by another path, so keying
 * health off them would leave a recovered seat permanently degraded.
 */
export function codexWakePathHealthy(
  armed: boolean | null,
  state: CodexDeliveryState,
): boolean | null {
  if (armed === false) return false; // positively-dead bridge
  if (armed === null) return null; // could not probe → indeterminate
  // Bridge armed. Degraded while any LIVE signal shows an unconfirmed delivery.
  if (
    state.retryDrainActive ||
    state.deferredEntryCount > 0 ||
    state.deliveryDeferred
  ) {
    return null;
  }
  return true;
}

function markDelivered(deps: CodexWakeDeps): void {
  lastDeliveredAt = (deps.now ?? Date.now)();
  // client#89: any confirmed delivery clears the live heartbeat-pending marker.
  deliveryDeferred = false;
}

// gh#857 WI-2: a single-in-flight guard for the heartbeat tick (mirrors
// wakeInFlight + retryDrainInFlight). Without it, a tick that stalls in IO past
// the next interval could let a second tick read the stale (pre-markDelivered)
// lastDeliveredAt, pass its gate, and double-inject the drain — the exact
// double-fire the design forbids.
let heartbeatInFlight = false;

// gh#861 finding 1: a SINGLE module-scoped mutex serializing the resolve+inject
// critical section ACROSS all three injecting paths (per-entry wake, retry-drain,
// heartbeat tick). The per-path flags above (wakeInFlight / retryDrainInFlight /
// heartbeatInFlight) each serialize their OWN path but NOT across paths — so a
// per-entry WAKE prompt and a heartbeat/retry DRAIN prompt could land in the same
// codex thread concurrently (double-inject collision). This lock closes that
// cross-path race: a path that cannot acquire it backs off via its own retry
// mechanism (heartbeat: skip tick; retry-drain: continue loop; per-entry: schedule
// a retry-drain so the entry is not lost).
let injectInFlight = false;

function tryAcquireInjectLock(): boolean {
  if (injectInFlight) return false;
  injectInFlight = true;
  return true;
}

function releaseInjectLock(): void {
  injectInFlight = false;
}

/**
 * gh#861 finding 3: a positively-dead codex app-server socket. ENOENT means the
 * socket file is gone (the app-server never created it / unlinked it on exit) —
 * the wake path cannot deliver, so the heartbeat timer should be torn down. Kept
 * narrow (ENOENT only): a transient ECONNREFUSED during a momentary blip must NOT
 * tear the backstop down.
 */
function isAppServerDeadError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CodexWakeDeps {
  getActiveCube?: typeof getActiveCube;
  getCodexWakeTarget?: typeof getCodexWakeTarget;
  // gh#855: self-heal write of the freshly-resolved target (write-only-on-change).
  setCodexWakeTarget?: typeof setCodexWakeTarget;
  createClient?: (
    socketPath: string
  ) => Pick<CodexAppServerClient, 'connect' | 'readThread' | 'startTurn' | 'loadedThreadIds' | 'close'>;
  // gh#855: injectable env (live app-server socket) + cwd (thread disambiguation).
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  // gh#708/#857: injectable for the retry-drain loop (real timers in prod; fake in tests).
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  // gh#857: injectable backoff jitter (default Math.random()*500) so co-located
  // sibling drones don't retry in lockstep; deterministic (0) in tests.
  jitter?: () => number;
  // gh#857: injectable hard iteration ceiling for the retry-drain loop (default
  // WAKE_RETRY_MAX_ATTEMPTS); small values let tests prove the loop terminates
  // under a non-advancing clock without running thousands of iterations.
  maxAttempts?: number;
  // client#76: token-free, non-mutating preflight for the periodic backstop.
  // Per-entry and retry-drain paths do not use this: their pending obligation is
  // already established by a concrete delivered/deferred event.
  hasPendingWork?: (active: ActiveCube) => Promise<boolean>;
  hasPendingEntry?: (active: ActiveCube, entryId: string) => Promise<boolean>;
  // gh#861 finding 2: lease-ownership gate for the heartbeat tick — a lease-LOSING
  // duplicate child must NOT tick/inject (symmetry with the per-entry path, which
  // only fires inside an SSE session that holds the stream lease). Heartbeat-only;
  // when omitted the gate is skipped (direct unit calls / the per-entry + drain
  // paths are already lease-silenced upstream). Production wiring passes a
  // predicate reading the stream loop's current lease ownership.
  isStreamOwner?: () => boolean;
  // gh#861 finding 3: invoked when the heartbeat tick detects the codex app-server
  // socket is positively gone (ENOENT) — the wake path is dead, so the production
  // wiring tears down the heartbeat timer (re-armed when an active cube returns).
  onAppServerSocketDead?: () => void;
}

/**
 * gh#855: FRESH wake-target resolution. Prefer THIS drone's live app-server
 * socket (pinned into the child's env at spawn) and re-resolve the loaded thread
 * NOW (loadedThreadIds is re-runnable) — so a missed/stale launch probe or a
 * thread change can never cause permanent deafness. Self-heals the file cache
 * (write-only-on-change) so other readers (probeCodexBridgeArmed / health-beat)
 * stay current. Falls back to the launch-recorded file when the env socket is
 * absent (un-upgraded launch) — no regression. Returns the resolved target, or
 * null (caller skips this wake; the next one retries). Does NOT keep a
 * connection open — the env path opens a short-lived probe client to re-resolve
 * the thread, then closes it, so the caller can dedup BEFORE opening the wake
 * connection (no reconnect on an already-delivered wake).
 */
function makeCodexClient(
  sock: string,
  deps: CodexWakeDeps
): Pick<CodexAppServerClient, 'connect' | 'readThread' | 'startTurn' | 'loadedThreadIds' | 'close'> {
  return deps.createClient ? deps.createClient(sock) : new CodexAppServerClient(sock);
}

async function resolveFreshCodexWakeTarget(
  active: { cubeId: string; droneId: string },
  deps: CodexWakeDeps
): Promise<{ socketPath: string; threadId: string } | null> {
  const envSocket = codexAppServerSocketFromEnv(deps.env ?? process.env);
  if (envSocket) {
    const probe = makeCodexClient(envSocket, deps);
    await probe.connect();
    try {
      const ids = await probe.loadedThreadIds();
      const summaries: CodexThreadInfo[] = [];
      for (const id of ids) {
        const t = await probe.readThread(id);
        if (t) summaries.push({ id: t.id, cwd: t.cwd, updatedAt: t.updatedAt });
      }
      const threadId = pickFreshThread(summaries, { cwd: (deps.cwd ?? (() => process.cwd()))() });
      if (!threadId) return null; // no loaded thread yet — next wake retries (no permanent fail)
      await maybePersistWakeTarget(active, { socketPath: envSocket, threadId }, deps);
      return { socketPath: envSocket, threadId };
    } finally {
      probe.close();
    }
  }

  // Fallback: the launch-recorded file (un-upgraded launch / env absent) — no
  // connect needed to resolve, so the caller dedups before opening any socket.
  const target = await (deps.getCodexWakeTarget ?? getCodexWakeTarget)(active.cubeId, active.droneId);
  if (!target) return null;
  return { socketPath: target.socketPath, threadId: target.threadId };
}

/** Self-healing cache write — only when the resolved target actually changed. */
async function maybePersistWakeTarget(
  active: { cubeId: string; droneId: string },
  fresh: { socketPath: string; threadId: string },
  deps: CodexWakeDeps
): Promise<void> {
  try {
    const get = deps.getCodexWakeTarget ?? getCodexWakeTarget;
    const set = deps.setCodexWakeTarget ?? setCodexWakeTarget;
    const existing = await get(active.cubeId, active.droneId);
    const prev = existing ? { socketPath: existing.socketPath, threadId: existing.threadId } : null;
    if (wakeTargetChanged(prev, fresh)) {
      await set(active.cubeId, active.droneId, fresh);
    }
  } catch {
    // best-effort cache write; never break the wake path
  }
}

export function wakeCodexViaAppServer(
  reason: string = CODEX_WAKE_PROMPT,
  env: NodeJS.ProcessEnv = process.env,
  deps: CodexWakeDeps = {},
  deliveryIdentity?: string,
  sourceEntryId?: string,
): void {
  const target = resolveCodexWakeTarget(env);
  if (!target.enabled) return;
  pendingWakeRequests.push({ reason, deliveryIdentity, sourceEntryId, deps });
  if (wakeInFlight) return;

  wakeInFlight = true;
  void drainCodexWakeQueue().finally(() => {
    wakeInFlight = false;
  });
}

async function drainCodexWakeQueue(): Promise<void> {
  while (pendingWakeRequests.length > 0) {
    const request = pendingWakeRequests.shift()!;
    await wakeCodexTargeted(
      request.reason, request.deliveryIdentity, request.sourceEntryId, request.deps,
    );
  }
}

async function wakeCodexTargeted(
  reason: string,
  deliveryIdentity: string | undefined,
  sourceEntryId: string | undefined,
  deps: CodexWakeDeps,
): Promise<void> {
  // gh#861 finding 1: another path (heartbeat/retry-drain) is mid-inject into the
  // same thread — defer to the retry-drain so this entry isn't double-injected nor
  // lost (the drain re-syncs the whole burst via the server read-cursor).
  if (!tryAcquireInjectLock()) {
    scheduleRetryDrain(deps, sourceEntryId);
    return;
  }
  try {
    const active = await (deps.getActiveCube ?? getActiveCube)();
    if (!active) return;
    const pendingEntry = deps.hasPendingEntry ?? hasPendingWakeEntry;
    if (sourceEntryId && !(await pendingEntry(active, sourceEntryId))) return;
    // gh#855: resolve FRESH (live env socket + re-resolved thread), falling back
    // to the launch-recorded file only when the env socket is absent.
    const resolved = await resolveFreshCodexWakeTarget(active, deps);
    if (!resolved) {
      // client#89: a scoped entry passed the pending check above but no target
      // resolves — undeliverable, and this path does NOT schedule a retry-drain
      // (the design leaves it to the next wake / the heartbeat backstop). Mark
      // the deferral live so health reads degraded rather than armed. An
      // unscoped wake carries no authoritative pending signal, so it does not
      // set the marker. Retry behavior is unchanged.
      if (sourceEntryId) deliveryDeferred = true;
      return;
    }
    const { socketPath, threadId } = resolved;
    lastTargetThreadId = threadId; // client#89: record the selected target
    const wakeKey = `${threadId}\0${deliveryIdentity ?? reason}`;
    if (deliveredWakeKeys.has(wakeKey)) return; // dedup before opening the wake socket
    const client = makeCodexClient(socketPath, deps);
    await client.connect();
    try {
      const thread = await client.readThread(threadId);
      if (thread?.status?.type === 'active') {
        // gh#708/#857: the thread is mid-turn — this per-entry wake can't land
        // now. Schedule the retry-drain (coalesced, retried-until-delivered) so
        // the burst's entries are drained once the thread goes idle; codex has no
        // on-disk tail fallback like Claude's borg-inbox-monitor.
        recordInjectionResult('deferred', deps.now ?? Date.now); // client#89
        scheduleRetryDrain(deps, sourceEntryId);
        return;
      }
      if (sourceEntryId && !(await pendingEntry(active, sourceEntryId))) return;
      await client.startTurn(threadId, reason);
      rememberDeliveredWake(wakeKey);
      recordInjectionResult('delivered', deps.now ?? Date.now); // client#89
      markDelivered(deps);
    } finally {
      client.close();
    }
  } catch (err) {
    // gh#857: a transient connect/read/startTurn failure must NOT be silently
    // swallowed (the old best-effort drop let a single blip lose an entry).
    // Schedule the retry-drain so the wake is retried-until-delivered; the SSE
    // stream is never broken (this is fire-and-forget).
    recordInjectionResult('failed', deps.now ?? Date.now, injectionFailureCode(err)); // client#89
    scheduleRetryDrain(deps, sourceEntryId);
  } finally {
    releaseInjectLock();
  }
}

/**
 * gh#708/#857 WI-1: schedule a single coalesced retry-drain. Multiple wakes
 * deferred (mid-turn) or missed (transient) collapse into ONE loop
 * (retryDrainInFlight gate). The loop retries — with exponential backoff
 * (wakeRetryBackoffMs) — until the thread is reachable+idle and the
 * CODEX_CATCHUP_PROMPT drain is delivered (server read-cursor then drains ALL
 * unread, so one drain covers the whole burst). Durable: unlike the old
 * 15-min-give-up catch-up poller, it retries until a generous age cap
 * (wakeRetryExpired); the gh#857 WI-2 heartbeat is the backstop beyond that.
 * Never throws into the SSE path (fire-and-forget).
 */
function scheduleRetryDrain(deps: CodexWakeDeps, sourceEntryId?: string): void {
  if (sourceEntryId) retryDrainSourceEntryIds.add(sourceEntryId);
  else retryDrainHasUnscopedWork = true;
  if (retryDrainInFlight) return; // coalesce: one loop covers all deferred/missed wakes
  retryDrainInFlight = true;
  void runRetryDrainLoop(deps).finally(() => {
    retryDrainInFlight = false;
  });
}

async function runRetryDrainLoop(deps: CodexWakeDeps): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const jitter = deps.jitter ?? (() => Math.random() * 500);
  const maxAttempts = deps.maxAttempts ?? WAKE_RETRY_MAX_ATTEMPTS;
  const startedAt = now();
  let attempts = 0;
  // Terminate on the time-based age cap OR a hard iteration ceiling (defensive
  // belt: a non-advancing clock would make the time-only guard hot-spin).
  while (!wakeRetryExpired(startedAt, now()) && attempts < maxAttempts) {
    await sleep(wakeRetryBackoffMs(attempts, jitter()));
    attempts++;
    // gh#861 finding 1: another path (heartbeat/per-entry wake) holds the inject
    // lock — back off and retry rather than double-inject into the same thread.
    if (!tryAcquireInjectLock()) continue;
    try {
      const active = await (deps.getActiveCube ?? getActiveCube)();
      if (!active) continue; // no active cube yet → keep retrying (until age cap)
      const pendingEntry = deps.hasPendingEntry ?? hasPendingWakeEntry;
      for (const entryId of retryDrainSourceEntryIds) {
        try {
          if (!(await pendingEntry(active, entryId))) retryDrainSourceEntryIds.delete(entryId);
        } catch {
          // Retain the obligation until unread state can be checked.
        }
      }
      if (!retryDrainHasUnscopedWork && retryDrainSourceEntryIds.size === 0) return;
      // gh#855: same FRESH resolution as the per-entry wake, so a stale launch
      // probe can't defeat the retry-drain either.
      const resolved = await resolveFreshCodexWakeTarget(active, deps);
      if (!resolved) continue; // thread not loaded yet → retry (age-capped)
      const { socketPath, threadId } = resolved;
      lastTargetThreadId = threadId; // client#89: record the selected target
      const client = makeCodexClient(socketPath, deps);
      await client.connect();
      try {
        const thread = await client.readThread(threadId);
        if (thread?.status?.type === 'active') {
          recordInjectionResult('deferred', now); // client#89
          continue; // re-defer: still mid-turn (backoff before next poll)
        }
        for (const entryId of retryDrainSourceEntryIds) {
          if (!(await pendingEntry(active, entryId))) retryDrainSourceEntryIds.delete(entryId);
        }
        if (!retryDrainHasUnscopedWork && retryDrainSourceEntryIds.size === 0) return;
        await client.startTurn(threadId, CODEX_CATCHUP_PROMPT);
        retryDrainSourceEntryIds.clear();
        retryDrainHasUnscopedWork = false;
        recordInjectionResult('delivered', now); // client#89
        markDelivered(deps);
        return; // drain delivered → server read-cursor drains all unread → done
      } finally {
        client.close();
      }
    } catch (err) {
      // transient socket/read error must not abort the loop — keep retrying with
      // backoff until reachable+idle or the age cap; never throws into SSE.
      recordInjectionResult('failed', now, injectionFailureCode(err)); // client#89
    } finally {
      releaseInjectLock();
    }
  }
  // aged out: the gh#857 WI-2 periodic heartbeat is the ultimate backstop.
  // client#89: if obligations remain unfinished (the thread stayed mid-turn
  // through the age cap), the loop is gone but the entries are still pending.
  // Hand off to the live marker and clear the retry-drain set, so health stays
  // degraded (not stuck via a stale deferredEntryCount after the loop exits)
  // and clears when a delivery lands or the unread authoritatively empties.
  if (retryDrainSourceEntryIds.size > 0 || retryDrainHasUnscopedWork) {
    retryDrainSourceEntryIds.clear();
    retryDrainHasUnscopedWork = false;
    deliveryDeferred = true;
  }
}

/**
 * gh#857 WI-2: codex /loop-equivalent heartbeat cadence. Codex retains this
 * independent 20-minute drain because it has no Claude-style per-entry inbox
 * Monitor. Claude recovery is adaptive: 3h ±30m while the Monitor is healthy
 * or indeterminate, and 15m ±3m only while it is explicitly broken.
 */
export const CODEX_HEARTBEAT_CADENCE_MS = 20 * 60_000;

/**
 * gh#857/client#76: one tick of the codex catch-up backstop. The cadence only
 * initiates a token-free unread-state preflight; a DRAIN turn is injected when
 * that authoritative scan finds real work that a per-entry wake missed. Recent
 * delivery still suppresses redundant preflights. Unlike the per-entry path it
 * does not consult deliveredWakeKeys because the unread cursor is authoritative.
 * Best-effort: a failed preflight, mid-turn thread, transient error, or unresolved
 * target skips this tick and lets the next cadence retry. Never throws.
 */
export async function fireCodexHeartbeatTick(
  deps: CodexWakeDeps = {},
  cadenceMs: number = CODEX_HEARTBEAT_CADENCE_MS
): Promise<void> {
  if (heartbeatInFlight) return; // a prior tick's IO is still running → no overlap
  const now = (deps.now ?? Date.now)();
  if (!shouldFireHeartbeat(lastDeliveredAt, now, cadenceMs)) return; // a wake landed recently
  // gh#861 finding 2: a lease-LOSING duplicate child must not tick/inject — mirror
  // the per-entry path, which only fires inside an SSE session holding the stream
  // lease. When the gate is provided and we don't own the lease, skip this tick.
  if (deps.isStreamOwner && !deps.isStreamOwner()) return;
  // gh#861 finding 1: another path is mid-inject into the thread → skip this tick
  // (next tick retries) rather than collide a DRAIN prompt with an in-flight wake.
  if (!tryAcquireInjectLock()) return;
  // Set BEFORE the first await — the check+gate+set above are synchronous, so a
  // concurrent tick can't interleave before the flag is set (single-threaded).
  heartbeatInFlight = true;
  try {
    const active = await (deps.getActiveCube ?? getActiveCube)();
    if (!active) return;
    // Elapsed time alone must never cross the model boundary. Query the
    // authoritative unread state without advancing its cursor; only then touch
    // the app-server socket or resolve a thread.
    const hasPendingWork = deps.hasPendingWork ?? hasPendingWakeActivity;
    if (!(await hasPendingWork(active))) {
      // client#89: authoritative unread is empty → no undelivered wake remains.
      // Clear the live heartbeat-pending marker so a seat that recovered by any
      // path (manual read, server read-cursor drain) returns to healthy.
      deliveryDeferred = false;
      return;
    }
    const resolved = await resolveFreshCodexWakeTarget(active, deps);
    if (!resolved) {
      // client#89: authoritative pending work exists but no fresh target/thread
      // resolves — the wake is UNDELIVERABLE this tick. The persisted-target
      // probe can still read armed, so mark the deferral live (health degraded)
      // until a target resolves and delivers, or the unread authoritatively
      // clears. Cadence/retry behavior is unchanged (the next tick still tries).
      deliveryDeferred = true;
      return; // thread not loaded yet → next tick retries
    }
    lastTargetThreadId = resolved.threadId; // client#89: record the selected target
    const client = makeCodexClient(resolved.socketPath, deps);
    await client.connect();
    try {
      const thread = await client.readThread(resolved.threadId);
      if (thread?.status?.type === 'active') {
        // client#89: we passed hasPendingWork above, so a mid-turn thread here
        // means a directed entry is deferred. Mark it LIVE-pending (the heartbeat
        // does not queue into the retry-drain) so the health surface reads
        // degraded until a delivery lands or the unread authoritatively clears.
        // Skip semantics are unchanged — the next tick still retries.
        recordInjectionResult('deferred', deps.now ?? Date.now);
        deliveryDeferred = true;
        return; // mid-turn → skip; next tick retries
      }
      await client.startTurn(resolved.threadId, CODEX_CATCHUP_PROMPT);
      // markDelivered clears the live heartbeat-pending marker.
      recordInjectionResult('delivered', deps.now ?? Date.now); // client#89
      markDelivered(deps);
    } finally {
      client.close();
    }
  } catch (err) {
    // gh#861 finding 3: a positively-dead app-server socket (ENOENT) → the wake
    // path is gone; signal teardown so the timer stops ticking against a dead
    // socket (re-armed when an active cube returns). Other (transient) errors are
    // best-effort skips — never break the SSE stream; next tick retries.
    // client#89: we passed hasPendingWork, so a failure here leaves pending work
    // undelivered → mark it live-pending (a dead bridge is separately false via
    // the armed probe). Clears on the next authoritative-empty tick or delivery.
    recordInjectionResult('failed', deps.now ?? Date.now, injectionFailureCode(err)); // client#89
    deliveryDeferred = true;
    if (isAppServerDeadError(err)) deps.onAppServerSocketDead?.();
  } finally {
    heartbeatInFlight = false;
    releaseInjectLock();
  }
}

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
export function startCodexHeartbeat(
  opts: {
    agentKind?: 'claude' | 'codex' | 'opencode';
    remoteWakeEnabled?: boolean;
    intervalMs?: number;
    tick?: () => void;
  } = {}
): ReturnType<typeof setInterval> | null {
  const agentKind = opts.agentKind ?? resolveSessionAgentKind();
  const remoteWakeEnabled = opts.remoteWakeEnabled ?? isCodexRemoteWakeEnabled();
  if (agentKind !== 'codex' || !remoteWakeEnabled) return null;
  const intervalMs = opts.intervalMs ?? CODEX_HEARTBEAT_CADENCE_MS;
  const tick = opts.tick ?? (() => void fireCodexHeartbeatTick());
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

export function resetCodexWakeForTests(): void {
  wakeInFlight = false;
  pendingWakeRequests.length = 0;
  deliveredWakeKeys.clear();
  deliveredWakeKeyOrder.length = 0;
  retryDrainInFlight = false;
  retryDrainSourceEntryIds.clear();
  retryDrainHasUnscopedWork = false;
  lastDeliveredAt = null;
  heartbeatInFlight = false;
  injectInFlight = false;
  // client#89 delivery-state observability
  lastInjectionAt = null;
  lastInjectionResult = null;
  lastInjectionFailureCode = null;
  lastTargetThreadId = null;
  deliveryDeferred = false;
}

function rememberDeliveredWake(key: string): void {
  if (deliveredWakeKeys.has(key)) return;
  deliveredWakeKeys.add(key);
  deliveredWakeKeyOrder.push(key);
  while (deliveredWakeKeyOrder.length > DELIVERED_WAKE_KEY_CAP) {
    const oldKey = deliveredWakeKeyOrder.shift();
    if (oldKey) deliveredWakeKeys.delete(oldKey);
  }
}
