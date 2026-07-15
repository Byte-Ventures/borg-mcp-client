#!/usr/bin/env node
/**
 * borg-inbox-monitor — per-entry pretty-printer for borgmcp inbox files.
 *
 * Per gh#8: Claude Code's task-notification title is the Monitor's
 * `description`, set once at arm-time. When the Monitor command is
 * `tail -F <inbox>`, every event's notification title is the same
 * static "Monitor event: ..." string regardless of which drone posted
 * what. Recipients have to read the body to triage.
 *
 * Replacement: tail the inbox file and emit one stdout line per cube
 * log entry, summarizing drone label + role + first ~80 chars of the
 * message body. Claude Code's Monitor batching then uses that single
 * line as the per-event task-notification title.
 *
 * Inbox file format (per src/log-stream.ts formatInboxLine):
 *   <iso-ts> <drone-label> (<role-name>): <message>
 *
 * Multi-line messages are appended as a single fs.appendFile() call
 * with embedded `\n` characters, so they become multiple physical
 * lines in the file. Continuation lines (those that don't start with
 * an ISO-8601 timestamp) are dropped — only the first line of each
 * entry surfaces, which is the part that summarizes the entry.
 *
 * Usage:
 *   borg-inbox-monitor --state-root <worktree-runtime-root> <inbox-file-path>
 *
 * The state-root form is the supported launch path. The legacy positional-only
 * form remains accepted for old hand-authored Monitor commands, and keeps its
 * inbox-adjacent sidecars for compatibility while fleets transition.
 */
export declare const RECENT_EMITTED_LINE_CAP = 1024;
export declare class RecentLineDeduper {
    private readonly cap;
    private readonly seen;
    private readonly order;
    constructor(cap?: number);
    remember(line: string): boolean;
}
/**
 * Pure: parse one inbox-file line and produce the pretty summary line
 * (or null if the line is a continuation or unrecognized shape).
 *
 * Pass-through — no truncation. Claude Code does not impose a hard cap
 * on task-notification title length. The 200-char `MAX_SUMMARY_LEN` cap
 * removed here (and the 80-char predecessor) were borg-mcp conventions
 * built on a misunderstanding of the renderer's limits. Drones now see
 * the full first line of every entry; multi-signal batched posts no
 * longer have their second signal hidden.
 *
 * Exported so tests can exercise the parsing without spawning tail.
 */
export declare function formatEventLine(inboxLine: string): string | null;
export declare function formatFreshEventLine(inboxLine: string, deduper: RecentLineDeduper): string | null;
export declare function seedDeduperFromInboxTail(inboxPath: string, deduper: RecentLineDeduper, maxLines?: number): void;
/** Holder-tracked stall state. `lastEmittedOffset` is stat-anchored. */
export interface TailStallState {
    /** Inbox file size (bytes) as of the last tail delivery; seeded to EOF at arm. */
    lastEmittedOffset: number;
    /** Epoch ms when the CURRENT un-emitted-growth streak began; null = none. */
    grewSince: number | null;
}
export type TailStallVerdict = {
    kind: 'ok';
    state: TailStallState;
} | {
    kind: 'rotation';
    state: TailStallState;
} | {
    kind: 'respawn';
    state: TailStallState;
};
/**
 * gh#822: PURE stall evaluator. Given the current inbox size + the holder's
 * stat-anchored state, decide whether the tail is healthy, rotated, or stalled.
 * False-reap-safe by construction (CR 131dcd78):
 *   - ROTATION (item 2): `inboxSize < lastEmittedOffset` ⇒ truncation/rotation —
 *     re-anchor offset to the NEW size + clear the streak; NEVER treated as
 *     negative growth, so the detector keeps working after the very rotation
 *     that triggers Subclass B.
 *   - QUIET cube: `inboxSize === lastEmittedOffset` ⇒ no un-emitted growth ⇒ ok
 *     (clears any streak). A silent cube can NEVER trip a respawn.
 *   - GREW-but-not-emitted: `inboxSize > lastEmittedOffset`. Only when that
 *     un-emitted growth PERSISTS continuously past `stallThresholdMs` ⇒ respawn.
 *     A brief/slow grow that the tail then delivers (a later tick re-anchors
 *     lastEmittedOffset → size==offset) clears the streak first. So "slow" never
 *     trips it; only SUSTAINED un-emitted growth does. Err toward not-respawning.
 */
