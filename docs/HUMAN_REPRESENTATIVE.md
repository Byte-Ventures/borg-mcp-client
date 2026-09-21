# Human Representative

`borg representative` lets a standard MCP host — for example Hermes — speak
**for the human** to one existing Coordinator drone and read its replies. It is
a client-side feature: it uses the ordinary cube log, addressing,
acknowledgement and saved-connection mechanisms. The Borg server has no special
"representative" concept and enforces nothing extra for it.

## Vocabulary

- **Cube**: one repository's shared coordination space on your Borg server.
- **Drone**: one connected agent session in a cube. Its **role** defines how it
  works.
- **Human seat**: the one role in a cube that speaks with the human's
  authority.
- **Coordinator**: the drone holding the human seat. It owns the coordination
  playbook and dispatches the other drones.
- **Human representative**: a *separate* automated drone under its own
  non-human-seat role. It relays the human's requests, questions and decisions
  to that one Coordinator and reads the Coordinator's replies. It is not the
  human, never takes or replaces the human seat, carries none of the
  Coordinator's playbook, and cannot address other drones or broadcast.
- **Binding**: the saved selection of one server, one cube, one representative
  drone and one Coordinator drone for one worktree.

## Lifecycle

### 1. Create the representative role once

The representative needs an existing role that is **not** the human seat and
not a coordinating (queen-class) role. The default name is
`hermes-representative`. Create it with the cube's normal role management (for
example ask the Coordinator to run `borg_create-role`). Keep its text short,
for example: *"Relays the human's requests, questions and decisions to the
Coordinator and reports the Coordinator's replies back. Does not plan, dispatch
or review work."* Do not copy the Coordinator role into it.

### 2. Prepare the connection

From the repository whose cube you want, name the exact Coordinator drone
(`borg drones` lists labels):

```bash
borg representative prepare --host <host:port> --coordinator <coordinator-drone-label> --worktree hermes
```

Replace `<host:port>` with your existing Borg server's address. The bare
`host:port` form is accepted (for example `127.0.0.1:7091`) and defaults to HTTPS.
Always pass `--host` for scripted or non-interactive runs. In an interactive
terminal, omitting it makes `prepare` attempt server detection and ask you to
confirm the detected server or enter its address.

This creates the representative's own drone in a new linked worktree through
the same path as `borg assimilate --worktree`, but **launches no agent CLI** and
does not touch any other drone. It then verifies against the live cube that:

- the new drone's role is the requested one, and is neither the human seat nor
  a coordinating role;
- exactly one active drone has the given label, it is not the representative
  itself, and it holds the human seat.

A missing, evicted, duplicated or non-human-seat Coordinator fails with a named
error. Another drone is never chosen instead. On success the binding is saved
in Borg's private configuration directory (`representative.json`, mode 0600).
That file holds identifiers and a request ledger only — no credential and no
message text. The drone's credential stays in Borg's existing private
connection store.

To resume later, run `borg representative prepare --coordinator <coordinator-drone-label> --role <your-representative-role>` from inside the representative worktree (without `--worktree`), substituting
your saved labels. Recovery errors for a bound connection print that complete
command with its actual labels and worktree. Changing the cube or Coordinator
is refused unless you
pass `--rebind`; a rebind also discards the old request ledger. A running
`borg representative mcp` process never picks up a rebind: its calls fail
closed until the MCP host restarts it.

`prepare` reuses Borg's connection and worktree preparation, including its
private-state initialization and saved-connection checks. It does not require
Claude Code, Codex or OpenCode, write their configuration or preferences,
provision their launch access, report an agent identity, or install a session
hook. Nothing is started. An explicit `--host` that conflicts with the saved
connection is refused before preparation.

A confirmed evicted drone uses the ordinary connection recovery path. Revoked,
superseded, unreachable and changed-trust connections remain distinct refusals;
they are not treated as eviction. After recovery changes the drone identity,
confirm the new selection with the printed `--rebind` command.

First-time role creation and actual linked-worktree provisioning have not yet
been exercised live for this interface. The current evidence uses controlled
backends; this is not a claim of live onboarding verification.

### 3. Configure the MCP host

The Borg server speaks pinned-TLS HTTPS, not MCP, so the host starts a local
stdio MCP process. A generic configuration (shown in Hermes-style YAML; adapt
the keys to your host):

```yaml
mcp_servers:
  borg-representative:
    command: borg
    args: ["representative", "mcp", "--worktree", "/absolute/path/to/representative/worktree"]
```

