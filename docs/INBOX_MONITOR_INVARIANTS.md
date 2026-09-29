# Inbox Monitor Invariants

This document records the load-bearing security and liveness invariants for the
Claude Code inbox Monitor. OpenCode uses HTTP entry injection, and Codex uses
its app-server bridge; neither uses this Monitor.

## Wake-Path Failure Modes

The cube's wake path turns a durable log entry into an agent session that
processes it. For Claude Code, the local hop from the inbox file to the agent
harness is a `tail -F`-style Monitor. That middle hop is where coordination
delivery becomes a local-process correctness problem rather than a transport
problem.

The following failure classes are distinct even when the current health probe
ultimately reports more than one of them as a missing `tail` process:

| Class | Description | Current detection or closure |
|---|---|---|
| **Monitor absent** | No process tails the inbox file. Entries can reach disk, but no local event source wakes the drone. | `checkInboxMonitorHealthy()` in `src/stream-status.ts:60-93` reports the wake path broken when `pgrep` confirms that no process follows the inbox. The warning is fail-loud only when the probe can make that determination. |
| **Monitor registered but inert** | A Monitor task is registered in the harness, but its underlying process exits immediately. The task looks armed while no `tail -F` process fans out events. | The realpath-aware entry guard in `src/inbox-monitor.ts:1424-1447` prevents the npm-bin symlink failure. The built-binary symlink test in `__tests__/inbox-monitor.test.ts:767-843` proves that the shipped process stays alive. The process probe also observes the resulting absence of `tail`; it does not make the entry guard or its end-to-end pin redundant because detection runs only when the client is queried, after immediate wake delivery has already failed. |
| **Monitor holder or tail wedged** | A process exists but is not delivering appended bytes. Process presence alone would incorrectly look healthy. | The holder heartbeat upgrades process presence to a liveness signal in `src/stream-status.ts:60-114`. `src/inbox-monitor.ts:1372-1405` detects sustained un-emitted inbox growth and respawns its own `tail` from the last delivered offset. A `tail` error or exit releases the heartbeat and PID state at `:1350-1367`, so a dead child does not leave a healthy-looking holder behind. |
| **Entry written while no Monitor is armed** | An entry lands after one Monitor stops and before the next one arms. A Monitor that only follows new lines never announces it. | The state-root Monitor keeps a replay cursor and announces that entry at arm, at least once and at most the newest 20 (`src/inbox-monitor.ts:174-459`, `:1241-1316`). The Claude guidance re-arms the Monitor before it drains the unread log, and falls back to `/loop` when the Monitor cannot be armed (`src/claude-wake-copy.ts`). |
The distinction between **Monitor absent** and **Monitor registered but inert**
is load-bearing. The entry-guard regression did not fail to register a Monitor;
it made the registered command exit successfully without starting `main()`.
Coverage that only checks whether orchestration created a task cannot observe
that shipped-binary no-op class.

## Bin Entry Guard Must Resolve the npm Shim

**Invariant:** the `main()` entry guard at `src/inbox-monitor.ts:1446-1447`
uses `isEntryInvocation(process.argv[1], import.meta.url)`. The helper at
`:1436-1442` calls `realpathSync(argv1)` before comparing it with
`fileURLToPath(importMetaUrl)`. The raw
`process.argv[1] === fileURLToPath(import.meta.url)` test must not return.
The realpath call remains inside a `try`/`catch` with a safe-default `false` for
errors such as a broken symlink, missing file, permission failure, or symlink
loop.

**Why load-bearing:** drones installed with `npm install -g borgmcp` launch the
compiled `dist/inbox-monitor.js` through the `borg-inbox-monitor` npm bin shim.
With raw equality, `argv[1]` is the shim's symlink path while
`fileURLToPath(import.meta.url)` is the module's realpath. They never match,
`main()` never runs, and the binary exits 0 silently. The Claude Code harness
then has a Monitor task that appears armed but is inert, so the drone loses its
immediate wake path without a launch error.

