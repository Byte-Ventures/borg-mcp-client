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
 *
 * Only the state-root form keeps a replay cursor (see `planArmReplay`): an entry
 * written after the previous monitor for this inbox stopped, and before this
 * one armed, is emitted once at arm instead of being skipped with history.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, readFileSync, readSync, realpathSync, statSync, writeSync, } from 'node:fs';
import { chmodSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from './guarded-fs.js';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { formatCubeActivityWakeMessage } from './cube-activity-wake-copy.js';
const ENTRY_LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\S*)\s+(\S+)\s+\(([^)]+)\):\s*(.*)$/;
export const RECENT_EMITTED_LINE_CAP = 1024;
/**
 * Allow a small amount of server/host clock skew at monitor arm. Lines older
 * than this boundary are historical materialized inbox content, not live
 * activity for this monitor instance.
 */
export const INBOX_ARM_TIMESTAMP_SKEW_MS = 5_000;
export class RecentLineDeduper {
    cap;
    seen = new Set();
    order = [];
    constructor(cap = RECENT_EMITTED_LINE_CAP) {
        this.cap = cap;
        if (!Number.isInteger(cap) || cap < 1) {
            throw new Error('cap must be a positive integer');
        }
    }
    has(line) {
        return this.seen.has(line);
    }
    remember(line) {
        if (this.seen.has(line))
            return false;
        this.seen.add(line);
        this.order.push(line);
        while (this.order.length > this.cap) {
            const oldLine = this.order.shift();
            if (oldLine)
                this.seen.delete(oldLine);
        }
        return true;
    }
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
export function formatEventLine(inboxLine) {
    const match = ENTRY_LINE_RE.exec(inboxLine);
    if (!match)
        return null;
    const [, , label, role, body] = match;
    const summary = body.trim();
    return `${label} (${role}): ${summary}`;
}
/**
 * Return whether an inbox entry is fresh enough to have been produced after
 * this monitor armed. A malformed timestamp fails closed when this guard is
 * active; callers without an arm boundary retain the legacy parser behavior.
 */
export function isInboxLineAtOrAfterArm(inboxLine, armTimeMs, skewMs = INBOX_ARM_TIMESTAMP_SKEW_MS) {
    const match = ENTRY_LINE_RE.exec(inboxLine);
    if (!match || !Number.isFinite(armTimeMs) || !Number.isFinite(skewMs) || skewMs < 0) {
        return false;
    }
    const timestampMs = Date.parse(match[1]);
    return Number.isFinite(timestampMs) && timestampMs >= armTimeMs - skewMs;
}
export function formatFreshEventLine(inboxLine, deduper, includeWakeMessage = false, armTimeMs) {
    const pretty = formatEventLine(inboxLine);
    if (pretty === null)
        return null;
    if (armTimeMs !== undefined && !isInboxLineAtOrAfterArm(inboxLine, armTimeMs)) {
        return null;
    }
    return deduper.remember(inboxLine)
        ? includeWakeMessage ? formatCubeActivityWakeMessage(pretty) : pretty
        : null;
}
export function seedDeduperFromInboxTail(inboxPath, deduper, maxLines = 512) {
    if (!Number.isInteger(maxLines) || maxLines < 1) {
        throw new Error('maxLines must be a positive integer');
    }
    let raw;
    try {
        raw = readFileSync(inboxPath, 'utf-8');
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return;
        throw err;
    }
    const lines = raw.split(/\r?\n/);
    if (lines.at(-1) === '')
        lines.pop();
    for (const line of lines.slice(-maxLines)) {
        if (formatEventLine(line) !== null)
            deduper.remember(line);
    }
}
// ---- Arm replay cursor (6.0.2): close the stop→re-arm gap ----
// A monitor that arms skips history, so an entry written after the previous
// monitor stopped and before this one armed was never announced. The holder
// therefore persists, under its explicit state root, which entry line it
// handled last, and the next arm replays the entry lines written after it.
//
// The cursor is anchored to line CONTENT, not a byte offset: the stream owner
// trims the inbox by rename (log-stream.ts trimInboxFileToRecentLines), which
// invalidates every offset. It stores a SHA-256 of the line rather than the
// line, so no message text is copied into the worktree. When the anchored line
// has been trimmed away, the line's own timestamp bounds the replay instead.
// `sinceMs` is the arm boundary of the monitor that wrote the cursor; entries
// older than it were history to that monitor and are never replayed.
//
// Delivery is at least once: a line is emitted before the cursor moves past
// it, so a crash between the two re-emits that one line on the next arm, and
// never drops it. A duplicate wake only drains an empty unread log.
/** At most this many entries are replayed at arm; older ones get one notice line. */
export const ARM_REPLAY_CAP = 20;
const CURSOR_MAX_BYTES = 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
export function replayCursorPathFor(inboxPath, stateRoot) {
    return join(resolve(stateRoot), `${monitorStateKey(inboxPath)}.monitor.cursor`);
}
export function cursorForLine(line, sinceMs) {
    const match = ENTRY_LINE_RE.exec(line);
    if (!match)
        return null;
    return {
        lineSha256: createHash('sha256').update(line, 'utf8').digest('hex'),
        lineTs: match[1],
        sinceMs,
    };
}
/** Strict decode of a stored cursor; anything unexpected is null (fresh arm). */
export function parseReplayCursor(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const record = value;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'line_sha256,line_ts,since_ms,v' || record.v !== 1)
        return null;
    const { line_sha256: hash, line_ts: ts, since_ms: sinceMs } = record;
    if (typeof sinceMs !== 'number' || !Number.isSafeInteger(sinceMs) || sinceMs < 0)
        return null;
    if (hash === null && ts === null)
        return { lineSha256: null, lineTs: null, sinceMs };
    if (typeof hash !== 'string' || !SHA256_HEX_RE.test(hash))
        return null;
    if (typeof ts !== 'string' || !Number.isFinite(Date.parse(ts)))
        return null;
    return { lineSha256: hash, lineTs: ts, sinceMs };
}
export function serializeReplayCursor(cursor) {
    return `${JSON.stringify({
        v: 1,
        line_sha256: cursor.lineSha256,
        line_ts: cursor.lineTs,
        since_ms: cursor.sinceMs,
    })}\n`;
}
/**
 * Read the stored cursor. It must be a regular file owned by this user, mode
 * 0600 and small; it is opened without following a symlink. A missing file is
 * null; every other refusal is reported so the caller can say why it did not
 * replay.
 */
