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
import { type BroadcastHwm } from 'borgmcp-shared/log-stream-hwm';
import { getActiveCube } from './cubes.js';
import { type LocalServerCursor } from './local-server-cursor.js';
import { acquireStreamLease, type StreamOwnershipSnapshot } from './stream-owner.js';
export declare const LOCAL_SERVER_SSE_FRAME_LIMIT_BYTES: number;
export declare function setModuleInjectOpenCode(fn: (text: string) => Promise<boolean>): void;
export declare const INBOX_TAIL_LINES_CAP = 512;
export declare const INBOX_TAIL_TRIM_THRESHOLD_LINES: number;
export type RunLoopHealth = 'connected' | 'reconnecting' | 'silent-inert' | 'never-started';
export interface StreamStatus {
    connected: boolean;
    lastWireActivityAt: string | null;
    lastContentEventAt: string | null;
    lastHeartbeatAt: string | null;
    lastPersistedEventId: string | null;
    reconnectAttempts: number;
    runLoopRestartCount: number;
    ownership?: StreamOwnershipSnapshot;
}
/**
 * Snapshot of the current stream status. Safe to call at any time
 * (returns a copy, does not interact with the running connection).
 */
export declare function classifyRunLoopHealth(state: StreamStatus, uptimeMs?: number): RunLoopHealth;
export declare function getStreamStatus(): StreamStatus & {
    runLoopHealth: RunLoopHealth;
};
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
export declare function __resetStreamStateForTest(): void;
/**
 * gh#857 WI-2: start the codex /loop-equivalent heartbeat AT MOST ONCE — a
 * re-entrant startLogStream must not leak a second interval (idempotent start).
 * No-op for claude (startCodexHeartbeat returns null on a non-codex session, so
 * no timer is ever stored). Extracted + injectable (`start`) so the production
 * wiring is unit-testable without running the real stream loop (QA e75339e7).
 */
export declare function ensureCodexHeartbeatStarted(start?: () => ReturnType<typeof setInterval> | null): void;
/**
 * gh#861 finding 3: tear down the codex heartbeat timer — the teardown seam for
 * the periodic interval. Called when the active cube is cleared (nothing to inject
 * into) or the tick detects a dead app-server socket. Also clears any pending
 * deferred re-arm (gh#866 item 3) so a cube-cleared teardown doesn't leave a
 * stray re-arm queued. Re-armable: ensureCodexHeartbeatStarted starts a fresh
 * timer once an active cube returns.
 */
export declare function stopCodexHeartbeat(): void;
/** Test-only alias of the production teardown seam (re-testable idempotence). */
export declare function __resetCodexHeartbeatForTest(): void;
/**
 * Test-only override of the gh#866-item3 deferred re-arm delay so the
 * mid-session re-arm lifecycle is drivable with a tiny real delay instead of the
 * 20-minute cadence. Reset by __resetCodexHeartbeatForTest.
 * @internal
 */
export declare function __setCodexReArmDelayForTest(ms: number): void;
export declare function startLogStream(opts?: {
    runForever?: () => void;
}): void;
export interface StreamDeps {
    /** Override the global fetch (tests inject a controlled Response). */
    fetchImpl?: typeof fetch;
    /** Override the inbox-line append (tests assert against the calls). */
    appendLine?: (cubeId: string, droneId: string, line: string) => Promise<void>;
    /** Override durable inbox-entry dedup (tests avoid real filesystem). */
    hasInboxEntryId?: (cubeId: string, droneId: string, entryId: string, renderedLine: string) => Promise<boolean>;
    /** Optional Codex app-server wake sink; tests inject a spy. */
    wakeCodex?: (reason: string) => void;
    /** Override the heartbeat watchdog timeout. */
    heartbeatTimeoutMs?: number;
    /** Override HWM divergence grace for focused tests. */
    hwmDivergenceGraceMs?: number;
    /** Abort the active stream when ownership is lost by another process. */
    abortSignal?: AbortSignal;
    /** Override stream-owner lock state in focused duplicate-process tests. */
    ownerDeps?: import('./stream-owner.js').StreamOwnerDeps;
    /** Override owner stale threshold in focused duplicate-process tests. */
    ownerStaleMs?: number;
    /**
     * Optional opencode entry injector for autonomous drone processing.
     * When provided AND the injection succeeds, the inbox file write is skipped
     * (the drone processes the entry autonomously). On failure, falls through
     * to the inbox write for backup.
     */
    injectOpenCode?: (text: string) => Promise<boolean>;
}
/**
 * Test-only injection seam for runLoop (gh#866 item 2). Production calls
 * `runLoop()` with no args → every dep falls back to the real import and the
 * loop runs forever, exactly as before (zero behavior change). Tests pass stubs
 * plus a `maxIterations` bound to drive a fixed number of iterations through the
 * heartbeat-lifecycle seams — teardown (`stopCodexHeartbeat` on a cleared cube)
 * and re-arm (`ensureCodexHeartbeatStarted` on an active cube) — without real
 * network/keychain IO.
 */
