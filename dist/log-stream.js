/**
 * Real-time drone wakeup via Server-Sent Events.
 *
 * Replaces the former long-poll + inbox-file-shim wire path
 * for the wire layer; the local inbox file is preserved as the
 * Claude-side wake primitive (Monitor on tail -F) because Claude Code
 * does not currently wake idle agent loops on MCP-protocol
 * notifications. See spec:
 *   docs/superpowers/specs/2026-05-11-server-push-log-subscription.md
 *
 * Lifetimes:
 *   - One persistent fetch-streaming connection to /api/drone/stream
 *     per active cube.
 *   - On every received `event: log`, a single line is appended to the
 *     per-drone inbox file (same format the old poller wrote).
 *   - On every `event: heartbeat`, any carried hwm is compared against
 *     `lastPersistedEventId`; divergence starts a short grace timer
 *     before reconnect so an in-flight live broadcast can arrive first.
 *   - Outer `runLoop` reconnects with exponential backoff on any
 *     stream-level error, including heartbeat watchdog firing.
 *
 * State exposed via `getStreamStatus()` so the `borg_stream-status`
 * MCP tool can probe without perturbing the stream (no second
 * connection, no second auth — just an in-process state snapshot).
 */
import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareBroadcastHwm } from 'borgmcp-shared/log-stream-hwm';
import { getActiveCube, inboxPathForDrone } from './cubes.js';
import { loadBorgServerTrust } from './server-trust.js';
import { advanceLocalServerCursor, encodeLocalServerCursor, getLocalServerCursor, } from './local-server-cursor.js';
import { DroneEvictedError, DRONE_EVICTED_CODE, EVICTED_RESULT_MARKER, errorCodeFromBody, } from './drone-lifecycle.js';
import { CODEX_HEARTBEAT_CADENCE_MS, fireCodexHeartbeatTick, formatCodexWakePrompt, resolveSessionAgentKind, startCodexHeartbeat, wakeCodexViaAppServer, } from './codex-app-wake.js';
import { getValidToken } from './remote-client.js';
import { recordEventReceipt, emitHealthBeat, getCachedMonitorHealthy, getCachedWakeArmed, } from './health-beat.js';
import { getPackageVersion } from './version.js';
import { readBoundedResponseBody } from './server-response.js';
import { isCanonicalHostedApiUrl } from './authority.js';
import { acquireStreamLease, readOwnershipSnapshot, } from './stream-owner.js';
// ------------------------------------------------------------------
// Tuning constants
// ------------------------------------------------------------------
/** Server emits heartbeats every 20s; allow several misses before reconnecting. */
const HEARTBEAT_TIMEOUT_MS = 90_000;
/** Grace window for a heartbeat HWM that is ahead of the local cursor. */
const HWM_DIVERGENCE_GRACE_MS = 2_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 30_000;
export const LOCAL_SERVER_SSE_FRAME_LIMIT_BYTES = 64 * 1024;
/**
 * gh#opencode: module-level mutable opencode entry injector. Set after
 * startup (from index.ts) once the opencode drone module is initialized.
 * Used by defaultDeps when no explicit injectOpenCode is supplied.
 */
let _moduleInjectOpenCode;
export function setModuleInjectOpenCode(fn) {
    _moduleInjectOpenCode = fn;
}
/**
 * Bounded recent-id set sized for the SSE replay window per spec §(3).
 * The catchup query returns up to 200 entries on reconnect; 50 is
 * comfortable headroom for the typical reorder/dedup case (1–3
 * entries) without the memory cost of the old long-poll 500-entry
 * ring buffer.
 */
const RECENT_IDS_CAP = 50;
export const INBOX_TAIL_LINES_CAP = 512;
export const INBOX_TAIL_TRIM_THRESHOLD_LINES = INBOX_TAIL_LINES_CAP * 2;
function resolveRuntimeHostname() {
    try {
        const h = os.hostname();
        return h && h.trim() ? h.trim().slice(0, 255) : null;
    }
    catch {
        return null;
    }
}
const processStartMs = Date.now();
const streamState = {
    connected: false,
    lastWireActivityAt: null,
    lastContentEventAt: null,
    lastHeartbeatAt: null,
    lastPersistedEventId: null,
    reconnectAttempts: 0,
    runLoopRestartCount: 0,
    ownership: { state: 'unowned' },
};
/**
 * Snapshot of the current stream status. Safe to call at any time
 * (returns a copy, does not interact with the running connection).
 */
export function classifyRunLoopHealth(state, uptimeMs = Date.now() - processStartMs) {
    if (state.connected && state.lastWireActivityAt)
        return 'connected';
    if (!state.connected && state.reconnectAttempts > 0)
        return 'reconnecting';
    if (!state.connected && !state.lastWireActivityAt && state.reconnectAttempts === 0 && uptimeMs > 10_000)
        return 'silent-inert';
    return 'never-started';
}
export function getStreamStatus() {
    return { ...streamState, runLoopHealth: classifyRunLoopHealth(streamState) };
}
/**
 * Reset the module-level stream state. EXPORTED FOR TESTS ONLY — the
 * stream state is a singleton that accumulates across the process
 * lifetime in normal operation. Tests asserting on the new
 * content-vs-wire field semantics need a clean slate between
 * scenarios; nothing in production code should call this.
 *
 * @internal — test-only surface; not part of the public client API. The
 * `__`-prefix + `ForTest` suffix mark it as such at every call site.
 */
export function __resetStreamStateForTest() {
    streamState.connected = false;
    streamState.lastWireActivityAt = null;
    streamState.lastContentEventAt = null;
    streamState.lastHeartbeatAt = null;
    streamState.lastPersistedEventId = null;
    streamState.reconnectAttempts = 0;
    streamState.runLoopRestartCount = 0;
    streamState.ownership = { state: 'unowned' };
}
// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------
/**
 * Spawn the background SSE consumer loop. Fire-and-forget; the loop
 * runs until process exit. Errors are written to stderr (so they don't
 * pollute the MCP stdio channel) and the loop continues.
 *
 * Idempotent in the sense that calling twice would create two parallel
 * loops; the caller (`index.ts`) wires this once at startup.
 */