export function readReplayCursor(cursorPath) {
    let fd;
    try {
        fd = openSync(cursorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return { cursor: null, problem: null };
        return { cursor: null, problem: `cannot open (${err?.code ?? 'error'})` };
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
            return { cursor: null, problem: 'not a regular file' };
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            return { cursor: null, problem: 'unexpected owner' };
        }
        if ((stat.mode & 0o777) !== 0o600)
            return { cursor: null, problem: 'unexpected mode' };
        if (stat.size > CURSOR_MAX_BYTES)
            return { cursor: null, problem: 'too large' };
        const buffer = Buffer.alloc(CURSOR_MAX_BYTES + 1);
        let length = 0;
        for (;;) {
            const read = readSync(fd, buffer, length, buffer.length - length, null);
            if (read === 0)
                break;
            length += read;
            if (length > CURSOR_MAX_BYTES)
                return { cursor: null, problem: 'too large' };
        }
        const cursor = parseReplayCursor(buffer.subarray(0, length).toString('utf8'));
        return cursor ? { cursor, problem: null } : { cursor: null, problem: 'malformed' };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Replace the cursor atomically: a fresh 0600 temp file created exclusively
 * (never through an existing path or symlink), flushed, then renamed over the
 * cursor. Renaming replaces a planted symlink itself, never its target.
 */
export function writeReplayCursor(cursorPath, cursor) {
    const tmp = `${cursorPath}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
        try {
            writeSync(fd, serializeReplayCursor(cursor));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, cursorPath);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* best-effort temp cleanup */
        }
        throw err;
    }
}
function entryTimestampMs(line) {
    const match = ENTRY_LINE_RE.exec(line);
    if (!match)
        return null;
    const ms = Date.parse(match[1]);
    return Number.isFinite(ms) ? ms : null;
}
/**
 * PURE: decide, from the inbox contents read at arm and the stored cursor,
 * which lines are history and which are replayed.
 *
 * - No cursor (a fresh state root, or an unusable cursor): every line is
 *   history, exactly the previous skip-history arm, and the cursor to persist
 *   marks the last entry line (or none) with this arm's boundary.
 * - Cursor line found: replay the entry lines after its first occurrence.
 * - Cursor line trimmed away: replay the entry lines timestamped at or after
 *   it. Equal timestamps are replayed, never dropped.
 * - A cursor with no line: replay the entry lines at or after its boundary.
 *
 * In every case a replayed line is at or after the cursor's `sinceMs`, is not
 * a copy of a line at or before the cursor, and appears once. Only the newest
 * ARM_REPLAY_CAP are replayed; the rest are counted in `omitted`.
 */
export function planArmReplay(inboxRaw, cursor, armSinceMs, cap = ARM_REPLAY_CAP) {
    if (!Number.isInteger(cap) || cap < 1)
        throw new Error('cap must be a positive integer');
    const lines = inboxRaw.split(/\r?\n/);
    if (lines.at(-1) === '')
        lines.pop();
    const entries = lines.filter((line) => ENTRY_LINE_RE.test(line));
    if (!cursor) {
        const last = entries.at(-1);
        return {
            history: new Set(lines),
            replay: [],
            omitted: 0,
            cursorAtArm: (last ? cursorForLine(last, armSinceMs) : null) ?? { lineSha256: null, lineTs: null, sinceMs: armSinceMs },
        };
    }
    let after;
    let before;
    if (cursor.lineSha256 === null) {
        before = [];
        after = entries;
    }
    else {
        const index = entries.findIndex((line) => createHash('sha256').update(line, 'utf8').digest('hex') === cursor.lineSha256);
        if (index >= 0) {
            before = entries.slice(0, index + 1);
            after = entries.slice(index + 1);
        }
        else {
            const floor = Date.parse(cursor.lineTs ?? '');
            before = entries.filter((line) => (entryTimestampMs(line) ?? -Infinity) < floor);
            after = entries.filter((line) => (entryTimestampMs(line) ?? -Infinity) >= floor);
        }
    }
    const seenBefore = new Set(before);
    const candidates = [];
    const unique = new Set();
    for (const line of after) {
        const ts = entryTimestampMs(line);
        if (ts === null || ts < cursor.sinceMs)
            continue;
        if (seenBefore.has(line) || unique.has(line))
            continue;
        unique.add(line);
        candidates.push(line);
    }
    const omitted = Math.max(0, candidates.length - cap);
    const replay = candidates.slice(omitted);
    const replaySet = new Set(replay);
    return {
        history: new Set(lines.filter((line) => !replaySet.has(line))),
        replay,
        omitted,
        cursorAtArm: null,
    };
}
export function formatReplayOmittedLine(omitted) {
    return (`borg-inbox-monitor: ${omitted} older ${omitted === 1 ? 'entry' : 'entries'} arrived while no monitor was armed ` +
        'and are not shown; drain `borg_read-log unread_only=true`.');
}
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
export function evaluateInboxTailStall(inboxSize, state, nowMs, stallThresholdMs) {
    if (inboxSize < state.lastEmittedOffset) {
        return { kind: 'rotation', state: { lastEmittedOffset: inboxSize, grewSince: null } };
    }
    if (inboxSize === state.lastEmittedOffset) {
        return { kind: 'ok', state: { lastEmittedOffset: state.lastEmittedOffset, grewSince: null } };
    }
    // inboxSize > lastEmittedOffset → un-emitted growth; start/continue the streak.
    const grewSince = state.grewSince ?? nowMs;
    const next = { lastEmittedOffset: state.lastEmittedOffset, grewSince };
    return nowMs - grewSince >= stallThresholdMs
        ? { kind: 'respawn', state: next }
        : { kind: 'ok', state: next };
}
/** gh#840: pidfile content is `<pid>` (legacy) or `<pid>:<nonce>` (identity-tagged). */
export function parsePidfileContent(trimmed) {
    const colon = trimmed.indexOf(':');
    if (colon === -1)
        return { pid: Number.parseInt(trimmed, 10), nonce: null };
    return {
        pid: Number.parseInt(trimmed.slice(0, colon), 10),
        nonce: trimmed.slice(colon + 1) || null,
    };
}
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
export function isHolderWedged(pidfilePath, holderNonce, deps) {
    if (!holderNonce || !deps.readHeartbeat)
        return false;
    const hb = deps.readHeartbeat(pidfilePath);
    if (hb === null)
        return false;
    const now = deps.now ? deps.now() : Date.now();
    const staleMs = deps.heartbeatStaleMs ?? HEARTBEAT_STALE_MS;
    const stale = now - hb.mtimeMs >= staleMs;
    return stale && hb.nonce === holderNonce;
}
/**
 * gh#979: a worktree is the durable local identity for a seat. Drone UUIDs
 * change on re-mint, but a reused worktree must retain the same monitor
 * runtime home. Keep it inside the worktree (where workspace-only sandboxes
 * can write), never under TMPDIR/XDG, and make its contents self-ignored so
 * runtime lock churn never dirties the repository.
 */
export function monitorStateRootForWorktree(worktreePath) {
    if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
        throw new Error(`invalid monitor worktree path: ${worktreePath}`);
    }
    return join(resolve(worktreePath), '.borgmcp', 'inbox-monitor');
}
/** Legacy sidecars written by pre-gh#979 monitors beside the config inbox. */
export function legacyPidfilePathFor(inboxPath) {
    return `${inboxPath}.monitor.pid`;
}
export function legacyHeartbeatPathFor(inboxPath) {
    return `${inboxPath}.monitor.heartbeat`;
}
function monitorStateKey(inboxPath) {
    return createHash('sha256').update(resolve(inboxPath)).digest('hex');
}
/**
 * State paths are keyed by the absolute inbox path within the explicitly
 * supplied worktree runtime root. Omitting the root intentionally preserves
 * the legacy inbox-adjacent layout for old manual commands; supported launch
 * and orientation paths always pass the root explicitly.
 */
export function pidfilePathFor(inboxPath, stateRoot) {
    if (!stateRoot)
        return legacyPidfilePathFor(inboxPath);
    return join(resolve(stateRoot), `${monitorStateKey(inboxPath)}.monitor.pid`);
}
/** gh#822: the holder-liveness heartbeat sidecar (mtime touched each tick). */
export function heartbeatPathFor(inboxPath, stateRoot) {
    if (!stateRoot)
        return legacyHeartbeatPathFor(inboxPath);
    return join(resolve(stateRoot), `${monitorStateKey(inboxPath)}.monitor.heartbeat`);
}
/**
 * Prepare a private, worktree-local monitor runtime root. The supplied root
 * must have the exact `<worktree>/.borgmcp/inbox-monitor` shape generated by
 * `monitorStateRootForWorktree()`. Before any write, resolve the saved
 * worktree canonically and reject a symlinked `.borgmcp` or `inbox-monitor`
 * ancestor. Its local `.gitignore` ignores itself and all descendants, so
 * runtime state produces no repository dirt without mutating tracked ignores.
 */
export function ensureMonitorStateDir(stateRoot) {
    const requestedRoot = resolve(stateRoot);
    if (basename(requestedRoot) !== 'inbox-monitor' || basename(dirname(requestedRoot)) !== '.borgmcp') {
        throw new Error(`unsafe monitor state path (expected <worktree>/.borgmcp/inbox-monitor): ${requestedRoot}`);
    }
    // `realpath` the existing worktree FIRST. Do not mkdir through the supplied
    // path: a pre-existing `.borgmcp` symlink would otherwise redirect writes
    // outside the workspace before we had a chance to inspect it.
    const canonicalWorktree = realpathSync(dirname(dirname(requestedRoot)));
    const canonicalParent = join(canonicalWorktree, '.borgmcp');
    const canonicalRoot = join(canonicalParent, 'inbox-monitor');
    if (!isStrictDescendant(canonicalRoot, canonicalWorktree)) {
        throw new Error(`unsafe monitor state root outside worktree: ${canonicalRoot}`);
    }
    // Preflight every pre-existing artifact before making any filesystem
    // mutation. In particular, a project-owned root or ignore marker must fail
    // without a mode normalization, write, or sidecar creation.
    const parentBefore = inspectRealDirectory(canonicalParent);
    if (parentBefore && realpathSync(canonicalParent) !== canonicalParent) {
        throw new Error(`unsafe monitor state ancestor changed: ${canonicalParent}`);
    }
    const rootBefore = parentBefore ? inspectRealDirectory(canonicalRoot) : null;
    if (rootBefore) {
        assertOwnedMonitorStateRoot(canonicalRoot, rootBefore);
        assertOwnedMonitorIgnore(join(canonicalRoot, '.gitignore'), canonicalRoot);
    }
    // Nothing pre-existing has been mutated. Create missing path components only
    // after containment + ownership preflight. A component that appears between
    // check and create is a safe failure, not an implicit ownership claim.
    if (!parentBefore) {
        createRealDirectory(canonicalParent, 0o700);
    }
    if (realpathSync(canonicalParent) !== canonicalParent) {
        throw new Error(`unsafe monitor state ancestor changed: ${canonicalParent}`);
    }
    const createdRoot = !rootBefore;
    if (createdRoot) {
        createRealDirectory(canonicalRoot, 0o700);
    }
    const resolvedRoot = realpathSync(canonicalRoot);
    if (resolvedRoot !== canonicalRoot || !isStrictDescendant(resolvedRoot, canonicalWorktree)) {
        throw new Error(`unsafe monitor state root escaped worktree: ${canonicalRoot}`);
    }
    const rootStat = lstatSync(resolvedRoot);
    assertOwnedMonitorStateRoot(resolvedRoot, rootStat);
    const ignorePath = join(resolvedRoot, '.gitignore');
    const monitorIgnoreContent = '*\n';
    if (!createdRoot) {
        // Re-check directly before the first mutation: the initial preflight could
        // otherwise be invalidated by a replacement while a sibling was creating.
        assertOwnedMonitorIgnore(ignorePath, resolvedRoot);
    }
    // Ownership is now proven. mkdir's mode does not alter a pre-existing root,
    // so reassert privacy only AFTER a foreign root/ignore can no longer be
    // modified by a failed arm.
    chmodSync(resolvedRoot, 0o700);
    // A nested .gitignore with `*` also ignores itself. This leaves neither the
    // runtime directory nor its control file in `git status --porcelain`.
    if (createdRoot) {
        writeFileSync(ignorePath, monitorIgnoreContent, { encoding: 'utf8', mode: 0o600 });
        chmodSync(ignorePath, 0o600);
    }
    // One last post-write revalidation narrows a parent replacement race to a
    // detected failure. Node has no dirfd-relative mkdir/write API, so callers
    // fail closed and retry rather than trusting a changed ancestor.
    if (realpathSync(canonicalRoot) !== canonicalRoot) {
        throw new Error(`unsafe monitor state root changed while preparing: ${canonicalRoot}`);
    }
    return canonicalRoot;
}
function inspectRealDirectory(path) {
    try {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error(`unsafe monitor state ancestor (not a real directory): ${path}`);
        }
        return stat;
    }
    catch (err) {
        if (err?.code === 'ENOENT')
            return null;
        throw err;
    }
}
function createRealDirectory(path, mode) {
    try {
        mkdirSync(path, { mode });
    }
    catch (err) {
        if (err?.code === 'EEXIST') {
            throw new Error(`unsafe monitor state path appeared during preparation: ${path}`);
        }
        throw err;
    }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe monitor state ancestor (not a real directory): ${path}`);
    }
}
function assertOwnedMonitorStateRoot(path, stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`unsafe monitor state path (not a real directory): ${path}`);
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error(`unsafe monitor state directory owner: ${path}`);
    }
}
function assertOwnedMonitorIgnore(ignorePath, rootPath) {
    let ignoreStat;
    try {
        ignoreStat = lstatSync(ignorePath);
    }
    catch (err) {
        if (err?.code === 'ENOENT') {
            throw new Error(`unsafe monitor state root missing Borg ownership marker: ${rootPath}`);
        }
        throw err;
    }
    if (!ignoreStat.isFile() || ignoreStat.isSymbolicLink()) {
        throw new Error(`unsafe monitor state ignore path: ${ignorePath}`);
    }
    // The state root is intentionally self-ignored, but it may overlap a
    // user-created/tracked directory. Never overwrite or chmod a pre-existing
    // project ignore file merely because it happens to occupy this path.
    if (readFileSync(ignorePath, 'utf8') !== '*\n') {
        throw new Error(`unsafe monitor state ignore path (not Borg-owned): ${ignorePath}`);
    }
    if ((ignoreStat.mode & 0o777) !== 0o600) {
        throw new Error(`unsafe monitor state ignore path (unexpected mode): ${ignorePath}`);
    }
    if (typeof process.getuid === 'function' && ignoreStat.uid !== process.getuid()) {
        throw new Error(`unsafe monitor state ignore path (unexpected owner): ${ignorePath}`);
    }
}
function isStrictDescendant(candidate, ancestor) {
    const rel = relative(ancestor, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
// gh#822 thresholds — conservative / GC-safe (≥5× the tick), err toward NOT
// respawning / NOT warning (CR 131dcd78: a false-reap IS the deafness we fix).
const MONITOR_TICK_MS = 30_000;
const STALL_THRESHOLD_MS = 5 * MONITOR_TICK_MS; // 150s sustained un-emitted growth
export const HEARTBEAT_STALE_MS = 5 * MONITOR_TICK_MS; // SLI: present-but-stale ⇒ unhealthy
/**
 * gh#822: `tail` args — ARM (`-n 0`, skip history, matches the prior shape) vs
 * RECOVERY byte-seek (`-c +<N+1>`, re-read the un-emitted bytes from offset N
 * FORWARD — CR build-gate item 3: NOT `-n 0`, which starts at the new EOF and
 * skips exactly the bytes a stalled tail dropped).
 */
export function tailArgsFor(inboxPath, fromByteOffset) {
    if (fromByteOffset === 'start')
        return ['-F', '-n', '+1', inboxPath];
    return fromByteOffset === null
        ? ['-F', '-n', '0', inboxPath]
        : ['-F', '-c', `+${fromByteOffset + 1}`, inboxPath];
}
/** Current inbox file size in bytes, or 0 if it can't be stat'd (treated as empty). */
function inboxSizeOf(inboxPath) {
    try {
        return statSync(inboxPath).size;
    }
    catch {
        return 0;
    }
}
/**
 * Try to become the SOLE monitor for this inbox. Returns true if we claimed the
 * pidfile (caller proceeds to tail + must release it on exit); false if a LIVE
 * holder already owns it (caller yields/exits without tailing). The runtime
 * calls it only while holding the modern per-inbox mutation lock, so stale
 * reaping and successor claims are serialized. It never mutates legacy
 * inbox-adjacent artifacts.
 */
export function acquireInboxLock(pidfilePath, ownPid, deps, maxAttempts = 3, ownNonce) {
    // gh#840: tag the pidfile with our identity nonce (`<pid>:<nonce>`) so a
    // future reaper can confirm same-process IDENTITY before reaping a wedged
    // holder. Legacy callers (no nonce) keep the bare `<pid>` content.
    const own = ownNonce ? `${ownPid}:${ownNonce}` : String(ownPid);
    for (let i = 0; i < maxAttempts; i++) {
        if (deps.claim(pidfilePath, own)) {
            return true; // pidfile was absent → claimed atomically
        }
        const existing = deps.read(pidfilePath);
        if (existing === null) {
            continue; // vanished between claim+read → retry the claim
        }
        const trimmed = existing.trim();
        if (trimmed === '') {
            // Empty pidfile. Atomic claim() means OUR code never produces one, so
            // this is a stray/foreign empty file — reap it ONLY if it is still empty
            // (compare-and-delete), then retry. Never deletes a live holder's file.
            deps.removeIfContent(pidfilePath, existing);
            continue;
        }
        const { pid, nonce: holderNonce } = parsePidfileContent(trimmed);
        if (!Number.isNaN(pid) && deps.isAlive(pid)) {
            // gh#840: a LIVE PID is normally untouchable, EXCEPT a node-WEDGED holder
            // (heartbeat stale past the threshold AND the heartbeat nonce matches this
            // pidfile holder's identity) — reap it (compare-and-delete) and retry, so
            // a stuck monitor can be replaced cross-instance. A healthy holder (fresh
            // heartbeat) or an ambiguous identity (nonce mismatch ⇒ PID reuse / young
            // reclaimer) is NEVER reaped.
            if (isHolderWedged(pidfilePath, holderNonce, deps)) {
                deps.removeIfContent(pidfilePath, existing); // gh#795 compare-and-delete
                continue; // retry the claim
            }
            return false; // healthy / ambiguous LIVE holder → yield, NEVER kill
        }
        // provably stale (dead PID / unparseable) → compare-and-delete (only if it
        // STILL holds this exact content — a racer may have reclaimed it live) →
        // retry the claim.
        deps.removeIfContent(pidfilePath, existing);
    }
    return false; // persistent claim race → yield (safe default: never double-tail)
}
/**
 * Conservative cross-version migration boundary (gh#979): an extant legacy
 * pidfile OR heartbeat is never replaced or unlinked by modern code. A proven
 * live PID yields to the existing old monitor; every other artifact is a
 * blocked migration requiring explicit operator cleanup. This avoids trying to
 * emulate an unavailable atomic unlink-if-content primitive across binaries
 * that do not share the modern mutation lock.
 */
export function legacyMonitorArtifactState(inboxPath, deps) {
    const pidfilePath = legacyPidfilePathFor(inboxPath);
    const heartbeatPath = legacyHeartbeatPathFor(inboxPath);
    const pidExists = deps.exists(pidfilePath);
    const heartbeatExists = deps.exists(heartbeatPath);
    if (!pidExists && !heartbeatExists)
        return 'absent';
    if (pidExists) {
        const raw = deps.read(pidfilePath);
        if (raw !== null) {
            const { pid } = parsePidfileContent(raw.trim());
            if (!Number.isNaN(pid) && deps.isAlive(pid))
                return 'live';
        }
    }
    return 'blocked';
}
/**
 * Serialize every modern startup mutation for one inbox. The mutation lock is
 * acquired BEFORE the first legacy read, spans modern lock claim, and protects
 * the final legacy revalidation. An old binary that creates a legacy artifact
 * at the former check→claim gap therefore makes the final check yield while
 * preserving that artifact untouched.
 */
export function claimModernMonitorSafely(deps) {
    if (!deps.claimMutation())
        return 'mutation-busy';
    try {
        const before = deps.legacyState();
        if (before === 'live')
            return 'legacy-live';
        if (before === 'blocked')
            return 'legacy-blocked';
        if (!deps.claimModern())
            return 'modern-live';
        const after = deps.legacyState();
        if (after !== 'absent') {
            deps.releaseModern();
            return after === 'live' ? 'legacy-live' : 'legacy-blocked';
        }
        return 'claimed';
    }
    finally {
        deps.releaseMutation();
    }
}
export function defaultInboxLockDeps() {
    return {
        claim: (p, content) => {
            // Atomic create-with-content: write a unique temp file (already holding
            // the PID), then hardlink it into place. link() fails if the target
            // exists (O_EXCL-equivalent) AND the linked file is non-empty from the
            // first instant — closing the create-then-write empty-read window.
            const tmp = `${p}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
            try {
                writeFileSync(tmp, content, { mode: 0o600 });
                try {
                    linkSync(tmp, p);
                    return true;
                }
                catch (err) {
                    if (err?.code === 'EEXIST')
                        return false;
                    throw err;
                }
            }
            finally {
                try {
                    unlinkSync(tmp);
                }
                catch {
                    /* best-effort temp cleanup */
                }
            }
        },
        read: (p) => {
            try {
                return readFileSync(p, 'utf8');
            }
            catch {
                return null;
            }
        },
        removeIfContent: (p, expected) => {
            try {
                if (readFileSync(p, 'utf8') === expected) {
                    unlinkSync(p);
                }
            }
            catch {
                /* gone/unreadable → nothing to remove */
            }
        },
        isAlive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (err) {
                // EPERM = process exists but we may not signal it (still alive → yield);
                // ESRCH = no such process (dead → reapable).
                return err?.code === 'EPERM';
            }
        },
        readHeartbeat: readHeartbeatSidecar,
        now: () => Date.now(),
        heartbeatStaleMs: HEARTBEAT_STALE_MS,
    };
}
/**
 * gh#840: read the holder heartbeat sidecar for a pidfile's inbox.
 * Freshness = file mtime; identity = file content (the holder's nonce). Returns
 * null if the sidecar is absent/unreadable.
 */
export function readHeartbeatSidecar(pidfilePath) {
    // Modern state files are hash-named while legacy ones are inbox-adjacent;
    // both forms retain the paired `.monitor.pid` → `.monitor.heartbeat` suffix.
    const heartbeatPath = pairedHeartbeatPathForPidfile(pidfilePath);
    try {
        return {
            mtimeMs: statSync(heartbeatPath).mtimeMs,
            nonce: readFileSync(heartbeatPath, 'utf8').trim(),
        };
    }
    catch {
        return null;
    }
}
function pairedHeartbeatPathForPidfile(pidfilePath) {
    return pidfilePath.replace(/\.monitor\.pid$/, '.monitor.heartbeat');
}
/** A short-lived, atomic state-root guard for all modern lock mutations. */
export function mutationLockPathFor(pidfilePath) {
    return pidfilePath.replace(/\.monitor\.pid$/, '.monitor.mutation');
}
function pathExistsFailClosed(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch (err) {
        return err?.code !== 'ENOENT';
    }
}
/**
 * gh#840: write the holder heartbeat sidecar — the per-holder identity nonce as
 * content; the FILE MTIME (touched on every write) is the freshness signal the
 * SLI + the wedge reaper read. Replaces the old timestamp-as-content (nothing
 * read that content; mtime was always the freshness source).
 */
export function writeHeartbeat(heartbeatPath, nonce) {
    writeFileSync(heartbeatPath, nonce, { mode: 0o600 });
    // `mode` only governs creation. A stale pre-existing sidecar may have had
    // broad permissions, so tighten it every time the current holder refreshes.
    chmodSync(heartbeatPath, 0o600);
}
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
export function ensureInboxDir(inboxPath) {
    mkdirSync(dirname(inboxPath), { recursive: true });
}
/** Parse the supported explicit-root command plus the legacy positional form. */
export function parseMonitorInvocation(argv) {
    if (argv.length === 1 && argv[0]) {
        return { inboxPath: argv[0], stateRoot: null };
    }
    if (argv.length === 3 && argv[0] === '--state-root' && argv[1] && argv[2]) {
        return { inboxPath: argv[2], stateRoot: resolve(argv[1]) };
    }
    return null;
}
function liveMonitorYieldLine(inboxPath, holderPidfilePath, deps) {
    const raw = deps.read(holderPidfilePath);
    const parsed = raw === null ? null : parsePidfileContent(raw.trim());
    const livePid = parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 && deps.isAlive(parsed.pid)
        ? parsed.pid
        : null;
    const holder = livePid === null ? 'another monitor instance' : `a live instance (pid ${livePid})`;
    return (`borg-inbox-monitor: inbox ${JSON.stringify(inboxPath)} is already monitored by ${holder}; ` +
        'yielding — another session likely holds this worktree\'s connection.');
}
function main() {
    const invocation = parseMonitorInvocation(process.argv.slice(2));
    if (!invocation) {
        console.error('borg-inbox-monitor: usage: borg-inbox-monitor --state-root <worktree-runtime-root> <inbox-path>');
        process.exit(2);
    }
    const { inboxPath } = invocation;
    let stateRoot = invocation.stateRoot;
    try {
        if (stateRoot) {
            // Supported path: config inboxes are intentionally read-only to this
            // sandboxed process. Do not mkdir or place any state beside them.
            stateRoot = ensureMonitorStateDir(stateRoot);
        }
        else {
            // Compatibility path for a pre-gh#979 hand-authored command.
            ensureInboxDir(inboxPath);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const target = stateRoot ? 'runtime state directory' : `inbox directory for ${inboxPath}`;
        console.error(`borg-inbox-monitor: cannot create ${target}: ${message}`);
        process.exit(1);
    }
    const lockDeps = defaultInboxLockDeps();
    const pidfilePath = pidfilePathFor(inboxPath, stateRoot);
    const mutationPath = mutationLockPathFor(pidfilePath);
    // gh#840: our per-holder identity nonce — written into BOTH the pidfile
    // (`<pid>:<nonce>`) and the heartbeat sidecar, so a future reaper can confirm
    // same-process identity before reaping a wedged holder (PID-reuse safe).
    const ownNonce = randomBytes(16).toString('hex');
    const mutationContent = `${process.pid}:${ownNonce}`;
    const legacyState = () => stateRoot
        ? legacyMonitorArtifactState(inboxPath, {
            exists: pathExistsFailClosed,
            read: lockDeps.read,
            isAlive: lockDeps.isAlive,
        })
        : 'absent';
    const claimResult = claimModernMonitorSafely({
        claimMutation: () => lockDeps.claim(mutationPath, mutationContent),
        releaseMutation: () => lockDeps.removeIfContent(mutationPath, mutationContent),
        legacyState,
        claimModern: () => acquireInboxLock(pidfilePath, process.pid, lockDeps, 3, ownNonce),
        releaseModern: () => lockDeps.removeIfContent(pidfilePath, `${process.pid}:${ownNonce}`),
    });
    if (claimResult === 'mutation-busy') {
        console.error('borg-inbox-monitor: another modern monitor startup is mutating this inbox state; ' +
            `re-arm after it finishes (if it persists after that process stops, confirm it is stopped, remove ${mutationPath}, then re-arm)`);
        process.exit(1);
    }
    if (claimResult === 'legacy-live') {
        // An already-running old monitor still owns the wake path; yield without
        // touching its inbox-adjacent state.
        console.log(liveMonitorYieldLine(inboxPath, legacyPidfilePathFor(inboxPath), lockDeps));
        process.exit(0);
    }
    if (claimResult === 'legacy-blocked') {
        console.error(`borg-inbox-monitor: legacy monitor artifact remains beside ${inboxPath}; ` +
            'stop/confirm the old monitor, remove its .monitor.pid/.monitor.heartbeat manually, then re-arm');
        process.exit(1);
    }
    if (claimResult === 'modern-live') {
        console.log(liveMonitorYieldLine(inboxPath, pidfilePath, lockDeps));
        process.exit(0);
    }
    // Releases occur under the same mutation guard as acquisition/reaping. If a
    // startup mutation is already in flight, leave our state for that contender
    // to inspect rather than risk deleting a successor's lock or heartbeat.
    const releasePidfile = () => {
        if (!lockDeps.claim(mutationPath, mutationContent))
            return;
        try {
            lockDeps.removeIfContent(pidfilePath, `${process.pid}:${ownNonce}`);
        }
        finally {
            lockDeps.removeIfContent(mutationPath, mutationContent);
        }
    };
    const heartbeatPath = heartbeatPathFor(inboxPath, stateRoot);
    const removeHeartbeat = () => {
        if (!lockDeps.claim(mutationPath, mutationContent))
            return;
        try {
            lockDeps.removeIfContent(heartbeatPath, ownNonce);
        }
        finally {
            lockDeps.removeIfContent(mutationPath, mutationContent);
        }
    };
    // Establish the SLI before spawning tail. If the monitor cannot create its
    // state heartbeat, fail the arm rather than leave a Monitor task that looks
    // armed while its holder cannot prove liveness.
    try {
        writeHeartbeat(heartbeatPath, ownNonce);
    }
    catch (err) {
        releasePidfile();
        const message = err instanceof Error ? err.message : String(err);
        console.error(`borg-inbox-monitor: cannot write runtime heartbeat: ${message}`);
        process.exit(1);
    }
    // `tail -F` for rotation/truncation resilience on macOS + Linux.
    // Node's fs.watch is unreliable across file rotation; subprocess
    // tail matches the prior kickoff-Monitor shape (`tail -F`) so the
    // wire behavior is identical — only the per-line projection changes.
    // The legacy positional form uses `-n 0` to skip history. The state-root
    // form reads the file from its first line and classifies every line against
    // the arm plan, so nothing written between the plan's read and tail's open
    // is skipped.
    const monitorArmTimeMs = Date.now();
    const armSinceMs = monitorArmTimeMs - INBOX_ARM_TIMESTAMP_SKEW_MS;
    const deduper = new RecentLineDeduper();
    // gh#822: stat-anchored offset — seed to the inbox SIZE at arm (EOF, matching
    // `tail -F -n 0`'s skip-history) so a non-empty inbox does NOT false-stall on
    // the first tick (CR build-gate item 1). Re-anchored to the live file size on
    // every delivery (rotation-robust — item 2 — via the pure evaluator).
    let stall = { lastEmittedOffset: inboxSizeOf(inboxPath), grewSince: null };
    let shuttingDown = false;
    let currentTail = null;
    let plan = null;
    const cursorPath = stateRoot ? replayCursorPathFor(inboxPath, stateRoot) : null;
    if (cursorPath) {
        let raw = '';
        try {
            raw = readFileSync(inboxPath, 'utf-8');
        }
        catch (err) {
            if (err?.code !== 'ENOENT') {
                console.error(`borg-inbox-monitor: cannot read inbox for arm replay: ${err?.message ?? String(err)}`);
            }
        }
        const stored = readReplayCursor(cursorPath);
        if (stored.problem) {
            console.error(`borg-inbox-monitor: ignoring replay cursor (${stored.problem}); nothing is replayed at this arm`);
        }
        plan = planArmReplay(raw, stored.cursor, armSinceMs);
        if (plan.cursorAtArm)
            persistCursor(plan.cursorAtArm);
        if (plan.omitted > 0)
            console.log(formatReplayOmittedLine(plan.omitted));
    }
    else {
        seedDeduperFromInboxTail(inboxPath, deduper);
    }
    const replayPending = new Set(plan?.replay ?? []);
    // Cursor writes are advisory: a failure is reported once and never stops
    // the wake path. Only the lock holder writes, and it stops at shutdown so a
    // successor's cursor is not overwritten by a late line.
    let cursorWriteFailed = false;
    function persistCursor(cursor) {
        if (!cursorPath || shuttingDown)
            return;
        try {
            writeReplayCursor(cursorPath, cursor);
        }
        catch (err) {
            if (!cursorWriteFailed) {
                cursorWriteFailed = true;
                const message = err instanceof Error ? err.message : String(err);
                console.error(`borg-inbox-monitor: cannot write replay cursor: ${message}`);
            }
        }
    }
    // State-root mode: one decision per inbox line, in file order. Every entry
    // line tail delivers proves the tail is following, so each one re-anchors
    // the stall detector, including history the plan skips.
    const handleStateRootLine = (line) => {
        if (formatEventLine(line) === null)
            return;
        markDelivered();
        if (replayPending.has(line)) {
            replayPending.delete(line);
            if (deduper.remember(line))
                emit(line);
            persistCursor(cursorForLine(line, armSinceMs));
            return;
        }
        if (plan.history.has(line) || deduper.has(line))
            return;
        deduper.remember(line);
        if (isInboxLineAtOrAfterArm(line, monitorArmTimeMs))
            emit(line);
        persistCursor(cursorForLine(line, armSinceMs));
    };
    const emit = (line) => {
        console.log(formatCubeActivityWakeMessage(formatEventLine(line)));
    };
    // Delivered → the tail is current; re-anchor the offset to the live file
    // size (stat-anchored = rotation-robust) and clear any stall streak.
    const markDelivered = () => {
        stall = { lastEmittedOffset: inboxSizeOf(inboxPath), grewSince: null };
    };
    // Spawn (or re-spawn) the tail. `'start'` → the whole file (the state-root
    // arm, classified by the arm plan); `null` → fresh `-n 0` (skip history, the
    // legacy arm path); otherwise byte-seek `-c +<N+1>` to re-read the
    // un-emitted bytes a stalled tail dropped (CR item 3 — NOT `-n 0`, which would
    // skip exactly those bytes). Lines route through the SHARED deduper so an
    // overlap on respawn can't double-emit an already-seen line.
    const spawnTail = (fromByteOffset) => {
        const tail = spawn('tail', tailArgsFor(inboxPath, fromByteOffset), {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        currentTail = tail;
        if (!tail.stdout) {
            console.error('borg-inbox-monitor: tail subprocess has no stdout');
            removeHeartbeat();
            releasePidfile();
            process.exit(1);
        }
        const rl = createInterface({ input: tail.stdout, crlfDelay: Infinity });
        rl.on('line', (line) => {
            if (plan) {
                handleStateRootLine(line);
                return;
            }
            const pretty = formatFreshEventLine(line, deduper, true, monitorArmTimeMs);
            if (pretty !== null) {
                console.log(pretty);
                markDelivered();
            }
        });
        tail.on('error', (err) => {
            if (tail !== currentTail)
                return; // a superseded (respawned-over) tail — ignore.
            console.error(`borg-inbox-monitor: tail failed: ${err.message}`);
            removeHeartbeat();
            releasePidfile();
            process.exit(1);
        });
        tail.on('exit', (code, signal) => {
            // gh#822: a tail we intentionally killed for a self-heal respawn is no
            // longer `currentTail` — ignore its exit (it is NOT holder death).
            if (tail !== currentTail)
                return;
            removeHeartbeat();
            releasePidfile(); // gh#795: free the inbox so the next arm sees absent.
            if (shuttingDown)
                process.exit(0);
            if (signal)
                process.exit(0);
            process.exit(code ?? 0);
        });
    };
    spawnTail(plan ? 'start' : null);
    // gh#822: holder tick — (1) touch the heartbeat sidecar (proves node liveness
    // even in a quiet cube; the SLI + the deferred node-wedge reaper read its
    // mtime), (2) stat the inbox + run the PURE stall evaluator; on a SUSTAINED-
    // un-emitted-growth verdict, self-heal by re-spawning our OWN tail byte-seeking
    // from the last delivered offset (zero cross-process kill). Unref'd so the
    // tick never keeps the process alive on its own.
    const tick = setInterval(() => {
        try {
            // gh#840: write our identity nonce; the file mtime is the freshness signal.
            writeHeartbeat(heartbeatPath, ownNonce);
        }
        catch {
            /* best-effort heartbeat */
        }
        const verdict = evaluateInboxTailStall(inboxSizeOf(inboxPath), stall, Date.now(), STALL_THRESHOLD_MS);
        stall = verdict.state;
        if (verdict.kind === 'respawn' && !shuttingDown) {
            const stalled = currentTail;
            spawnTail(stall.lastEmittedOffset); // sets currentTail = the new tail FIRST
            try {
                stalled?.kill('SIGKILL'); // old tail's exit now sees tail !== currentTail → ignored
            }
            catch {
                /* already gone */
            }
            // Reset the streak so the fresh tail gets a full window to catch up before
            // it could re-trip on the same un-emitted bytes.
            stall = { lastEmittedOffset: stall.lastEmittedOffset, grewSince: null };
        }
    }, MONITOR_TICK_MS);
    tick.unref();
    const shutdown = (signal) => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        clearInterval(tick);
        removeHeartbeat();
        releasePidfile(); // gh#795: release our pidfile on graceful stop
        const tail = currentTail;
        if (tail && !tail.killed && !tail.kill(signal)) {
            process.exit(0);
        }
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}
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
export function isEntryInvocation(argv1, importMetaUrl) {
    try {
        return realpathSync(argv1) === fileURLToPath(importMetaUrl);
    }
    catch {
        return false;
    }
}
// Only run main() when invoked as the bin entry — allow importing the
// pure formatEventLine for unit testing without spawning tail.
if (isEntryInvocation(process.argv[1], import.meta.url)) {
    main();
}
//# sourceMappingURL=inbox-monitor.js.map