**Change shapes that silently weaken it:**

- Dropping `realpathSync`, or resolving only one side of the comparison,
  recreates the npm-shim mismatch.
- Removing the `try`/`catch` turns a safe non-entry result into an entry-point
  crash.
- Removing the exported helper discards the focused unit pin.
- Dropping the built-binary symlink-spawn test as redundant leaves only pure
  helper coverage, which cannot observe whether the shipped binary silently
  exits before starting `tail`.

**Verification:** `__tests__/inbox-monitor.test.ts:722-775` pins the helper's
realpath-aware behavior. The end-to-end test at `:777-853` rebuilds the current
`dist/`, invokes `dist/inbox-monitor.js` through a temporary symlink,
and asserts that the process and its `tail` child survive the 600 ms early-exit
window. Both layers are required because the regression class is "shipped
binary silently no-ops," not merely "the helper returns the wrong Boolean."

## Worktree-Local State and Conservative Legacy Migration

**Invariant:** supported Claude Monitor invocations keep PID, heartbeat,
replay-cursor, temporary-claim, and mutation-guard state only beneath the exact canonical
`<worktree>/.borgmcp/inbox-monitor` root. `ensureMonitorStateDir()` at
`src/inbox-monitor.ts:644-725` canonicalizes the worktree before creating
children, rejects a symlinked `.borgmcp` or `inbox-monitor` ancestor, and
revalidates the resolved root around preparation. The state root is mode
`0700`; lock, heartbeat, cursor, mutation, and ignore files are created mode
`0600`.
The local `*` `.gitignore` keeps all runtime state out of Git without changing
a tracked project ignore rule. A pre-existing marker is accepted only when it
is a real regular file with Borg's exact `*\n` bytes, mode `0600`, and, where
the platform exposes it, the current process UID. A foreign marker, including
exact contents at a foreign mode, fails loud before the marker or root mode is
changed; an absent marker is created only with a newly created root.

**Modern lock mutation rule:** the current-format PID claim is
hardlink-create atomic (`src/inbox-monitor.ts:960-984`). A short-lived,
hardlink-created mutation guard is acquired before any legacy inspection,
spans modern stale or wedge reaping and the current-lock claim, and spans the
final legacy revalidation before `tail` starts (`:934-958`, `:1139-1186`).
`removeIfContent` is deliberately verify-then-unlink rather than an atomic
compare-and-swap; modern code calls it only while the guard serializes modern
contenders. A guard that survives a crashed startup fails closed. After
confirming its process has stopped, the operator may remove that worktree-local
guard and re-arm. PID and nonce pairing remains mandatory for heartbeat-based
wedge recovery (`:576-598`), preventing PID reuse from authorizing a reap.

**Cross-version migration rule:** modern code never unlinks, replaces, or
garbage-collects an extant inbox-adjacent legacy `.monitor.pid` or
`.monitor.heartbeat`. A proven live legacy PID wins and the modern Monitor
yields. A stale, malformed, heartbeat-only, or unreadable legacy artifact
blocks modern startup with an actionable cleanup error; the operator must
confirm the old Monitor has stopped, remove the legacy artifacts, then re-arm
(`src/inbox-monitor.ts:881-958`, `:1149-1182`). This intentionally prefers a
failed-visible arm over a dual tail or deletion of a successor's live lock. The
migration boundary assumes no new legacy binary is launched after upgrade;
already-running legacy holders remain protected.

**Why load-bearing:** a workspace-only sandbox must never follow a
repository-controlled `.borgmcp` symlink into an external writable path, and a
user-space implementation cannot manufacture a portable atomic
unlink-if-content operation for a legacy binary that does not participate in
modern serialization. Treating either gap as harmless could escape the
promised workspace containment or make a valid old Monitor lose its sole
liveness lock.