export declare function evaluateInboxTailStall(inboxSize: number, state: TailStallState, nowMs: number, stallThresholdMs: number): TailStallVerdict;
export interface InboxLockDeps {
    /**
     * ATOMICALLY create the pidfile WITH `content` iff it does not exist. True =
     * claimed, false = already exists. Atomic-with-content (no create-then-write
     * gap) so a concurrent reader never sees an empty pidfile (gh#795 TOCTOU
     * window 2).
     */
    claim(path: string, content: string): boolean;
    /** File contents, or null if absent/unreadable. */
    read(path: string): string | null;
    /**
     * Verify-then-unlink the file when its content equals `expected`.
     *
     * This primitive is NOT an atomic filesystem compare-and-swap. Callers must
     * hold the per-inbox modern mutation lock around any destructive use; it is
     * never used to mutate legacy inbox-adjacent artifacts.
     */
    removeIfContent(path: string, expected: string): void;
    /** kill(pid,0) liveness: true if the process exists (alive), false if gone (ESRCH). */
    isAlive(pid: number): boolean;
    /**
     * gh#840 (optional — enables the node-WEDGE reap): read the holder heartbeat
     * sidecar for this pidfile's inbox → { mtimeMs, nonce } or null if absent /
     * unreadable. Absent dep ⇒ no wedge reap (legacy behavior).
     */
    readHeartbeat?(pidfilePath: string): {
        mtimeMs: number;
        nonce: string;
    } | null;
    /** gh#840: clock for heartbeat staleness (injected for tests; defaults to Date.now). */
    now?(): number;
    /** gh#840: heartbeat staleness threshold; defaults to HEARTBEAT_STALE_MS. */
    heartbeatStaleMs?: number;
}
/** gh#840: pidfile content is `<pid>` (legacy) or `<pid>:<nonce>` (identity-tagged). */
export declare function parsePidfileContent(trimmed: string): {
    pid: number;
    nonce: string | null;
};
/**
 * gh#840: is the LIVE pidfile holder node-WEDGED (reapable)? True ONLY when BOTH
 * (a) the heartbeat sidecar mtime is stale past the threshold, AND (b) the
 * heartbeat's nonce MATCHES the pidfile holder's nonce (same identity wrote
 * both). A nonce MISMATCH ⇒ the stale heartbeat belongs to a DIFFERENT identity
 * than the currently-alive pidfile holder (PID reuse, or a young reclaimer that
 * hasn't written its first heartbeat yet) ⇒ NOT wedged ⇒ NEVER reap. Err toward
 * NOT reaping: no readHeartbeat dep, no heartbeat file, or a legacy no-nonce
 * pidfile all return false (a false-reap is the deafness we prevent).
 */
export declare function isHolderWedged(pidfilePath: string, holderNonce: string | null, deps: InboxLockDeps): boolean;
/**
 * gh#979: a worktree is the durable local identity for a seat. Drone UUIDs
 * change on re-mint, but a reused worktree must retain the same monitor
 * runtime home. Keep it inside the worktree (where workspace-only sandboxes
 * can write), never under TMPDIR/XDG, and make its contents self-ignored so
 * runtime lock churn never dirties the repository.
 */
export declare function monitorStateRootForWorktree(worktreePath: string): string;
/** Legacy sidecars written by pre-gh#979 monitors beside the config inbox. */
export declare function legacyPidfilePathFor(inboxPath: string): string;
export declare function legacyHeartbeatPathFor(inboxPath: string): string;
/**
 * State paths are keyed by the absolute inbox path within the explicitly
 * supplied worktree runtime root. Omitting the root intentionally preserves
 * the legacy inbox-adjacent layout for old manual commands; supported launch
 * and orientation paths always pass the root explicitly.
 */
export declare function pidfilePathFor(inboxPath: string, stateRoot?: string | null): string;
/** gh#822: the holder-liveness heartbeat sidecar (mtime touched each tick). */
export declare function heartbeatPathFor(inboxPath: string, stateRoot?: string | null): string;
/**
 * Prepare a private, worktree-local monitor runtime root. The supplied root
 * must have the exact `<worktree>/.borgmcp/inbox-monitor` shape generated by
 * `monitorStateRootForWorktree()`. Before any write, resolve the saved
 * worktree canonically and reject a symlinked `.borgmcp` or `inbox-monitor`
 * ancestor. Its local `.gitignore` ignores itself and all descendants, so
 * runtime state produces no repository dirt without mutating tracked ignores.
 */
export declare function ensureMonitorStateDir(stateRoot: string): string;
export declare const HEARTBEAT_STALE_MS: number;
/**
 * gh#822: `tail` args — ARM (`-n 0`, skip history, matches the prior shape) vs
 * RECOVERY byte-seek (`-c +<N+1>`, re-read the un-emitted bytes from offset N
 * FORWARD — CR build-gate item 3: NOT `-n 0`, which starts at the new EOF and
 * skips exactly the bytes a stalled tail dropped).
 */