let codexHeartbeatTimer = null;
// gh#866 item 3: a one-shot deferred re-arm scheduled by the ENOENT teardown
// path so a mid-session app-server restart self-heals within the session (see
// onCodexAppServerSocketDead). null when no re-arm is pending.
let codexReArmTimer = null;
// Re-arm delay = one tick cadence: closes the mid-session permanent-deaf gap to
// a single-cadence window (== the no-teardown baseline) without busy-probing a
// dead socket. Overridable for tests.
let codexReArmDelayMs = CODEX_HEARTBEAT_CADENCE_MS;
/**
 * gh#857 WI-2: start the codex /loop-equivalent heartbeat AT MOST ONCE — a
 * re-entrant startLogStream must not leak a second interval (idempotent start).
 * No-op for claude (startCodexHeartbeat returns null on a non-codex session, so
 * no timer is ever stored). Extracted + injectable (`start`) so the production
 * wiring is unit-testable without running the real stream loop (QA e75339e7).
 */
export function ensureCodexHeartbeatStarted(start = defaultStartCodexHeartbeat) {
    if (codexHeartbeatTimer)
        return; // already started → don't leak a second timer
    codexHeartbeatTimer = start();
}
/**
 * Production heartbeat start: schedule the codex tick with the two gh#861 gates
 * wired from the stream loop's own state —
 *  - finding 2: `isStreamOwner` mirrors the per-entry path's lease-silencing so a
 *    lease-LOSING duplicate child never injects;
 *  - finding 3: `onAppServerSocketDead` tears the timer down when the tick finds
 *    the app-server socket gone, then schedules a one-shot deferred re-arm
 *    (gh#866 item 3) so a mid-session restart self-heals — see
 *    onCodexAppServerSocketDead.
 */
function defaultStartCodexHeartbeat() {
    return startCodexHeartbeat({
        tick: () => void fireCodexHeartbeatTick({
            isStreamOwner: () => streamState.ownership?.state === 'owner',
            onAppServerSocketDead: onCodexAppServerSocketDead,
        }),
    });
}
/**
 * gh#866 item 3: the tick's ENOENT (positively-dead app-server socket) teardown
 * handler. The recurring timer is torn down (gh#861 finding 3 — don't keep
 * ticking against a dead socket), BUT because the only other re-arm site is the
 * runLoop top — unreachable while `streamOnce` holds the connected SSE session,
 * which can outlive an app-server restart — we ALSO schedule a one-shot deferred
 * re-arm. A transient ENOENT (codex app-server restart) therefore self-heals
 * within the session instead of leaving the seat permanently deaf until the next
 * reconnect. The re-armed timer's first tick re-probes: still dead → tears down +
 * reschedules (a gentle one-cadence probe loop); alive → resumes normal cadence.
 * Distinct from the runLoop cube-cleared teardown, which calls stopCodexHeartbeat
 * directly and is correctly re-armed by runLoop when an active cube returns.
 */
function onCodexAppServerSocketDead() {
    stopCodexHeartbeat();
    scheduleCodexHeartbeatReArm();
}
/**
 * Schedule a single deferred re-arm of the codex heartbeat (gh#866 item 3).
 * Idempotent: a re-arm already pending is not stacked. The timer is unref'd so
 * it never alone keeps the process alive.
 */
function scheduleCodexHeartbeatReArm(delayMs = codexReArmDelayMs) {
    if (codexReArmTimer)
        return; // a re-arm is already pending → don't stack
    codexReArmTimer = setTimeout(() => {
        codexReArmTimer = null;
        ensureCodexHeartbeatStarted();
    }, delayMs);
    codexReArmTimer.unref?.();
}
/**
 * gh#861 finding 3: tear down the codex heartbeat timer — the teardown seam for
 * the periodic interval. Called when the active cube is cleared (nothing to inject
 * into) or the tick detects a dead app-server socket. Also clears any pending
 * deferred re-arm (gh#866 item 3) so a cube-cleared teardown doesn't leave a
 * stray re-arm queued. Re-armable: ensureCodexHeartbeatStarted starts a fresh
 * timer once an active cube returns.
 */
export function stopCodexHeartbeat() {
    if (codexHeartbeatTimer)
        clearInterval(codexHeartbeatTimer);
    codexHeartbeatTimer = null;
    if (codexReArmTimer)
        clearTimeout(codexReArmTimer);
    codexReArmTimer = null;
}
/** Test-only alias of the production teardown seam (re-testable idempotence). */
export function __resetCodexHeartbeatForTest() {
    stopCodexHeartbeat();
    codexReArmDelayMs = CODEX_HEARTBEAT_CADENCE_MS;
}
/**
 * Test-only override of the gh#866-item3 deferred re-arm delay so the
 * mid-session re-arm lifecycle is drivable with a tiny real delay instead of the
 * 20-minute cadence. Reset by __resetCodexHeartbeatForTest.
 * @internal
 */
export function __setCodexReArmDelayForTest(ms) {
    codexReArmDelayMs = ms;
}
/** The forever stream loop (extracted so startLogStream's wiring is testable). */
function runStreamLoopForever() {
    void (async () => {
        while (true) {
            try {
                await runLoop();
                process.stderr.write('[borg-mcp log stream] runLoop returned unexpectedly; restarting in 5s\n');
            }
            catch (err) {
                process.stderr.write(`[borg-mcp log stream] runLoop threw: ${err?.message ?? err}; restarting in 5s\n`);
            }
            streamState.runLoopRestartCount += 1;
            await sleep(5000);
        }
    })();
}
export function startLogStream(opts = {}) {
    // gh#857 WI-2: start the codex heartbeat (independent periodic drain backstop),
    // guarded so a re-entrant call can't leak a second interval. Lives for the
    // child's life, runs regardless of SSE connection state.
    ensureCodexHeartbeatStarted();
    // The forever loop is injectable so tests can pin THIS wiring (the heartbeat
    // start above) without spawning the real network/keychain loop (QA 75f18e8f).
    (opts.runForever ?? runStreamLoopForever)();
}
const defaultDeps = {
    fetchImpl: globalThis.fetch.bind(globalThis),
    appendLine: defaultAppendLine,
    hasInboxEntryId: defaultHasInboxEntryId,
    getToken: getValidToken,
    wakeCodex: wakeCodexViaAppServer,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    hwmDivergenceGraceMs: HWM_DIVERGENCE_GRACE_MS,
    abortSignal: new AbortController().signal,
    ownerDeps: {},
    ownerStaleMs: 70_000,
    onInboxReceipt: defaultOnInboxReceipt,
    injectOpenCode: (text) => _moduleInjectOpenCode ? _moduleInjectOpenCode(text) : Promise.resolve(false),
};
/**
 * gh#541 WU-2 default receipt handler: record the wake-path receipt watermark
 * and fire a best-effort health beat below the agent classifier. Reuses the
 * SSE session's already-fetched token (no extra keychain read) and the cached
 * monitor-health from the periodic tick (no pgrep per inbound entry).
 */