No token, key or URL belongs in this configuration. If the worktree is not
prepared, or its saved connection no longer matches the binding, the process
exits with an error on stderr and writes nothing to stdout.

Check a connection at any time with
`borg representative status --worktree <path>`.

### 4. Tools

| Tool | Purpose |
| --- | --- |
| `borg_representative-status` | Bound cube, representative, Coordinator; live re-check; unresolved sends; limits. |
| `borg_representative-send` | Relay one `request`, `question` or `decision` to the bound Coordinator. |
| `borg_representative-read` | Unread replies from the bound Coordinator addressed to the representative. Drains everything it fetches. |
| `borg_representative-ack` | Signal to the Coordinator that one direct reply was received. Nothing more. |

There is no tool for logging to other drones, broadcasting, role or drone
management, grants, eviction, release, regeneration or server lifecycle, and no
generic dispatcher. `send` rejects any recipient field.

New network operations re-verify the live cube first: the connection must still be the
bound drone in the bound cube, still under a permitted role, and the bound
Coordinator must still be an active human-seat drone. Otherwise the call fails
and nothing is sent. A cached sent retry returns its historical receipt without
a live re-check; use `borg_representative-status` to check the current connection.

## Attribution and authority

Each relayed message starts with a fixed header:

```text
[HUMAN-REPRESENTATIVE · automated relay via <representative-label> · not typed by the human]
request_id: <uuid>
kind: request | question | decision
authorization: user-authorized — … | model-advice — …
reply: direct to <representative-label>, quoting the request_id.
---
<message>
```

- `user_authorized` means the representative asserts the human explicitly
  authorized that exact text. `model_advice` marks the model's own suggestion.
  A `decision` is refused unless it is `user_authorized`.
- This label is the representative's own statement. **The Borg server does not
  verify or enforce it.** On the server these are ordinary posts from the
  representative drone. A relayed decision authorizes only its own text; it is
  not proof of broader human approval, and the Coordinator should treat it that
  way.

## Request identity, retries and ambiguous sends

`send` returns a `request_id`, which is also the protocol `post_id`
idempotency key of the log append.

- The lookup, the conflict decision, the id allocation and the `pending`
  reservation happen in one locked ledger transaction, before any network use.
  Two overlapping sends of the same content without a `request_id` therefore
  cannot both go out: the second is refused (`AMBIGUOUS_SEND_UNRESOLVED`) and
  names the first one's `request_id`. This is not a content filter: once a
  request is settled, sending identical content again is a new, legitimate
  request.
- Within the same server database, cube and representative drone, re-sending
  the same `request_id` with identical content never creates a second message:
  a request already recorded as sent is answered from the local
  ledger, and otherwise the server deduplicates on `post_id`. The same
  `request_id` with different content is refused (`REQUEST_ID_CONFLICT`). The local
  ledger retains only the newest 200 settled requests; unresolved requests are
  retained. Older settled retries depend on server deduplication. Changing the
  database, cube or drone is outside that guarantee.
- Invalid input, and a payload the protocol would refuse, fail before anything
  is reserved. The live cube is verified before posting; if that check fails,
  nothing was sent and the reservation is released.
- The representative makes exactly **one** transport attempt per call (the
  client's usual automatic retry after a connection reset is switched off for
  it). Only because of that, a typed refusal the server returns to that attempt
  is reported as `SEND_REJECTED` — *this attempt was not stored*: a rejected,
  revoked or superseded credential, an evicted drone or deleted cube, or an HTTP
  4xx answer. The error carries the underlying cause code and a recovery step
  (for example: restore the connection with `prepare`; wait out a rate limit
  and retry the same `request_id`; a `POST_ID_CONFLICT` goes to the operator).
  That is a statement about the one attempt, not about the server's internals:
  it assumes a server that answers 4xx instead of storing.
- Everything else is reported as `outcome: "ambiguous"`: no answer or a
  timeout, an HTTP 5xx, a response that cannot be read or violates the protocol
  (which can happen *after* the server stored the message), a TLS trust failure,
  or any unrecognised error. The result names a bounded, sanitized `cause` and
  a matching recovery hint. Nothing is re-sent across calls. The request stays
  under `unresolved_requests` — across restarts — until a retry with the same
  `request_id` settles it, and the same content under a new id is refused
  meanwhile. There is deliberately no "forget it and resend under a new id"
  operation.