**Verification:** `__tests__/inbox-monitor.test.ts:95-313` pins canonical
worktree placement, symlinked-parent rejection with zero external writes,
`0700`/`0600` modes, Git-clean state, read-only inbox operation, and foreign
ignore rejection without mutation. The migration tests at `:435-503` pin live
legacy precedence, blocked stale artifacts, the modern mutation guard, and a
deterministic old-successor insertion at the former legacy read-to-claim gap.
The built-binary tests at `:855-1263` prove state remains worktree-local and a
stale legacy artifact exits non-zero with an operator cleanup message while
remaining on disk. `__tests__/gc-orphan-inboxes.test.ts:143-165` pins that
garbage collection reaps worktree-root state but leaves legacy sidecars for
explicit cleanup; `src/gc-orphan-inboxes.ts:84-114` also treats every live
legacy signal as a deletion veto.

## Arm Replay Cursor

**Invariant:** a state-root Monitor announces entry lines written after the
previous Monitor for the same inbox stopped and before this one armed. At most
the newest 20 are replayed at one arm; when more are eligible, one notice line
says how many were not shown and to drain `borg_read-log unread_only=true`.
Delivery is at least once, not exactly once: after a crash or kill between
emitting a line and storing the cursor, that line is announced again at the
next arm. Legacy positional invocations keep the previous skip-history arm and
write no cursor.

- **Persistence.** The lock holder writes `<state root>/<sha256(inbox path)>.monitor.cursor`
  (`replayCursorPathFor`). It holds the SHA-256 of the last entry line the
  holder handled, that line's timestamp, and a boundary: entries older than the
  boundary are never replayed. It holds no message text. The file is replaced
  by an exclusive-create `0600` temp file, flushed, then renamed. A read opens
  it without following a symlink and refuses anything that is not a regular
  file owned by the user, mode `0600`, and at most 1 KiB. A refused or
  malformed cursor is reported on stderr and treated as absent.
- **Write failure.** A failed write is reported once on stderr and never stops
  delivery. The stored cursor is then removed where possible, so the next arm
  falls back to skip-history; a later successful write restores it. When the
  cursor can be neither written nor removed, the next arm either refuses it
  (skip-history) or replays from the last position stored, which can only
  repeat entries.
- **Anchoring.** The cursor names a line, not a byte offset, because the
  stream owner trims the inbox by rename (`trimInboxFileToRecentLines`), which
  invalidates offsets. When the line has been trimmed away, its timestamp
  bounds the replay; equal timestamps are replayed rather than dropped.
- **Arm.** `planArmReplay` (a pure function) splits the inbox read at arm into
  history and replay. A fresh or unusable cursor makes every line history, the
  previous behaviour, and writes a cursor at the last entry. Replay excludes
  entries older than the stored boundary and copies of lines at or before the
  cursor, and keeps the newest 20. `tail` then reads the file from its first
  line (`-n +1`), so nothing written between the arm read and `tail`'s open is
  skipped. Every line is classified as replay, history, already seen, or live.
- **Ordering.** The replay is one ordered sequence (`ArmReplayProgress`). A
  line is emitted before the cursor moves past it, and while any replay entry
  is unhandled the stored cursor keeps the boundary the replay was selected
  with, so an arm interrupted after the first of N replay entries leaves the
  other N-1 for the next arm. Only after the last replay entry does the cursor
  take this arm's boundary. The holder stops writing the cursor once it starts
  shutting down, so a successor's cursor is not overwritten.
- **Cleanup.** Orphan GC removes the cursor with the PID and heartbeat files
  under the worktree state root.

**Verification:** `__tests__/inbox-monitor.test.ts:1347-1508` pins the plan
(fresh skip-history, replay after the cursor, restart with nothing new, the
boundary kept across a partial replay, the trim fallback, dedupe, the cap), the
cursor format and the file checks. The built-binary tests at `:1030-1235`
cover: an entry written between a stop and a re-arm is emitted exactly once; a
restart with nothing new emits nothing; an arm killed after the first of three
replay entries leaves the other two for the next arm, each emitted once; and a
cursor that cannot be written leaves delivery running, reports once, and the
next arm skips history.