function defaultOnInboxReceipt(active, token) {
    recordEventReceipt();
    void emitHealthBeat(active, {
        sseConnected: true,
        inboxMonitorHealthy: getCachedMonitorHealthy(),
        // gh#633: reuse the cached transport-agnostic wake-armed from the periodic
        // tick (no bridge/Monitor re-probe per inbound entry).
        wakeArmed: getCachedWakeArmed(),
        // gh#634: live runtime agent_kind (cheap env read, constant per session).
        agentKind: resolveSessionAgentKind(),
        hostname: resolveRuntimeHostname(),
        version: getPackageVersion(),
        getToken: async () => token,
        // The beat rides the real global fetch — its OWN child-process HTTP wire,
        // independent of the SSE stream's (possibly test-injected) fetchImpl.
        fetchImpl: globalThis.fetch.bind(globalThis),
    });
}
async function runLoop(testDeps = {}) {
    const _getActiveCube = testDeps.getActiveCube ?? getActiveCube;
    const _acquireStreamLease = testDeps.acquireStreamLease ?? acquireStreamLease;
    const _sleep = testDeps.sleep ?? sleep;
    const _maxIterations = testDeps.maxIterations ?? Infinity;
    let _iterations = 0;
    let attempt = 0;
    let lastEventId = null;
    let currentCubeId = null;
    let lease = null;
    let leaseKey = null;
    while (_iterations < _maxIterations) {
        _iterations += 1;
        const active = await _getActiveCube();
        if (!active) {
            if (lease) {
                await lease.release();
                lease = null;
                leaseKey = null;
            }
            streamState.connected = false;
            streamState.ownership = { state: 'unowned' };
            // gh#861 finding 3: active cube cleared → tear down the codex heartbeat
            // (nothing to inject into); re-armed below once an active cube returns.
            stopCodexHeartbeat();
            await _sleep(5000);
            continue;
        }
        // gh#861 finding 3: an active cube is present → ensure the codex heartbeat is
        // running. Idempotent (no-op when already armed); re-arms after a prior
        // teardown (cube-cleared / dead app-server socket).
        ensureCodexHeartbeatStarted();
        // Reset resume cursor on cube switch — entries from a prior cube
        // mean nothing for the new cube's stream.
        if (active.cubeId !== currentCubeId) {
            currentCubeId = active.cubeId;
            lastEventId = null;
        }
        const nextLeaseKey = `${active.cubeId}:${active.droneId}`;
        if (lease && leaseKey !== nextLeaseKey) {
            await lease.release();
            lease = null;
            leaseKey = null;
        }
        if (!lease) {
            lease = await _acquireStreamLease(active.cubeId, active.droneId);
            leaseKey = lease ? nextLeaseKey : null;
        }
        if (!lease) {
            streamState.connected = false;
            streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId);
            await _sleep(5000);
            continue;
        }
        streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId);
        let ownerLost = false;
        try {
            const ownerAbort = new AbortController();
            const refresh = async () => {
                try {
                    if (!(await lease.refresh())) {
                        ownerLost = true;
                        ownerAbort.abort(new Error('stream ownership lost'));
                    }
                }
                catch (err) {
                    ownerLost = true;
                    ownerAbort.abort(err instanceof Error ? err : new Error(String(err)));
                }
            };
            const refreshTimer = setInterval(() => {
                void refresh();
            }, Math.max(1000, Math.floor(HEARTBEAT_TIMEOUT_MS / 2)));
            try {
                await streamOnce(active, lastEventId, (id) => {
                    lastEventId = id;
                }, { abortSignal: ownerAbort.signal });
            }
            finally {
                clearInterval(refreshTimer);
            }
            if (ownerLost) {
                lease = null;
                leaseKey = null;
                streamState.connected = false;
                streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId);
                await _sleep(5000);
                continue;
            }
            // Clean disconnect (e.g. server-side rollout). Reset backoff.
            attempt = 0;
            streamState.reconnectAttempts = 0;
        }
        catch (err) {
            if (ownerLost) {
                lease = null;
                leaseKey = null;
                streamState.connected = false;
                streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId);
                await _sleep(5000);
                continue;
            }
            // gh#877 Path-B (B25): an authoritative DRONE_EVICTED is TERMINAL — the
            // seat is gone. Stop reconnecting (do NOT back off and retry forever
            // against a dead seat); release the lease and return so the child's SSE
            // loop quiesces cleanly. The agent's graceful shutdown (TaskStop Monitor,
            // no /loop reschedule) is driven separately by the EVICTED tool-result it
            // already received on the authed call that produced this verdict.
            if (err instanceof DroneEvictedError) {
                if (lease)
                    await lease.release().catch(() => { });
                lease = null;
                leaseKey = null;
                streamState.connected = false;
                streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId);
                process.stderr.write(`[borg-mcp log stream] drone evicted — stream terminated (no reconnect).\n`);
                return;
            }
            streamState.connected = false;
            const delay = Math.min(RECONNECT_MIN_MS * 2 ** attempt, RECONNECT_MAX_MS) +
                Math.random() * 500;
            process.stderr.write(`[borg-mcp log stream] reconnect in ${Math.round(delay)}ms: ${err?.message ?? err}\n`);
            attempt += 1;
            streamState.reconnectAttempts = attempt;
            await _sleep(delay);
        }
    }
}
/**
 * Test-only entry to the bounded form of runLoop (gh#866 item 2). Drives a
 * fixed number of iterations with injected deps so the heartbeat teardown
 * (cleared cube → `stopCodexHeartbeat`) and re-arm (active cube →
 * `ensureCodexHeartbeatStarted`) seams are exercisable without real
 * network/keychain IO. Never called in production.
 *
 * @internal — test-only surface; mirrors the `__…ForTest` convention used by
 * `__resetStreamStateForTest` / `__resetCodexHeartbeatForTest`.
 */