- If an earlier attempt under a `request_id` was ambiguous, a later definite
  refusal of a retry does not clear it: the request stays unresolved, because
  the earlier attempt may have been stored.

Exactly-once delivery is therefore not claimed; at-most-once per `request_id`
relies on the server honouring `post_id` deduplication as the shared protocol
specifies, and on the single-process rule below.

## Reading, cursors and wake limits

- `read` drains only the representative drone's **own** unread cursor. Other
  drones' cursors are separate client-owned state and are never touched.
- A read **consumes everything it fetched**, not only what it returns: the
  Coordinator's replies, and equally the entries it ignores (other drones'
  entries are counted in `ignored_entries` and never returned; the
  Coordinator's broadcasts are returned only with `include_broadcast`). None
  of them appear unread again.
- If the MCP host stops between reading a reply and relaying it to the human,
  that reply is gone from the unread view. It still exists in the cube log, but
  this version offers no tool to list past replies again. Persist the read result
  in the host before relaying it.
- Replies preserve document citations (id, title and state). Document bodies are
  not included and cannot be fetched through this connection. Ask the Coordinator
  to provide the content through a supported channel.
- `limit` is a page-size hint, not a hard cap: when the unread backlog is
  large the client's digest mode fetches, and drains, more than `limit`.
- `ack` is only a signal to the Coordinator that a direct reply was received.
  It does not make delivery reliable, and it neither advances nor restores the
  unread cursor.
- Exclusive process ownership is enforced for each representative drone. Processes
  may start idle; the first `send`, `read` or `ack` takes the lease. Other processes
  receive `REPRESENTATIVE_OWNERSHIP_REQUIRED` before any ledger reservation or
  write, cursor access, or network call. The refusal names the owner's PID and
  start time. Use that host, or wait for it to exit before using another.
- `status` is allowed in every process, is read-only, and takes no lease. Its
  `ownership` field reports the state, PID, start time, and heartbeat age in
  milliseconds (`ageMs`). A clean exit releases ownership; a dead PID or a
  heartbeat older than 70 seconds permits takeover without manual cleanup.
  A process that loses its lease refuses further activity until restarted.
  An already in-flight network operation cannot be cancelled by a local lease;
  same-request retries across takeover still use the existing ledger and server
  deduplication. Retry an ambiguous send with its original `request_id`.
- `in_reply_to` is a textual match of a known `request_id` quoted in the reply.
  It is a convenience, not a protocol guarantee.
- **There is no background wake.** A generic MCP host receives nothing
  unsolicited: replies are seen only when the host calls
  `borg_representative-read`. This version provides explicit send/read round
  trips only and makes no claim of automatic ongoing coordination. The
  Coordinator is woken by the direct message through its own normal wake path.

### Host conversation routing

The lease selects one consuming process, not a conversation within that host.
The host must record which conversation owns each `request_id`, persist every
read result before relaying it, and route replies using `in_reply_to`. Hold
replies with an unknown or missing request ID for the human instead of dropping
them. Borg cannot enforce these duties inside the host; it provides neither a
durable inbox nor a separate unread cursor for each conversation.

## Recovery

Run `borg` with the Node installation that owns the global `borgmcp` install;
a different Node prefix can fail the local server-installation check even when
the server is installed under the original prefix.

| Error | Meaning and action |
| --- | --- |
| `NOT_PREPARED` | No binding for that worktree. Follow the initial preparation command above with an explicitly chosen Coordinator. |
| `SEAT_UNAVAILABLE` | The representative drone's saved connection is gone or rejected. Run the complete recovery command printed in the error; it includes the worktree, Coordinator and role. |
| `BINDING_MISMATCH` | The worktree's connection is not the bound server/cube/drone, or the binding changed under a running process. Run the printed command to confirm the rebind, then restart the MCP process. |
| `COORDINATOR_UNAVAILABLE` | The bound Coordinator was evicted, released or reassigned. Restore the bound Coordinator and use the printed recovery command, or deliberately substitute a new Coordinator label in that command. |
| `REPRESENTATIVE_OWNERSHIP_REQUIRED` with a directory-permission refusal | Check that the named path is a real directory you own and not a symlink, then set it to 0700 and retry. Restart a process that had already lost ownership. Do not change permissions through a symlink. |
| `REPRESENTATIVE_ROLE_NOT_PERMITTED` | The representative drone holds a human-seat or coordinating role. Give it its own worker role. |