export declare function tailArgsFor(inboxPath: string, fromByteOffset: number | null): string[];
/**
 * Try to become the SOLE monitor for this inbox. Returns true if we claimed the
 * pidfile (caller proceeds to tail + must release it on exit); false if a LIVE
 * holder already owns it (caller yields/exits without tailing). The runtime
 * calls it only while holding the modern per-inbox mutation lock, so stale
 * reaping and successor claims are serialized. It never mutates legacy
 * inbox-adjacent artifacts.
 */
export declare function acquireInboxLock(pidfilePath: string, ownPid: number, deps: InboxLockDeps, maxAttempts?: number, ownNonce?: string): boolean;
/** Legacy migration outcome. `blocked` includes stale or unreadable artifacts. */
export type LegacyMonitorArtifactState = 'absent' | 'live' | 'blocked';
export interface LegacyArtifactDeps {
    /** Fail closed: true when the artifact exists OR cannot be inspected. */
    exists(path: string): boolean;
    read(path: string): string | null;
    isAlive(pid: number): boolean;
}
/**
 * Conservative cross-version migration boundary (gh#979): an extant legacy
 * pidfile OR heartbeat is never replaced or unlinked by modern code. A proven
 * live PID yields to the existing old monitor; every other artifact is a
 * blocked migration requiring explicit operator cleanup. This avoids trying to
 * emulate an unavailable atomic unlink-if-content primitive across binaries
 * that do not share the modern mutation lock.
 */
export declare function legacyMonitorArtifactState(inboxPath: string, deps: LegacyArtifactDeps): LegacyMonitorArtifactState;
export interface ModernMonitorClaimDeps {
    claimMutation(): boolean;
    releaseMutation(): void;
    legacyState(): LegacyMonitorArtifactState;
    claimModern(): boolean;
    releaseModern(): void;
}
export type ModernMonitorClaimResult = 'claimed' | 'mutation-busy' | 'modern-live' | 'legacy-live' | 'legacy-blocked';
/**
 * Serialize every modern startup mutation for one inbox. The mutation lock is
 * acquired BEFORE the first legacy read, spans modern lock claim, and protects
 * the final legacy revalidation. An old binary that creates a legacy artifact
 * at the former check→claim gap therefore makes the final check yield while
 * preserving that artifact untouched.
 */
export declare function claimModernMonitorSafely(deps: ModernMonitorClaimDeps): ModernMonitorClaimResult;
export declare function defaultInboxLockDeps(): InboxLockDeps;
/**
 * gh#840: read the holder heartbeat sidecar for a pidfile's inbox.
 * Freshness = file mtime; identity = file content (the holder's nonce). Returns
 * null if the sidecar is absent/unreadable.
 */
export declare function readHeartbeatSidecar(pidfilePath: string): {
    mtimeMs: number;
    nonce: string;
} | null;
/** A short-lived, atomic state-root guard for all modern lock mutations. */
export declare function mutationLockPathFor(pidfilePath: string): string;
/**
 * gh#840: write the holder heartbeat sidecar — the per-holder identity nonce as
 * content; the FILE MTIME (touched on every write) is the freshness signal the
 * SLI + the wedge reaper read. Replaces the old timestamp-as-content (nothing
 * read that content; mtime was always the freshness source).
 */
export declare function writeHeartbeat(heartbeatPath: string, nonce: string): void;
/**
 * 2026-07-02 incident: first-drone-in-a-new-cube arm race. The kickoff Monitor
 * pre-gh#979 `borg-inbox-monitor <inbox>` at session start, but the per-cube
 * inbox directory (~/.config/borgmcp/inboxes/<cubeId>/) is created by the MCP
 * server child only when the SSE stream first writes — so the legacy monitor's
 * FIRST fs act (the pidfile-claim writeFileSync) threw ENOENT. The supported
 * explicit-state-root mode no longer writes beside the inbox at all; this
 * helper remains only for positional legacy compatibility. The inbox FILE is
 * still the stream owner's; `tail -F` retries on a missing file.
 */
export declare function ensureInboxDir(inboxPath: string): void;
interface MonitorInvocation {
    inboxPath: string;
    stateRoot: string | null;
}
/** Parse the supported explicit-root command plus the legacy positional form. */
export declare function parseMonitorInvocation(argv: string[]): MonitorInvocation | null;
/**
 * Is this module being invoked as the bin entry point?
 *
 * gh#114: under `npm install`, `process.argv[1]` is the npm-bin symlink
 * path while `fileURLToPath(import.meta.url)` is the realpath of the
 * installed file. A naive `===` check never matches → `main()` never
 * runs → the documented `borg-inbox-monitor` Monitor command silently
 * no-ops and drones go deaf without the wake-path-self-heal (gh#43)
 * triggering. Resolve the symlink before comparing.
 *
 * Exported for unit testing.
 */
export declare function isEntryInvocation(argv1: string, importMetaUrl: string): boolean;
export {};
//# sourceMappingURL=inbox-monitor.d.ts.map