export function __runLoopForTest(testDeps) {
    return runLoop(testDeps);
}
export async function streamOnce(active, lastEventId, onEventId, deps = {}) {
    const { fetchImpl, appendLine, hasInboxEntryId, getToken, wakeCodex, heartbeatTimeoutMs, hwmDivergenceGraceMs, abortSignal, onInboxReceipt, injectOpenCode, } = { ...defaultDeps, ...deps };
    const isLocal = active.serverTrustIdentity !== undefined;
    // An environment-selected BORG_API_URL is routing configuration, not proof
    // of Borg Cloud authority. A drone session aimed anywhere except the
    // canonical hosted origin must carry hydrated local trust before either the
    // OAuth token getter or the SSE transport is touched.
    if (!isLocal && !isCanonicalHostedApiUrl(active.apiUrl)) {
        throw new Error('Selected Borg server authority state is missing or unreadable');
    }
    const token = isLocal ? active.sessionToken : await getToken();
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        ...(isLocal ? {} : { 'X-Drone-Session': active.sessionToken }),
    };
    if (lastEventId && !isLocal)
        headers['Last-Event-ID'] = lastEventId;
    let requestFetch = fetchImpl;
    let streamPath = '/api/drone/stream';
    if (isLocal) {
        if (deps.fetchImpl === undefined) {
            const trust = await loadBorgServerTrust(active.apiUrl);
            if (trust.identity !== active.serverTrustIdentity) {
                throw new Error('Borg server trust identity changed; refusing the stream');
            }
            requestFetch = trust.fetchImpl;
        }
        const cursor = await getLocalServerCursor({
            origin: active.apiUrl,
            trustIdentity: active.serverTrustIdentity,
            cubeId: active.cubeId,
            droneId: active.droneId,
        });
        const query = cursor ? `?cursor=${encodeURIComponent(encodeLocalServerCursor(cursor))}` : '';
        streamPath = `/api/cubes/${active.cubeId}/stream${query}`;
    }
    const ac = new AbortController();
    const abortFromExternal = () => {
        try {
            ac.abort(abortSignal.reason ?? new Error('external abort'));
        }
        catch {
            // ignore
        }
    };
    if (abortSignal.aborted)
        abortFromExternal();
    abortSignal.addEventListener('abort', abortFromExternal, { once: true });
    // Heartbeat watchdog: if no event of any type arrives within
    // heartbeatTimeoutMs, abort the request so the outer loop reconnects.
    let watchdog = null;
    const bumpWatchdog = () => {
        if (watchdog)
            clearTimeout(watchdog);
        watchdog = setTimeout(() => {
            try {
                ac.abort(new Error('heartbeat watchdog timeout'));
            }
            catch {
                // ignore
            }
        }, heartbeatTimeoutMs);
    };
    bumpWatchdog();
    // Local mirror of the resume cursor, updated AFTER each successful
    // disk write (or dedup-recognized replay). Heartbeat-hwm comparison
    // reads this value.
    let lastPersistedEventId = lastEventId;
    let lastBroadcastHwm = null;
    let pendingHwmDivergence = null;
    const clearPendingHwmDivergence = () => {
        if (!pendingHwmDivergence)
            return;
        clearTimeout(pendingHwmDivergence.timer);
        pendingHwmDivergence = null;
    };
    // gh#402 replay-storm amplifier fix (c80b1aaa #1): advance the resume cursor
    // MONOTONICALLY by (created_at, id). An out-of-order older broadcast (or a
    // catchup replay of an older entry) must NOT regress lastPersistedEventId —
    // a regressed resume cursor widens the next reconnect's catchup window and
    // re-replays entries (the tail -F storm). Reuses compareBroadcastHwm
    // ((created_at,id) tiebreak), the SAME key the server orders broadcasts by.
    //
    // FAIL-OPEN on a missing created_at: every real SSE payload carries a
    // non-empty created_at (EnrichedEntry / ack / heartbeat-hwm all guarantee
    // it server-side), so the guard engages for every production event. But an
    // absent/empty created_at is NOT ordinally comparable (UUID ids aren't
    // either — see the dedup branch), so we only BLOCK a regression we can
    // PROVE: both the incoming entry and the current cursor carry a real
    // created_at AND the incoming is older-or-equal. Otherwise ADVANCE —
    // freezing the resume cursor on a fresh forward entry that happens to lack
    // a created_at would itself widen the next reconnect's window (the very
    // storm this fixes). Proven older-or-equal events are still recorded in
    // recentIds for dedup but do not move the cursor or re-fire onEventId.
    let lastPersistedHwm = null;
    const markEventPersisted = (id, createdAt) => {
        const next = { id, created_at: createdAt };
        if (lastPersistedHwm &&
            createdAt &&
            lastPersistedHwm.created_at &&
            compareBroadcastHwm(next, lastPersistedHwm) <= 0) {
            return;
        }
        lastPersistedHwm = next;
        lastPersistedEventId = id;
        streamState.lastPersistedEventId = id;
        onEventId(id);
    };
    const markBroadcastPersisted = (hwm) => {
        if (!hwm)
            return;
        lastBroadcastHwm =
            !lastBroadcastHwm || compareBroadcastHwm(hwm, lastBroadcastHwm) > 0
                ? hwm
                : lastBroadcastHwm;
        if (pendingHwmDivergence &&
            compareBroadcastHwm(lastBroadcastHwm, pendingHwmDivergence.hwm) >= 0) {
            clearPendingHwmDivergence();
        }
    };
    const scheduleHwmDivergenceReconnect = (hwm) => {
        if (pendingHwmDivergence?.hwm.id === hwm.id)
            return;
        clearPendingHwmDivergence();
        const timer = setTimeout(() => {
            if (lastBroadcastHwm && compareBroadcastHwm(lastBroadcastHwm, hwm) >= 0) {
                clearPendingHwmDivergence();
                return;
            }
            try {
                ac.abort(new Error('hwm divergence — reconnect for catchup'));
            }
            catch {
                // ignore
            }
        }, hwmDivergenceGraceMs);
        pendingHwmDivergence = { hwm, timer };
    };
    // Bounded recent-id set for replay-on-reconnect dedup per spec §(3).
    // Set + FIFO array for O(1) membership + bounded memory.
    const recentIds = new Set();
    const recentIdsOrder = [];
    let isCatchingUp = lastEventId !== null;
    // gh#29 quality-stream (#5): shared inbox-write + cursor-advance helpers,
    // extracted from the previously-duplicated ack / regular-log branches in the
    // event loop below. Behavior-preserving — the per-branch comments document
    // the load-bearing semantics each path relies on.
    // Format + (catchup-dedup-aware) append the entry's inbox line.
    // LOAD-BEARING ORDER: the disk write must complete before the cursor
    // advances (recordSeen), so an append failure (disk full, EACCES, path race
    // during cube switch) replays the entry on reconnect rather than being
    // skipped past by an already-advanced Last-Event-ID — the §(3) durability
    // contract. Returns 'persisted-skip' when the entry is already on disk from
    // an earlier catchup receive (caller advances the cursor via markEventPersisted
    // here, then continues WITHOUT re-recording); 'written' after a fresh append.
    const writeInboxLine = async (ev) => {
        const line = formatInboxLine(withSseEventId(ev.data, ev.id));
        if (isCatchingUp &&
            // gh#441: pass the rendered line so the dedup can also recognize LEGACY
            // (no-entry_id-prefix) on-disk lines, not just the [entry_id:] marker.
            (await hasInboxEntryId(active.cubeId, active.droneId, ev.id, line))) {
            markEventPersisted(ev.id, ev.data?.created_at ?? '');
            return 'persisted-skip';
        }
        // gh#opencode: try autonomous opencode injection first. When the drone's
        // child session processes entries directly, skip the inbox write (the
        // Monitor/tail-F path is unused for opencode). Falls through to inbox on
        // failure so the entry is never lost.
        if (await injectOpenCode(line)) {
            if (!isLocal || deps.onInboxReceipt !== undefined)
                onInboxReceipt(active, token);
            return 'written';
        }
        await appendLine(active.cubeId, active.droneId, line);
        wakeCodex(formatCodexWakePrompt(line));
        // gh#541 WU-2: a fresh inbound entry just hit the inbox (the wake-path
        // receipt). Record it + beat below the classifier (best-effort).
        if (!isLocal || deps.onInboxReceipt !== undefined)
            onInboxReceipt(active, token);
        return 'written';
    };
    // Record the event in the bounded recent-ids dedup set (FIFO-capped) and
    // advance both cursors. The broadcast-HWM cursor advances via
    // broadcastHwmFromLogEvent, which returns null for visibility==='direct' and
    // kind==='ack' (those do NOT advance the server's DO broadcast HWM either —
    // D6), so it advances ONLY for broadcast entries. gh#402 replay-storm fix
    // (583aed7e): this runs for OWN-POST broadcasts too — the author's own
    // broadcast IS counted by the server HWM, so the client broadcast cursor
    // must advance to match; otherwise the next heartbeat reads server-hwm >
    // client-cursor and fires a spurious divergence-reconnect (the storm
    // trigger). The null-for-direct/ack guard keeps own-direct echoes correct.
    const recordSeen = async (ev) => {
        recentIds.add(ev.id);
        recentIdsOrder.push(ev.id);
        while (recentIdsOrder.length > RECENT_IDS_CAP) {
            const oldId = recentIdsOrder.shift();
            if (oldId)
                recentIds.delete(oldId);
        }
        markEventPersisted(ev.id, ev.data?.created_at ?? '');
        markBroadcastPersisted(broadcastHwmFromLogEvent(ev));
        if (isLocal && ev.cursor) {
            await advanceLocalServerCursor({
                origin: active.apiUrl,
                trustIdentity: active.serverTrustIdentity,
                cubeId: active.cubeId,
                droneId: active.droneId,
            }, ev.cursor);
        }
    };
    let response;
    try {
        response = await requestFetch(`${active.apiUrl}${streamPath}`, {
            method: 'GET',
            headers,
            signal: ac.signal,
        });
    }
    catch (err) {
        if (watchdog)
            clearTimeout(watchdog);
        throw err;
    }
    if (!response.ok || !response.body) {
        if (watchdog)
            clearTimeout(watchdog);
        // gh#877 Path-B (stream bootstrap): an evicted drone's stream re-subscribe
        // returns the authoritative 410 DRONE_EVICTED. Surface it as the terminal
        // typed error so the reconnect loop stops retrying (B25) instead of backing
        // off forever against a dead seat. Keyed on the structured code, not the
        // bare status (SEC R2). 423/DRONE_FROZEN is NOT terminal here — it falls
        // through to the generic throw so the loop keeps reconnecting (resumes when
        // billing is restored).
        if (response.status === 410) {
            const body = isLocal
                ? await readBoundedResponseBody(response, LOCAL_SERVER_SSE_FRAME_LIMIT_BYTES, 'Local Borg server SSE response exceeded the response limit', ac.signal).catch(() => '')
                : await response.text().catch(() => '');
            if (errorCodeFromBody(body) === DRONE_EVICTED_CODE) {
                throw new DroneEvictedError();
            }
        }
        throw new Error(`stream HTTP ${response.status}`);
    }
    streamState.connected = true;
    try {
        for await (const event of parseSSE(response.body, isLocal ? LOCAL_SERVER_SSE_FRAME_LIMIT_BYTES : undefined)) {
            bumpWatchdog();
            const nowIso = new Date().toISOString();
            streamState.lastWireActivityAt = nowIso;
            // Content vs wire split (T1.2): content freshness is what a reader
            // skimming the top-line verdict actually cares about. Heartbeats
            // bump wire-activity only; log and bookmark events bump both.
            if (event.type === 'log' || event.type === 'bookmark') {
                streamState.lastContentEventAt = nowIso;
            }
            // gh#877 Path-A: terminal eviction control frame. Handled EARLY (before
            // log/heartbeat) so a replayed frame on reconnect still fires. This is a
            // WAKE HINT with ZERO authority (SEC R2): write a sentinel line to the
            // inbox file so the (possibly asleep) agent's Monitor wakes it, then close
            // this stream. The agent CONFIRMS via an authed call that returns 410
            // DRONE_EVICTED before tearing down — a spurious frame on a live seat is
            // inert (the confirm returns normally). We do NOT terminate the agent here
            // (the client process cannot reach the agent loop); we only deliver the
            // wake. The reconnect's stream-bootstrap 410 (authoritative) is what flips
            // this loop terminal below.
            if (event.type === 'eviction') {
                streamState.lastContentEventAt = nowIso;
                try {
                    await appendLine(active.cubeId, active.droneId, formatEvictionSentinelLine(event.reason));
                }
                catch {
                    // Inbox write failed — the Path-B 410 backstop still tears the drone
                    // down on its next authed call. Best-effort wake only.
                }
                // Close this SSE session; the reconnect will hit the authoritative 410.
                break;
            }
            if (event.type === 'heartbeat') {
                streamState.lastHeartbeatAt = nowIso;
                // First/baseline heartbeat absorb: until this session has seen
                // a broadcast entry, the server's broadcast HWM is our baseline.
                // Direct messages may advance the persistence cursor past this
                // value; directional comparison must not treat that mirror case
                // as missed-broadcast evidence.
                if (event.hwm && lastBroadcastHwm === null) {
                    markBroadcastPersisted(event.hwm);
                    if (lastPersistedEventId === null) {
                        markEventPersisted(event.hwm.id, event.hwm.created_at);
                    }
                    continue;
                }
                if (event.hwm &&
                    lastBroadcastHwm &&
                    compareBroadcastHwm(event.hwm, lastBroadcastHwm) <= 0) {
                    clearPendingHwmDivergence();
                    continue;
                }
                // §(5) divergence-detection: reconnect only when the server's
                // broadcast HWM is AHEAD of the client's broadcast cursor. A
                // recipient persisting a direct entry legitimately advances
                // lastPersistedEventId beyond the broadcast HWM; strict
                // inequality would reintroduce gh#402 churn for that mirror case.
                if (event.hwm &&
                    lastBroadcastHwm &&
                    compareBroadcastHwm(event.hwm, lastBroadcastHwm) > 0) {
                    scheduleHwmDivergenceReconnect(event.hwm);
                }
                continue;
            }
            if (event.type === 'bookmark') {
                isCatchingUp = false;
                continue;
            }
            if (event.type === 'log') {
                // DEDUP per §(3) recent-ids contract: an out-of-order DO
                // broadcast followed by reconnect+catchup can replay an entry
                // we already persisted. The entry IS on disk from an earlier
                // receive in this session — just not from THIS iteration's
                // appendLine. So we skip the duplicate write AND advance the
                // cursor (so the heartbeat-hwm comparison converges and so
                // Last-Event-ID on the next reconnect reflects the highest
                // id we've actually got persisted). UUIDs are not ordinally
                // comparable with created_at, so set membership is the check.
                if (recentIds.has(event.id)) {
                    markEventPersisted(event.id, event.data?.created_at ?? '');
                    markBroadcastPersisted(broadcastHwmFromLogEvent(event));
                    continue;
                }
                // OWN-DRONE FILTER: restore the silent-self property — parity
                // with pre-cutover inbox.ts:87-88. The DO broadcasts every
                // entry to every connected drone INCLUDING the originator;
                // without this skip, posting a log entry would wake the
                // posting drone on its own message (visible via Monitor on
                // the inbox file). The entry IS on disk (we wrote it via
                // appendLog), so skip the inbox echo but still advance the
                // cursor + record in recentIds so heartbeat-hwm comparison
                // converges and the next reconnect's Last-Event-ID reflects
                // the highest id we've actually got persisted. Structurally
                // identical to the dedup branch above — same "skip write,
                // advance state" shape, different trigger condition.
                //
                // HEARTBEAT-PING CARVE-OUT (gh#71): the gh#39 cron watchdog
                // authors heartbeat-pings WITH the silent target as drone_id
                // so each ping is attributed to the drone it intends to wake.
                // Without this carve-out, the own-drone filter would silently
                // skip the target's own ping → inbox file never written →
                // Monitor never fires → the platform-level wake guarantee is
                // broken for the cube-wide-silent class gh#39 was designed to
                // prevent. We let heartbeat-pings authored "by" the target
                // drone through the disk-write path; the existing rate-limit
                // in the server heartbeat contract (max 1 ping per drone per ~1h)
                // bounds the silent-self property's relaxation.
                const isHeartbeatPing = typeof event.data?.message === 'string' &&
                    event.data.message.startsWith('[HEARTBEAT-PING]');
                // Sprint 26 ack-fan-out: ack events have `kind: 'ack'` plus an
                // `author_drone_id` field naming the recipient (the author of
                // the entry that got acked). Only the author writes the ack
                // line to their inbox — all other subscribers drop the event
                // but still advance the cursor. The legacy entry-shaped fields
                // on the ack payload exist for pre-Sprint-26 clients that
                // don't recognize the `kind` discriminator; new clients route
                // here BEFORE the legacy own-drone filter so the ack-specific
                // semantic takes precedence.
                if (event.data?.kind === 'ack') {
                    if (event.data?.author_drone_id === active.droneId) {
                        if ((await writeInboxLine(event)) === 'persisted-skip')
                            continue;
                    }
                    await recordSeen(event);
                    continue;
                }
                if (event.data?.drone_id === active.droneId && !isHeartbeatPing) {
                    // Own post: silent-self (no inbox echo — already on disk via
                    // appendLog). recordSeen still advances BOTH cursors, including the
                    // broadcast cursor for an own broadcast — see recordSeen's gh#402
                    // (583aed7e) note for why skipping it here would storm.
                    await recordSeen(event);
                    continue;
                }
                // Regular inbound entry: write the inbox line (catchup-dedup aware),
                // then advance both cursors.
                if ((await writeInboxLine(event)) === 'persisted-skip')
                    continue;
                await recordSeen(event);
            }
        }
    }
    finally {
        abortSignal.removeEventListener('abort', abortFromExternal);
        if (watchdog)
            clearTimeout(watchdog);
        clearPendingHwmDivergence();
        streamState.connected = false;
    }
}
export async function streamOnceIfOwner(active, lastEventId, onEventId, deps = {}) {
    const { ownerDeps, ownerStaleMs } = { ...defaultDeps, ...deps };
    const lease = await acquireStreamLease(active.cubeId, active.droneId, ownerStaleMs, ownerDeps);
    if (!lease) {
        streamState.connected = false;
        streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId, ownerDeps);
        return 'skipped';
    }
    streamState.ownership = await readOwnershipSnapshot(active.cubeId, active.droneId, ownerDeps);
    try {
        await streamOnce(active, lastEventId, onEventId, deps);
        return 'streamed';
    }
    finally {
        await lease.release();
    }
}
/**
 * Async generator over an SSE response body. Yields one ParsedEvent
 * per "event:/data:" block (separated by blank lines per RFC 5234).
 *
 * Exported so tests can pump a synthetic ReadableStream through it.
 */