export interface RunLoopTestDeps {
    getActiveCube?: typeof getActiveCube;
    acquireStreamLease?: typeof acquireStreamLease;
    streamOnce?: typeof streamOnce;
    sleep?: (ms: number) => Promise<void>;
    maxIterations?: number;
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
export declare function __runLoopForTest(testDeps: RunLoopTestDeps): Promise<void>;
export interface ActiveCube {
    cubeId: string;
    droneId: string;
    sessionToken: string;
    apiUrl: string;
    serverTrustIdentity?: string;
}
export declare function streamOnce(active: ActiveCube, lastEventId: string | null, onEventId: (id: string) => void, deps?: StreamDeps): Promise<void>;
export declare function streamOnceIfOwner(active: ActiveCube, lastEventId: string | null, onEventId: (id: string) => void, deps?: StreamDeps): Promise<'streamed' | 'skipped'>;
export type ParsedEvent = {
    type: 'log';
    id: string;
    data: any;
    cursor?: LocalServerCursor;
} | {
    type: 'heartbeat';
    ts: string | null;
    hwm: BroadcastHwm | null;
} | {
    type: 'bookmark';
    as_of: string | null;
} | {
    type: 'eviction';
    cube_id: string | null;
    reason: string | null;
} | {
    type: 'unknown';
    raw: string;
};
/**
 * Async generator over an SSE response body. Yields one ParsedEvent
 * per "event:/data:" block (separated by blank lines per RFC 5234).
 *
 * Exported so tests can pump a synthetic ReadableStream through it.
 */
export declare function parseSSE(body: ReadableStream<Uint8Array>, maxFrameBytes?: number): AsyncGenerator<ParsedEvent>;
export interface EnrichedEntry {
    id?: string;
    entry_id?: string;
    created_at?: string;
    drone_label?: string | null;
    role_name?: string | null;
    message?: string;
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
export declare function formatInboxLine(entry: EnrichedEntry): string;
/**
 * gh#877 Path-A: format the terminal-eviction WAKE SENTINEL line written to the
 * inbox file. Same one-physical-line shape as formatInboxLine so the existing
 * `borg-inbox-monitor` tail recognizes it and fires a notification that wakes
 * the agent. The `[CUBE-EVICTED]` marker is a WAKE HINT only — the agent must
 * CONFIRM via an authed borg_* call returning 410 DRONE_EVICTED before tearing
 * down (so a peer posting sentinel-shaped log text can't force a false
 * shutdown of a live seat — SEC R2 / QA log-content-plane forgery guard).
 */
export declare function formatEvictionSentinelLine(reason: string | null): string;
export declare function appendCappedInboxLine(inboxPath: string, line: string, maxLines?: number, trimThresholdLines?: number): Promise<void>;
export declare function trimInboxFileToRecentLines(inboxPath: string, maxLines: number, trimThresholdLines?: number): Promise<void>;
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
export declare function inboxRawHasEntry(raw: string, entryId: string, renderedLine: string): boolean;
//# sourceMappingURL=log-stream.d.ts.map