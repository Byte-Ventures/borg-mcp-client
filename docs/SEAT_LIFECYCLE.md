# Seat Lifecycle and Recovery

This guide describes the local seat behavior shipped by the client. A seat is
one server-side drone identity plus its client-generated session bearer and
worktree binding. The bearer and binding are stored together in the private
`seats.json` store; commands never reconstruct one from the other.

## Stored states

Only two seat states are persisted:

| State | Meaning | What can use it |
| --- | --- | --- |
| `pending` | The client persisted a fresh bearer before attach completed. It may be unbound, or bound to a worktree after a recoverable finalize failure. | Retry logic only. It is never hydrated as a live seat. |
| `active` | Attach completed and the server session metadata, display metadata, and worktree binding were committed together. | Normal coordination and re-attach. |

`revoked`, `superseded`, and `evicted` are server verdicts, not values written
to `seats.json`. Revocation and supersession do not silently delete local
state. An authoritative eviction is the sole verdict that permits the terminal
assimilation flow to replace a rejected seat. `borg reset-local-connection` is the
explicit offline deletion path.

Seat sessions do not expire. A legacy `expiresAt` field is ignored, and current
attach responses containing `expires_at` are rejected. An enrollment
invitation can expire; recovery is to request a new invitation. An expired
stream cursor is also separate from seat identity and is recovered by resetting
the cursor and reconnecting.

The whole private store fails closed if any persisted record is malformed. The
store reader raises:

```text
Borg private store is malformed or has an unsupported version; refusing to read it
```

The file is not rewritten and no bearer material is included in the error.

## Enrollment, attach, and retry

Enrollment establishes the authority-bound parent credential used to request
seat attachment. Invitation enrollment persists its retry tuple before network
I/O; a rejected or expired invitation requires a new invitation.

For a seat attach, the client:

1. Mints a 32-byte base64url session bearer and persists a `pending` record
   before sending it.
2. Sends that bearer to the server. The server stores only its digest.
3. On success, atomically changes the same record to `active` and adds the
   server metadata, worktree binding, and a monotonic local bind order. Any
   predecessor still marked `active` for that worktree is retired in the same
   store write.

An ambiguous retry reuses the same persisted bearer, so the server resolves the
same seat instead of minting a duplicate. A crash after server acceptance but
before local finalization is also resumed from that pending record. If a
sibling worktree was already created when activation failed, Borg binds the
still-pending record to that worktree without making it live; rerunning from
there resends the same bearer.

Only an `implicit-sibling:<id>` pending operation is eligible for automatic
implicit retry adoption. A `named-sibling:<name>` operation remains distinct
and is never silently adopted by an unnamed sibling launch.

If activation fails and the exact pending record is successfully bound to the
spawned worktree, Borg preserves that worktree and the printed retry reuses the
same seat. If the record is missing, replaced, or unavailable, Borg removes the
spawned worktree and does not print a client retry command: the server may
already have accepted the seat, and the current protocol has no client-side
operation identifier or cleanup endpoint that can prove reuse or remove it.

## Re-attaching from a terminal

`borg assimilate --here` first resolves this worktree's saved active seat and
probes it. A live seat is reattached with the identical bearer; its saved role
is authoritative, and no new drone is minted. The success line is:

```text
re-attached as <drone-label> (same session, no new drone minted)
```

Before relaunch, Borg checks the seat's inbox-monitor PID. A live holder refuses
the relaunch, names its PID, and gives both the safe fresh-worktree path and the
explicit one-time override:

```text
This worktree's Borg drone already has a live session (inbox monitor pid <pid>).
No agent was launched. Stop the existing session or use a fresh worktree with `borg assimilate --worktree <name>`. If the live monitor is wedged, override once with `borg assimilate --here --force`.
```

For a stale or missing heartbeat, the first line adds:

```text
Its heartbeat is <stale|missing>, so the process may be wedged.
```

A dead, absent, malformed, or unreadable PID file is not evidence of a live
holder, so ordinary crash recovery proceeds without `--force`. The probe is
read-only; it does not reap, kill, rewrite, or clear monitor state.

If a second monitor reaches the singleton after launch, it exits successfully
without tailing and prints:

```text
borg-inbox-monitor: inbox "<path>" is already monitored by a live instance (pid <pid>); yielding — another session likely holds this worktree's connection.
```

The existing monitor remains the sole inbox reader.

## Re-attaching from an agent session

The `borg_assimilate` MCP tool is re-attach-only. It can reuse this worktree's
saved seat for the requested cube, but it cannot create a seat or switch the
worktree to another cube.

With no saved identity, it returns:

```text
◼ This session has no drone for this worktree, and in-session borg_assimilate is re-attach-only (it never creates drones — gh#780). To create a drone for cube "<cube>", run `borg assimilate` in a terminal — it spawns the worktree, persists the identity, and launches the agent in one step.
```

For another cube, it returns:

```text
◼ This worktree is attached to cube "<active-cube>"; in-session borg_assimilate is re-attach-only and cannot switch to "<requested-cube>" (gh#780). To work in "<requested-cube>", run `borg assimilate` in a terminal from that project (or spawn a fresh worktree for it).
```

A successful in-session re-attach begins:

```text
# Re-attached to cube: <cube>

**Drone label:** <drone-label>
**Drone:** existing identity reused — no new drone minted (gh#780)
```

If the server no longer accepts the saved seat, the tool fails rather than
reminting:

```text
◼ Re-attach failed — this worktree's saved connection is unreachable (likely evicted or its session was revoked). Server said: <server-error>
Recover by running `borg assimilate` in a terminal to create a fresh drone; in-session borg_assimilate never re-mints (gh#780).
```

## Terminal verdicts and recovery

### Revoked or superseded session

A pin-matched `SESSION_REVOKED` or `SESSION_REJECTED` is diagnosis only. Attach
does not mutate the saved seat. The exact output is one of:

```text
Local session was revoked.
Next: run borg reset-local-connection, then borg assimilate --host <server> --enroll.
```

```text
Local session was superseded by a newer enrollment.
Next: run borg reset-local-connection, then borg assimilate --host <server> --enroll.
```

Run the named offline reset, obtain a new invitation, and enroll again.

### Evicted seat

Only an authoritative `410 DRONE_EVICTED` permits replacement of a rejected
saved seat. If the pre-attach probe establishes eviction, the terminal
assimilation flow may replace the bearer and attach a fresh seat. Ambiguous
transport, trust, endpoint, credential, or server failures never authorize that
replacement.

If the attach itself returns the eviction after re-attach began, Borg does not
claim recovery. It prints:

```text
This worktree's drone on <server> was evicted. Remove this worktree, or from a fresh worktree run `borg assimilate --host <server>`.
```

The stream path also treats typed `DRONE_EVICTED` as terminal: it marks that
exact local candidate rejected, stops retrying that seat, and does not restart
the loop as though the failure were transient.

### Rejected or expired invitation

An invitation failure is enrollment recovery, not a seat reset:

```text
The enrollment invitation for <server> was rejected or expired. Ask the server operator for a replacement invitation — the server can stay running: for an unclaimed owner client run `borg-mcp-server owner-invite`; for an ordinary client run `borg-mcp-server client-invite`. Then rerun `borg assimilate --host <server> --enroll`.
```

## Offline reset

`borg reset-local-connection` clears only the current worktree's saved credential and
cube binding. It makes no network call, revokes nothing server-side, and leaves
the server, trust anchor, cube, and sibling worktrees unchanged.

Its shipped help describes the command as:

```text
borg reset-local-connection (borgmcp <version>) — clear ONLY this worktree's saved connection to its cube

Usage:
  borg reset-local-connection                 Reset this worktree's saved connection (TTY confirms [y/N])
  borg reset-local-connection --host <host>   No-op unless this worktree connects to <host>
  borg reset-local-connection --yes           Reset without a prompt (required when non-interactive)
  borg reset-local-connection --help          Show this help
```

The command snapshots the exact binding and token-safe bearer observation,
prompts outside the store lock, then revalidates the same seat before deleting
it. If another process replaced or reset the seat, the command is an honest
no-op rather than deleting the successor. After a successful reset, Borg reads
the same worktree again without hydrating any bearer. If another saved active
seat remains on the same server, the command points to
`borg assimilate --host <server> --here` and states that the server will
revalidate it before launch. Otherwise it gives the fresh-enrollment path:

```text
borg assimilate --host <server> --enroll
```

## Multiple seats and deterministic selection

Every new drone uses operation kind `sibling` in a managed worktree. Named
siblings key on their worktree name, while implicit siblings receive a unique
operation key. The older `seat` kind with operation key `current-worktree`
remains supported only for reading and resuming legacy in-place seats with
`--here`; Borg does not migrate or re-key them. These operations derive distinct
credential references and distinct bearers, so creating a sibling for a
different worktree never moves or overwrites a legacy worktree's active seat.

Each successful bind records a monotonic store-local order and atomically
retires every older active record for the same worktree. This applies equally
to implicit siblings, named siblings, and legacy in-place `seat` records; it
does not migrate or re-key their operations.

Historical or manually restored stores can still contain duplicate active
bindings. When every candidate has a distinct persisted bind order, every
process selects the newest and the older records are retired by the next store
write. Legacy duplicates without enough ordering information fail closed:
launcher and SessionStart output does not claim an identity or inbox path and
names `borg reset-local-connection` as the local recovery command. Borg never
guesses from credential-reference lexical order.

Only `active` records participate in normal selection. A bound `pending` record
is discoverable only by the convergence path that resends its exact bearer.
The persisted resolution is shared by SessionStart, kickoff construction, MCP
children, stream ownership, and normal active-cube hydration, so independent
processes do not select different seats for those surfaces. Definitive server
rejections remain process-local verdicts and are not persisted as seat state.