export async function* parseSSE(body, maxFrameBytes) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let bufferBytes = 0;
    const appendFragment = (fragment) => {
        const nextBytes = bufferBytes + Buffer.byteLength(fragment, 'utf8');
        if (maxFrameBytes !== undefined && nextBytes > maxFrameBytes) {
            throw new Error('Local Borg server SSE frame exceeded the response limit');
        }
        buffer += fragment;
        bufferBytes = nextBytes;
    };
    const drainText = function* (text) {
        let remaining = text;
        while (remaining.length > 0) {
            // Preserve a terminator split across two stream chunks without ever
            // allowing the retained partial frame itself to grow past the cap.
            if (buffer.endsWith('\n') && remaining.startsWith('\n')) {
                buffer = buffer.slice(0, -1);
                bufferBytes = Buffer.byteLength(buffer, 'utf8');
                remaining = remaining.slice(1);
                const parsed = parseEventBlock(buffer);
                buffer = '';
                bufferBytes = 0;
                if (parsed)
                    yield parsed;
                continue;
            }
            const idx = remaining.indexOf('\n\n');
            if (idx === -1) {
                appendFragment(remaining);
                return;
            }
            appendFragment(remaining.slice(0, idx));
            remaining = remaining.slice(idx + 2);
            const parsed = parseEventBlock(buffer);
            buffer = '';
            bufferBytes = 0;
            if (parsed)
                yield parsed;
        }
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                const tail = decoder.decode();
                if (tail) {
                    for (const parsed of drainText(tail))
                        yield parsed;
                }
                if (buffer.trim()) {
                    const parsed = parseEventBlock(buffer);
                    if (parsed)
                        yield parsed;
                }
                return;
            }
            for (const parsed of drainText(decoder.decode(value, { stream: true }))) {
                yield parsed;
            }
        }
    }
    catch (error) {
        await reader.cancel(error).catch(() => { });
        throw error;
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            // ignore — stream may already be closed
        }
    }
}
function parseEventBlock(block) {
    let eventName = null;
    let id = null;
    let dataLines = [];
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
            eventName = line.slice(6).trim();
        }
        else if (line.startsWith('id:')) {
            id = line.slice(3).trim();
        }
        else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trim());
        }
    }
    const dataStr = dataLines.join('\n');
    if (!eventName)
        return null;
    if (eventName === 'log') {
        if (!id)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(dataStr);
        }
        catch {
            return null;
        }
        const cursor = parsed?.cursor;
        const validCursor = cursor &&
            typeof cursor.id === 'string' &&
            typeof cursor.created_at === 'string';
        return {
            type: 'log',
            id,
            data: parsed?.entry ?? parsed,
            ...(validCursor ? { cursor } : {}),
        };
    }
    if (eventName === 'heartbeat') {
        let ts = null;
        let hwm = null;
        try {
            const parsed = JSON.parse(dataStr);
            ts = typeof parsed.ts === 'string' ? parsed.ts : null;
            hwm = parseHeartbeatHwm(parsed.hwm);
        }
        catch {
            // fall through with nulls
        }
        return { type: 'heartbeat', ts, hwm };
    }
    if (eventName === 'bookmark') {
        let as_of = null;
        try {
            const parsed = JSON.parse(dataStr);
            as_of = typeof parsed.as_of === 'string' ? parsed.as_of : null;
        }
        catch {
            // fall through with null
        }
        return { type: 'bookmark', as_of };
    }
    // gh#877 Path-A: terminal eviction control frame. Recognized explicitly so a
    // forged/garbage event type still falls through to `unknown` and no-ops (the
    // SEC R5 parser-default-ignore property is preserved).
    if (eventName === 'eviction') {
        let cube_id = null;
        let reason = null;
        try {
            const parsed = JSON.parse(dataStr);
            cube_id = typeof parsed.cube_id === 'string' ? parsed.cube_id : null;
            reason = typeof parsed.reason === 'string' ? parsed.reason : null;
        }
        catch {
            // fall through with nulls
        }
        return { type: 'eviction', cube_id, reason };
    }
    return { type: 'unknown', raw: block };
}
function parseHeartbeatHwm(value) {
    if (!value || typeof value !== 'object')
        return null;
    const candidate = value;
    return typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        typeof candidate.created_at === 'string' &&
        candidate.created_at.length > 0
        ? { id: candidate.id, created_at: candidate.created_at }
        : null;
}
function broadcastHwmFromLogEvent(event) {
    if (event.data?.visibility === 'direct' || event.data?.kind === 'ack') {
        return null;
    }
    const createdAt = event.data?.created_at;
    return typeof createdAt === 'string' && createdAt.length > 0
        ? { id: event.id, created_at: createdAt }
        : null;
}
function withSseEventId(entry, eventId) {
    if (!entry || typeof entry !== 'object')
        return { id: eventId };
    if (typeof entry.id === 'string' && entry.id.length > 0)
        return entry;
    return { ...entry, id: eventId };
}
/**
 * First argument that is a non-empty string, else ''. Used to pick the
 * inbox entry id from the server `id` field, falling back to the legacy
 * `entry_id` field. Flattens what was a nested ternary at the call site.
 */
