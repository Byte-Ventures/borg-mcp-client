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
| **Monitor absent** | No process tails the inbox file. Entries can reach disk, but no local event source wakes the drone. | `checkInboxMonitorHealthy()` in `src/stream-status.ts:56-89` reports the wake path broken when `pgrep` confirms that no process follows the inbox. The warning is fail-loud only when the probe can make that determination. |
| **Monitor registered but inert** | A Monitor task is registered in the harness, but its underlying process exits immediately. The task looks armed while no `tail -F` process fans out events. | The realpath-aware entry guard in `src/inbox-monitor.ts:1033-1056` prevents the npm-bin symlink failure. The built-binary symlink test in `__tests__/inbox-monitor.test.ts:767-843` proves that the shipped process stays alive. The process probe also observes the resulting absence of `tail`; it does not make the entry guard or its end-to-end pin redundant because detection runs only when the client is queried, after immediate wake delivery has already failed. |
| **Monitor holder or tail wedged** | A process exists but is not delivering appended bytes. Process presence alone would incorrectly look healthy. | The holder heartbeat upgrades process presence to a liveness signal in `src/stream-status.ts:56-110`. `src/inbox-monitor.ts:981-1014` detects sustained un-emitted inbox growth and respawns its own `tail` from the last delivered offset. A `tail` error or exit releases the heartbeat and PID state at `:959-975`, so a dead child does not leave a healthy-looking holder behind. |

The distinction between **Monitor absent** and **Monitor registered but inert**
is load-bearing. The entry-guard regression did not fail to register a Monitor;
it made the registered command exit successfully without starting `main()`.
Coverage that only checks whether orchestration created a task cannot observe
that shipped-binary no-op class.

## Bin Entry Guard Must Resolve the npm Shim

**Invariant:** the `main()` entry guard at `src/inbox-monitor.ts:1055-1056`
uses `isEntryInvocation(process.argv[1], import.meta.url)`. The helper at
`:1045-1051` calls `realpathSync(argv1)` before comparing it with
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

**Verification:** `__tests__/inbox-monitor.test.ts:712-765` pins the helper's
realpath-aware behavior. The end-to-end test at `:767-843` rebuilds the current
`dist/`, invokes `dist/inbox-monitor.js` through a temporary symlink,
and asserts that the process and its `tail` child survive the 600 ms early-exit
window. Both layers are required because the regression class is "shipped
binary silently no-ops," not merely "the helper returns the wrong Boolean."

## Worktree-Local State and Conservative Legacy Migration

**Invariant:** supported Claude Monitor invocations keep PID, heartbeat,
temporary-claim, and mutation-guard state only beneath the exact canonical
`<worktree>/.borgmcp/inbox-monitor` root. `ensureMonitorStateDir()` at
`src/inbox-monitor.ts:336-416` canonicalizes the worktree before creating
children, rejects a symlinked `.borgmcp` or `inbox-monitor` ancestor, and
revalidates the resolved root around preparation. The state root is mode
`0700`; lock, heartbeat, mutation, and ignore files are created mode `0600`.
The local `*` `.gitignore` keeps all runtime state out of Git without changing
a tracked project ignore rule. A pre-existing marker is accepted only when it
is a real regular file with Borg's exact `*\n` bytes, mode `0600`, and, where
the platform exposes it, the current process UID. A foreign marker, including
exact contents at a foreign mode, fails loud before the marker or root mode is
changed; an absent marker is created only with a newly created root.

**Modern lock mutation rule:** the current-format PID claim is
hardlink-create atomic (`src/inbox-monitor.ts:651-675`). A short-lived,
hardlink-created mutation guard is acquired before any legacy inspection,
spans modern stale or wedge reaping and the current-lock claim, and spans the
final legacy revalidation before `tail` starts (`:625-648`, `:831-878`).
`removeIfContent` is deliberately verify-then-unlink rather than an atomic
compare-and-swap; modern code calls it only while the guard serializes modern
contenders. A guard that survives a crashed startup fails closed. After
confirming its process has stopped, the operator may remove that worktree-local
guard and re-arm. PID and nonce pairing remains mandatory for heartbeat-based
wedge recovery (`:268-289`), preventing PID reuse from authorizing a reap.

**Cross-version migration rule:** modern code never unlinks, replaces, or
garbage-collects an extant inbox-adjacent legacy `.monitor.pid` or
`.monitor.heartbeat`. A proven live legacy PID wins and the modern Monitor
yields. A stale, malformed, heartbeat-only, or unreadable legacy artifact
blocks modern startup with an actionable cleanup error; the operator must
confirm the old Monitor has stopped, remove the legacy artifacts, then re-arm
(`src/inbox-monitor.ts:572-648`, `:840-872`). This intentionally prefers a
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

**Verification:** `__tests__/inbox-monitor.test.ts:85-303` pins canonical
worktree placement, symlinked-parent rejection with zero external writes,
`0700`/`0600` modes, Git-clean state, read-only inbox operation, and foreign
ignore rejection without mutation. The migration tests at `:425-493` pin live
legacy precedence, blocked stale artifacts, the modern mutation guard, and a
deterministic old-successor insertion at the former legacy read-to-claim gap.
The built-binary tests at `:845-1045` prove state remains worktree-local and a
stale legacy artifact exits non-zero with an operator cleanup message while
remaining on disk. `__tests__/gc-orphan-inboxes.test.ts:142-163` pins that
garbage collection reaps worktree-root state but leaves legacy sidecars for
explicit cleanup; `src/gc-orphan-inboxes.ts:83-113` also treats every live
legacy signal as a deletion veto.
