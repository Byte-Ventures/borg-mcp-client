import { getActiveCube, getCodexWakeTarget, setCodexWakeTarget } from './cubes.js';
import { CodexAppServerClient } from './codex-app-server.js';
import { checkCodexBridgeHealthy } from './codex-remote.js';
import { recordEventReceipt } from './health-beat.js';
import { BORG_CODEX_REMOTE_WAKE_ENV, resolveSessionAgentKind, } from './agent-runtime.js';
import { codexAppServerSocketFromEnv, pickFreshThread, wakeTargetChanged, wakeRetryBackoffMs, wakeRetryExpired, WAKE_RETRY_MAX_ATTEMPTS, shouldFireHeartbeat, } from './codex-wake-resolve.js';
export const CODEX_WAKE_PROMPT = 'New Borg cube-log activity arrived.';
export function formatCodexWakePrompt(inboxLine) {
    return `New Borg cube-log activity arrived:\n${inboxLine}`;
}
// gh#708: STATIC catch-up/drain prompt (zero interpolation — no token/secret/PII/
// cube-content; the entry bodies are fetched by codex itself via the
// RLS/visibility-gated borg_read-log, never injected into the wake). Delivered
// once after a wake is deferred (mid-turn thread) or retried (transient miss), to
// fire the already-shipped drain so no entry is skipped. gh#857 WI-2 reuses it as
// the periodic heartbeat prompt.
export const CODEX_CATCHUP_PROMPT = 'Borg cube activity arrived while you were busy. Wake triage: run `borg_read-log unread_only=true` and DRAIN — repeat until the returned page is under the limit and behind_by is 0 — so no entries are skipped. Then handle actionable entries; if none, resume the prior interrupted work.';
export function isCodexRemoteWakeEnabled(env = process.env) {
    return env[BORG_CODEX_REMOTE_WAKE_ENV] === '1';
}
export { resolveSessionAgentKind } from './agent-runtime.js';
export function resolveCodexWakeTarget(env = process.env) {
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
export async function probeCodexBridgeArmed(active, deps = {}) {
    try {
        const resolve = deps.getCodexWakeTarget ?? getCodexWakeTarget;
        const target = await resolve(active.cubeId, active.droneId);
        // No registered wake target → the bridge cannot deliver a wake → not armed.
        if (!target)
            return false;
        const check = deps.checkBridge ?? checkCodexBridgeHealthy;
        return check(target.socketPath);
    }
    catch {
        return null;
    }
}
let wakeInFlight = false;
const pendingWakeRequests = [];
const deliveredWakeKeys = new Set();
const deliveredWakeKeyOrder = [];
const DELIVERED_WAKE_KEY_CAP = 100;
// gh#708/#857: a single in-flight retry-drain loop coalesces ALL wakes deferred
// (mid-turn thread) or missed (transient error) into ONE retried-until-delivered
// drain. The coalesce gate means a burst collapses to one poller, not N.
let retryDrainInFlight = false;
// gh#857 WI-2: timestamp of the last SUCCESSFUL wake delivery (per-entry OR
// retry-drain OR heartbeat). The heartbeat reads this (shouldFireHeartbeat) to
// skip when a delivery already landed inside the cadence window. Module-scoped
// because the wake path and the heartbeat run in the same MCP-client child.
let lastDeliveredAt = null;
/** gh#857 WI-2: last successful wake delivery time (for the heartbeat gate). */
export function getLastDeliveredAt() {
    return lastDeliveredAt;
}
function markDelivered(deps) {
    lastDeliveredAt = (deps.now ?? Date.now)();
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
function tryAcquireInjectLock() {
    if (injectInFlight)
        return false;
    injectInFlight = true;
    return true;
}
function releaseInjectLock() {
    injectInFlight = false;
}
/**
 * gh#861 finding 3: a positively-dead codex app-server socket. ENOENT means the
 * socket file is gone (the app-server never created it / unlinked it on exit) —
 * the wake path cannot deliver, so the heartbeat timer should be torn down. Kept
 * narrow (ENOENT only): a transient ECONNREFUSED during a momentary blip must NOT
 * tear the backstop down.
 */
function isAppServerDeadError(err) {
    return err?.code === 'ENOENT';
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
function makeCodexClient(sock, deps) {
    return deps.createClient ? deps.createClient(sock) : new CodexAppServerClient(sock);
}
async function resolveFreshCodexWakeTarget(active, deps) {
    const envSocket = codexAppServerSocketFromEnv(deps.env ?? process.env);
    if (envSocket) {
        const probe = makeCodexClient(envSocket, deps);
        await probe.connect();
        try {
            const ids = await probe.loadedThreadIds();
            const summaries = [];
            for (const id of ids) {
                const t = await probe.readThread(id);
                if (t)
                    summaries.push({ id: t.id, cwd: t.cwd, updatedAt: t.updatedAt });
            }
            const threadId = pickFreshThread(summaries, { cwd: (deps.cwd ?? (() => process.cwd()))() });
            if (!threadId)
                return null; // no loaded thread yet — next wake retries (no permanent fail)
            await maybePersistWakeTarget(active, { socketPath: envSocket, threadId }, deps);
            return { socketPath: envSocket, threadId };
        }
        finally {
            probe.close();
        }
    }
    // Fallback: the launch-recorded file (un-upgraded launch / env absent) — no
    // connect needed to resolve, so the caller dedups before opening any socket.
    const target = await (deps.getCodexWakeTarget ?? getCodexWakeTarget)(active.cubeId, active.droneId);
    if (!target)
        return null;
    return { socketPath: target.socketPath, threadId: target.threadId };
}
/** Self-healing cache write — only when the resolved target actually changed. */
async function maybePersistWakeTarget(active, fresh, deps) {
    try {
        const get = deps.getCodexWakeTarget ?? getCodexWakeTarget;
        const set = deps.setCodexWakeTarget ?? setCodexWakeTarget;
        const existing = await get(active.cubeId, active.droneId);
        const prev = existing ? { socketPath: existing.socketPath, threadId: existing.threadId } : null;
        if (wakeTargetChanged(prev, fresh)) {
            await set(active.cubeId, active.droneId, fresh);
        }
    }
    catch {
        // best-effort cache write; never break the wake path
    }
}
export function wakeCodexViaAppServer(reason = CODEX_WAKE_PROMPT, env = process.env, deps = {}) {
    const target = resolveCodexWakeTarget(env);
    if (!target.enabled)
        return;
    pendingWakeRequests.push({ reason, deps });
    if (wakeInFlight)
        return;
    wakeInFlight = true;
    void drainCodexWakeQueue().finally(() => {
        wakeInFlight = false;
    });
}
async function drainCodexWakeQueue() {
    while (pendingWakeRequests.length > 0) {
        const request = pendingWakeRequests.shift();
        await wakeCodexTargeted(request.reason, request.deps);
    }
}
async function wakeCodexTargeted(reason, deps) {
    // gh#861 finding 1: another path (heartbeat/retry-drain) is mid-inject into the
    // same thread — defer to the retry-drain so this entry isn't double-injected nor
    // lost (the drain re-syncs the whole burst via the server read-cursor).
    if (!tryAcquireInjectLock()) {
        scheduleRetryDrain(deps);
        return;
    }
    try {
        const active = await (deps.getActiveCube ?? getActiveCube)();
        if (!active)
            return;
        // gh#855: resolve FRESH (live env socket + re-resolved thread), falling back
        // to the launch-recorded file only when the env socket is absent.
        const resolved = await resolveFreshCodexWakeTarget(active, deps);
        if (!resolved)
            return;
        const { socketPath, threadId } = resolved;
        const wakeKey = `${threadId}\0${reason}`;
        if (deliveredWakeKeys.has(wakeKey))
            return; // dedup before opening the wake socket
        const client = makeCodexClient(socketPath, deps);
        await client.connect();
        try {
            const thread = await client.readThread(threadId);
            if (thread?.status?.type === 'active') {
                // gh#708/#857: the thread is mid-turn — this per-entry wake can't land
                // now. Schedule the retry-drain (coalesced, retried-until-delivered) so
                // the burst's entries are drained once the thread goes idle; codex has no
                // on-disk tail fallback like Claude's borg-inbox-monitor.
                scheduleRetryDrain(deps);
                return;
            }
            await client.startTurn(threadId, reason);
            recordEventReceipt();
            rememberDeliveredWake(wakeKey);
            markDelivered(deps);
        }
        finally {
            client.close();
        }
    }
    catch {
        // gh#857: a transient connect/read/startTurn failure must NOT be silently
        // swallowed (the old best-effort drop let a single blip lose an entry).
        // Schedule the retry-drain so the wake is retried-until-delivered; the SSE
        // stream is never broken (this is fire-and-forget).
        scheduleRetryDrain(deps);
    }
    finally {
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
function scheduleRetryDrain(deps) {
    if (retryDrainInFlight)
        return; // coalesce: one loop covers all deferred/missed wakes
    retryDrainInFlight = true;
    void runRetryDrainLoop(deps).finally(() => {
        retryDrainInFlight = false;
    });
}
async function runRetryDrainLoop(deps) {
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
        if (!tryAcquireInjectLock())
            continue;
        try {
            const active = await (deps.getActiveCube ?? getActiveCube)();
            if (!active)
                continue; // no active cube yet → keep retrying (until age cap)
            // gh#855: same FRESH resolution as the per-entry wake, so a stale launch
            // probe can't defeat the retry-drain either.
            const resolved = await resolveFreshCodexWakeTarget(active, deps);
            if (!resolved)
                continue; // thread not loaded yet → retry (age-capped)
            const { socketPath, threadId } = resolved;
            const client = makeCodexClient(socketPath, deps);
            await client.connect();
            try {
                const thread = await client.readThread(threadId);
                if (thread?.status?.type === 'active') {
                    continue; // re-defer: still mid-turn (backoff before next poll)
                }
                await client.startTurn(threadId, CODEX_CATCHUP_PROMPT);
                recordEventReceipt();
                markDelivered(deps);
                return; // drain delivered → server read-cursor drains all unread → done
            }
            finally {
                client.close();
            }
        }
        catch {
            // transient socket/read error must not abort the loop — keep retrying with
            // backoff until reachable+idle or the age cap; never throws into SSE.
        }
        finally {
            releaseInjectLock();
        }
    }
    // aged out: the gh#857 WI-2 periodic heartbeat is the ultimate backstop.
}
/**
 * gh#857 WI-2: codex /loop-equivalent heartbeat cadence. Codex retains this
 * independent 20-minute drain because it has no Claude-style per-entry inbox
 * Monitor. Claude recovery is adaptive: 3h ±30m while the Monitor is healthy
 * or indeterminate, and 15m ±3m only while it is explicitly broken.
 */
export const CODEX_HEARTBEAT_CADENCE_MS = 20 * 60_000;
/**
 * gh#857 WI-2: one tick of the codex /loop-equivalent heartbeat — a periodic,
 * independent re-engagement that injects a borg_read-log (unread_only=true) DRAIN turn so an
 * idle codex drone re-syncs even if every per-entry wake was missed. SKIPS when a
 * delivery (per-entry wake, retry-drain, or a prior heartbeat) already landed
 * within the cadence window (shouldFireHeartbeat), so an active cube with flowing
 * wakes never gets a redundant injection. Unlike the per-entry path it does NOT
 * consult deliveredWakeKeys — the cadence gate is the throttle, and the static
 * drain prompt is intentionally re-delivered each idle window. Best-effort: a
 * mid-turn thread / transient error / unresolved target just skips this tick (the
 * next tick retries). Never throws.
 */
export async function fireCodexHeartbeatTick(deps = {}, cadenceMs = CODEX_HEARTBEAT_CADENCE_MS) {
    if (heartbeatInFlight)
        return; // a prior tick's IO is still running → no overlap
    const now = (deps.now ?? Date.now)();
    if (!shouldFireHeartbeat(lastDeliveredAt, now, cadenceMs))
        return; // a wake landed recently
    // gh#861 finding 2: a lease-LOSING duplicate child must not tick/inject — mirror
    // the per-entry path, which only fires inside an SSE session holding the stream
    // lease. When the gate is provided and we don't own the lease, skip this tick.
    if (deps.isStreamOwner && !deps.isStreamOwner())
        return;
    // gh#861 finding 1: another path is mid-inject into the thread → skip this tick
    // (next tick retries) rather than collide a DRAIN prompt with an in-flight wake.
    if (!tryAcquireInjectLock())
        return;
    // Set BEFORE the first await — the check+gate+set above are synchronous, so a
    // concurrent tick can't interleave before the flag is set (single-threaded).
    heartbeatInFlight = true;
    try {
        const active = await (deps.getActiveCube ?? getActiveCube)();
        if (!active)
            return;
        const resolved = await resolveFreshCodexWakeTarget(active, deps);
        if (!resolved)
            return; // thread not loaded yet → next tick retries
        const client = makeCodexClient(resolved.socketPath, deps);
        await client.connect();
        try {
            const thread = await client.readThread(resolved.threadId);
            if (thread?.status?.type === 'active')
                return; // mid-turn → skip; next tick retries
            await client.startTurn(resolved.threadId, CODEX_CATCHUP_PROMPT);
            // gh#857 CR (7439f931): do NOT recordEventReceipt() here. The receipt
            // watermark (last_event_received_at, gh#541) is evidence that the wake path
            // DELIVERED a REAL inbound cube event — it feeds the deaf-detection
            // classifier and must never be self-generated. This heartbeat is a
            // synthetic, time-driven re-engagement with NO inbound event; recording a
            // receipt here would fabricate liveness and mask a genuinely-deaf drone
            // (the self-vs-receipt flaw). markDelivered (local heartbeat-gating state,
            // NOT the receipt axis) is the only thing the heartbeat updates.
            markDelivered(deps);
        }
        finally {
            client.close();
        }
    }
    catch (err) {
        // gh#861 finding 3: a positively-dead app-server socket (ENOENT) → the wake
        // path is gone; signal teardown so the timer stops ticking against a dead
        // socket (re-armed when an active cube returns). Other (transient) errors are
        // best-effort skips — never break the SSE stream; next tick retries.
        if (isAppServerDeadError(err))
            deps.onAppServerSocketDead?.();
    }
    finally {
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
export function startCodexHeartbeat(opts = {}) {
    const agentKind = opts.agentKind ?? resolveSessionAgentKind();
    const remoteWakeEnabled = opts.remoteWakeEnabled ?? isCodexRemoteWakeEnabled();
    if (agentKind !== 'codex' || !remoteWakeEnabled)
        return null;
    const intervalMs = opts.intervalMs ?? CODEX_HEARTBEAT_CADENCE_MS;
    const tick = opts.tick ?? (() => void fireCodexHeartbeatTick());
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return timer;
}
export function resetCodexWakeForTests() {
    wakeInFlight = false;
    pendingWakeRequests.length = 0;
    deliveredWakeKeys.clear();
    deliveredWakeKeyOrder.length = 0;
    retryDrainInFlight = false;
    lastDeliveredAt = null;
    heartbeatInFlight = false;
    injectInFlight = false;
}
function rememberDeliveredWake(key) {
    if (deliveredWakeKeys.has(key))
        return;
    deliveredWakeKeys.add(key);
    deliveredWakeKeyOrder.push(key);
    while (deliveredWakeKeyOrder.length > DELIVERED_WAKE_KEY_CAP) {
        const oldKey = deliveredWakeKeyOrder.shift();
        if (oldKey)
            deliveredWakeKeys.delete(oldKey);
    }
}
//# sourceMappingURL=codex-app-wake.js.map