function firstNonEmptyString(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
    }
    return '';
}
/**
 * Format one inbox-file line. Preserves the long-poll inbox.ts prefix
 * shape (`<iso-ts> <drone-label> (<role-name>): ...`) so existing
 * Monitor tail consumers and audit tooling keep parsing it.
 *
 * Newlines in the message body are joined to ` ⏎ ` (U+23CE Return Symbol,
 * space-padded) so the entire entry is one physical line in the inbox
 * file. Rationale: Claude Code's Monitor primitive consumes stdout via
 * Node `readline` — every `\n` creates a NEW notification event, so a
 * multi-line cube-log entry would fire multiple notifications with only
 * the first line being a recognized entry-start (the rest dropped by
 * `formatEventLine`'s regex). Joining at write time delivers the full
 * entry content in a single notification body. Drones recognize ⏎ as
 * "newline was here" — convention noted in the regen-format playbook.
 */
export function formatInboxLine(entry) {
    const ts = typeof entry.created_at === 'string'
        ? new Date(entry.created_at).toISOString()
        : new Date().toISOString();
    const label = entry.drone_label ?? '?';
    const role = entry.role_name ?? '?';
    const rawMessage = typeof entry.message === 'string' ? entry.message : '';
    // Server `id`, else legacy `entry_id`, else '' (behavior-identical to the
    // prior nested ternary).
    const entryId = firstNonEmptyString(entry.id, entry.entry_id);
    const idPrefix = entryId ? `[entry_id: ${entryId}] ` : '';
    // Normalize \r\n, \r, and \n all to ` ⏎ ` so the entry fits on one
    // physical line regardless of line-ending convention in the source.
    const message = rawMessage.replace(/\r\n|\r|\n/g, ' ⏎ ');
    return `${ts} ${label} (${role}): ${idPrefix}${message}`;
}
/**
 * gh#877 Path-A: format the terminal-eviction WAKE SENTINEL line written to the
 * inbox file. Same one-physical-line shape as formatInboxLine so the existing
 * `borg-inbox-monitor` tail recognizes it and fires a notification that wakes
 * the agent. The `[CUBE-EVICTED]` marker is a WAKE HINT only — the agent must
 * CONFIRM via an authed borg_* call returning 410 DRONE_EVICTED before tearing
 * down (so a peer posting sentinel-shaped log text can't force a false
 * shutdown of a live seat — SEC R2 / QA log-content-plane forgery guard).
 */
export function formatEvictionSentinelLine(reason) {
    const ts = new Date().toISOString();
    const detail = reason && reason.trim().length > 0 ? reason : 'evicted from cube';
    return (`${ts} SYSTEM (eviction): ${EVICTED_RESULT_MARKER} ${detail} — ` +
        `confirm with any borg_* call; on DRONE_EVICTED (410) shut down: ` +
        `print the terminal message, TaskStop the inbox Monitor, do NOT reschedule /loop.`);
}
async function defaultAppendLine(cubeId, droneId, line) {
    const p = inboxPathForDrone(cubeId, droneId);
    await appendCappedInboxLine(p, line, INBOX_TAIL_LINES_CAP);
}
export async function appendCappedInboxLine(inboxPath, line, maxLines = INBOX_TAIL_LINES_CAP, trimThresholdLines = maxLines * 2) {
    await fs.mkdir(path.dirname(inboxPath), { recursive: true });
    await fs.appendFile(inboxPath, line + '\n', 'utf-8');
    await trimInboxFileToRecentLines(inboxPath, maxLines, trimThresholdLines);
}
export async function trimInboxFileToRecentLines(inboxPath, maxLines, trimThresholdLines = maxLines) {
    if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new Error('maxLines must be a positive integer');
    }
    if (!Number.isInteger(trimThresholdLines) ||
        trimThresholdLines < maxLines) {
        throw new Error('trimThresholdLines must be an integer >= maxLines');
    }
    const raw = await fs.readFile(inboxPath, 'utf-8');
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === '')
        lines.pop();
    if (lines.length <= trimThresholdLines)
        return;
    const kept = lines.slice(-maxLines);
    const tmpPath = path.join(path.dirname(inboxPath), `.${path.basename(inboxPath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(tmpPath, kept.join('\n') + '\n', 'utf-8');
        await fs.rename(tmpPath, inboxPath);
    }
    catch (err) {
        await fs.rm(tmpPath, { force: true });
        throw err;
    }
}
/**
 * @internal Exported for unit tests.
 *
 * Decide whether `raw` (the full inbox-file contents) already contains the
 * entry identified by `entryId` / rendered as `renderedLine`. Robust to BOTH
 * on-disk line formats (gh#441 — catchup-replay-flood fix):
 *   - NEW format (0.9.39+): `…: [entry_id: <id>] <message>` — matched by the
 *     `[entry_id: <id>]` marker (the #412 dedup, preserved verbatim).
 *   - LEGACY format (pre-0.9.39 / old ACK lines): `…: <message>` with NO
 *     entry_id prefix — matched by an EXACT, line-anchored comparison against
 *     the entry's legacy rendering (`renderedLine` with the id-prefix stripped).
 *
 * Why this exists: a worker DEPLOY evicts the LogBroadcaster DO → every drone's
 * SSE drops → fleet-wide simultaneous reconnect → catchup. The old substring
 * check (`raw.includes('[entry_id: <id>]')`) missed legacy lines, so catchup
 * re-appended them → tail -F replay flood.
 *
 * The legacy match is LINE-ANCHORED (exact line equality), NOT a substring
 * match, on purpose: a substring match would false-positive-DROP a genuinely
 * new entry whose message merely EXTENDS an existing line (e.g. `…: hello` vs
 * `…: hello world`). A dropped entry is worse than a re-append — the drone
 * misses a wake — so when in doubt this fails toward re-append, never drop.
 */
export function inboxRawHasEntry(raw, entryId, renderedLine) {
    // New-format: entry_id marker (preserves the #412 dedup).
    if (entryId && raw.includes(`[entry_id: ${entryId}]`))
        return true;
    // Legacy-format: exact, line-anchored match against the id-prefix-stripped
    // rendering. `String.prototype.replace` with a string pattern strips only the
    // first (sole) prefix occurrence; entryId is treated literally (not regex).
    const legacyForm = entryId
        ? renderedLine.replace(`[entry_id: ${entryId}] `, '')
        : renderedLine;
    if (legacyForm && raw.split(/\r?\n/).includes(legacyForm))
        return true;
    return false;
}
async function defaultHasInboxEntryId(cubeId, droneId, entryId, renderedLine) {
    const p = inboxPathForDrone(cubeId, droneId);
    let raw;
    try {
        raw = await fs.readFile(p, 'utf-8');
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return false;
        throw err;
    }
    return inboxRawHasEntry(raw, entryId, renderedLine);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=log-stream.js.map