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
in the representative state database (see "State database" below). It holds
identifiers, the request ledger and delivery positions only — no credential and
no message text. The drone's credential stays in Borg's existing private
connection store. A representative drone serves one worktree: a second worktree
whose binding would share another worktree's binding generation is refused with
`BINDING_CONFLICT`.

To resume later, run `borg representative prepare --coordinator <coordinator-drone-label> --role <your-representative-role>` from inside the representative worktree (without `--worktree`), substituting
your saved labels. Recovery errors for a bound connection print that complete
command with its actual labels and worktree. Changing the cube or Coordinator
is refused unless you
pass `--rebind`; a rebind that changes the cube or Coordinator also discards the
old request ledger. A rebind of any kind, including one with the same cube and
Coordinator, requires restarting every adapter and the listener; running ones
refuse. A running `borg representative mcp` process answers `send`, `read`,
`deliver` and `ack` with `BINDING_MISMATCH` until the MCP host restarts it;
its `status` reports the new `binding_fingerprint` beside the
`pinned_binding_fingerprint` it started with. A running listener stops with
reason `rebound`.

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

For Hermes, `borg representative hermes-plugin install` writes this entry, and
the push plugin, for you; see "Hermes push plugin".

No token, key or URL belongs in this configuration. If the worktree is not
prepared, or its saved connection no longer matches the binding, the process
exits with an error on stderr and writes nothing to stdout.

Check a connection at any time with
`borg representative status --worktree <path>`.

### 4. Tools

| Tool | Purpose |
| --- | --- |
| `borg_representative-status` | Bound cube, representative, Coordinator; live re-check; unresolved sends; limits; `binding_fingerprint`. |
| `borg_representative-send` | Relay one `request`, `question` or `decision` to the bound Coordinator. |
| `borg_representative-read` | The bound Coordinator's replies after the delivered checkpoint, oldest first, bounded. Changes nothing. |
| `borg_representative-deliver` | Move the delivered checkpoint through a reply the host has durably persisted. |
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
specifies, and on the request ledger: every reservation is one state-database
transaction, so overlapping sends from any number of processes see each other
(see "Concurrency" below).

## Reading, delivery and wake limits

Four separate notions, each with its own tool or owner:

- **Receipt**: `read` returned the reply. Nothing moves; the same reply comes back
  on every `read` until it is delivered.
- **Delivered**: the host called `deliver` after durably persisting everything up
  to that reply. Only `deliver` moves the read window.
- **Processing and display**: the host's own business after delivery.
- **`ack`**: a signal to the Coordinator that a direct reply was received. It is
  not delivery and does not move the window.

Reading:

- `read` returns the Coordinator's replies addressed to the representative that
  come strictly after the delivered checkpoint, in `(created_at, entry_id)` order.
  Other drones' entries are counted in `ignored_entries` and never returned; the
  Coordinator's broadcasts are returned only with `include_broadcast`.
- `read` never advances the checkpoint or any server cursor. After a crash at
  any point, the next `read` returns every reply not yet delivered.
- Bounds: `limit` (1 to 50, default 10) is a hard cap on returned replies.
  `max_bytes` (4096 to 60000, default 32768) caps the serialized tool result.
  Replies are whole or omitted, never truncated; a reply that alone exceeds
  `max_bytes` is returned alone with `"oversize": true`. The serialized result
  never exceeds `max(max_bytes, 16384)` bytes: if an oversize reply is still
  larger than that, its document citations are reduced to ids and it carries
  `"documents_reduced": true`; message text is never cut. `status` reports this
  floor as `envelope_floor`; set the host's tool-result ceiling at or above it.
  The floor covers a message at the server's default post limit (4096 bytes)
  with ordinary metadata. JSON escaping (a message full of tabs or quotes) or
  heavy citation metadata can still push a single reply above it, as can a
  server that allows larger posts. Then `read` refuses with
  `REPRESENTATIVE_READ_OVERSIZE` (`entry_id`, `measured_bytes`, `bound`) and
  changes nothing; retry with a larger `max_bytes` (up to 60000).
- `read` scans past entries that are not for the representative until the page
  is full or the log ends, so it never returns no replies with `has_more: true`.
  `has_more` is true only when another reply follows the returned window.
  Page by delivering and reading again.
- The result includes `checkpoint` (`entry_id` and `created_at`; null until the
  first delivery, unless the upgrade below imported a 5.x checkpoint) and
  `binding_fingerprint`.

Delivering:

- `deliver` takes `{ "through": "<entry_id>" }` and moves the checkpoint to that
  reply. Call it only after the host has durably persisted every reply up to it.
- `through` must be a reply that `read` actually returned since the checkpoint
  last moved; membership is checked, not only the range, so a broadcast skipped
  by a read without `include_broadcast` is refused too. Any other entry is refused
  with `REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY` and nothing changes. The same or an older
  id is a no-op that returns `advanced: false`, so a retry after a lost result is safe.
- Implementation note: the checkpoint, an internal read fence (the latest reply
  any `read` returned) and the replies returned since the checkpoint last moved
  are rows of the state database, changed in one transaction. `deliver` accepts
  only one of those returned replies. None of this is part of the interface.

Binding fence:

- `binding_fingerprint` is the hex SHA-256 of the canonical JSON array
  `[origin, trustIdentity, cubeId, representativeDroneId, coordinatorDroneId, boundAt]`.
  It changes on every rebind and on a server trust change, and contains no path or
  credential. `prepare --rebind` always starts a new generation, even when the
  cube and Coordinator stay the same. It appears in `status`, `read`, `send`, `deliver` and the listener's
  `listening` event. Persist it at binding time; if any result shows a different
  value, stop routing and hold for the human.

Where a binding's replies start:

- A binding prepared by this version starts at its binding time: `read` returns
  every addressed reply created after `prepare` (or `prepare --rebind`) and none
  from before it. A rebind of any kind starts a new generation this way.
- Bindings prepared by borgmcp 5.x are imported once, when this version first
  creates its state database (the first `prepare`, `mcp`, `listen` or tool call;
  `status` creates nothing). The 5.x files are only read, never changed, and
  never read again afterwards — not by a lookup and not after `reset-state`. A
  worktree whose 5.x binding cannot be read then is not prepared. Each imported
  binding's replies start from:
  - its valid 5.x delivered checkpoint: replies after that checkpoint are
    returned, and the checkpoint is kept;
  - a valid 5.x checkpoint that never delivered anything: the binding start;
  - no 5.x delivery history at all for the representative drone (no checkpoint
    for any generation, no upgrade marker): the newest entry of the cube log at
    its first use, so only new replies are returned (the binding start instead
    if another generation of the drone already has delivery state by then, or
    if the log is too long to reach its end in a bounded read);
  - anything else, including a 5.x file that cannot be read or fails the
    private-file checks (a regular file you own, no group or other access, not a
    symlink): the
    binding start. Unreadable history is never treated as absent, so this
    returns replies again rather than skip any; deduplicate by `entry_id`.
- The start is decided once per binding generation and never changes.

Known limits:

- Retention is the server's cube log; nothing local is a content source.
- Each `read` scans the cube log from the checkpoint, including entries not
  addressed to the representative, so a host that never calls `deliver` pays a
  growing scan. Deliver promptly.
- Replies preserve document citations (id, title and state). Document bodies are
  not included and cannot be fetched through this connection. Ask the Coordinator
  to provide the content through a supported channel.

Concurrency:

- Any number of processes may use the tools at once. Every `send` reservation,
  `read` window and `deliver` is one transaction on the state database, so
  overlapping calls from different processes never lose or double an update.
  `status` is read-only in every process.
- A rebind while a call is running refuses that call with `BINDING_MISMATCH`
  and changes nothing in the new binding's state. An already issued network
  request cannot be cancelled; retry an ambiguous send with its original
  `request_id`.
- `in_reply_to` is a textual match of a known `request_id` quoted in the reply.
  It is a convenience, not a protocol guarantee.

Wakes:

- **The MCP process does not push content.** The separate `listen` process
  (the push engine) wakes the host when the bound Coordinator sends a direct
  reply; the woken conversation calls `read` for the content. A wake is neither
  a delivery receipt nor authority.
- A wake stops only when the reply is delivered. An undelivered reply is woken
  again after 10 minutes, 1 hour, 6 hours, then every 24 hours.
- Wake state lives in the state database; see "Supervised listener".

### Host conversation routing

Several processes may use the tools, but each binding has one delivered
checkpoint; the host decides which conversation reads and delivers. The host must record which conversation owns each `request_id`, persist every
reply durably before calling `deliver`, and route replies using `in_reply_to`.
Hold replies with an unknown or missing request ID for the human instead of
dropping them. Borg cannot enforce these duties inside the host; it provides one
delivered checkpoint per binding, not one per conversation.

## Supervised listener

The push engine is a separate long-lived process, run by the host that
handles its wakes:

```bash
borg representative listen --worktree <path> --protocol 2
```

`--protocol 2` is required, and stdin must be a pipe the host owns: a terminal
or `/dev/null` refuses with `REPRESENTATIVE_LISTENER_HOST_REQUIRED`. When the
host closes stdin (it exited, even by SIGKILL), the listener exits 0.

There is one listener per representative drone and server authority (the
listener lease); the tools need none. A second listener refuses with exit 3.
A dead owner or expired heartbeat permits takeover; a process that loses the
lease exits 4 and must be restarted.

Stdout is newline-delimited JSON only. Stderr contains human diagnostics and
must not be parsed. The host must ignore unknown fields and unknown event types.

| Event | Fields and meaning |
| --- | --- |
| `refused` | The only stdout line on a startup refusal: `code`, `exit_code`. Another listener uses `REPRESENTATIVE_LISTENER_OWNED`, plus `owner_pid` and `owner_started_at`. |
| `listening` | Started and holding the lease: `protocol` (2), `binding_fingerprint`, `undelivered` (replies the engine already knows are undelivered). |
| `wake` | `wake_id`, `reason` (`startup`, `new-reply` or `rewake`), `count`. No message body, sender or id. |
| `stopped` | `reason`: `signal`, `eof`, `evicted`, `rebound`, `revoked`, `trust-changed`, `lease-lost` or `fatal`; `exit_code`. |

Stdin carries the host's answer to each wake, one JSON line of at most 1 KiB:

```json
{"wake_id": "<wake_id>", "accepted": true}
```

`accepted: true` means the host started the woken turn; `false` means it could
not (the conversation was unavailable).

How wakes are decided (all of it in the state database, per binding generation):

- The engine finds direct replies from the bound Coordinator by reading the log
  itself; the server stream only tells it when to look. It reads 200 entries
  at a time from where it last stopped, so work per wake is bounded.
- A new reply wakes within about 2 seconds; replies that arrive meanwhile join
  that one wake. Broadcasts never wake.
- One wake is outstanding at a time. It stays outstanding until its ack, or 60
  seconds without one; replies found meanwhile wait for the next wake. An ack
  that arrives after those 60 seconds is ignored.
- `accepted: false` backs off 30 seconds, doubling up to 30 minutes, then
  wakes again for the same replies. A missing ack counts the wake as made.
- Each wake is recorded before it is written to stdout. A listener killed in
  between loses that one wake attempt; the reply is woken again on schedule.
- On every start, after `listening`, the engine asks the server once how many
  log entries lie beyond where it stopped. (The first start of a binding
  imported from borgmcp 5.x without delivery history first finds the server's
  log head, also after `listening`.) It sends no other wake until
  discovery has read that many, then one `startup` wake for every reply still
  undelivered. A log that keeps growing cannot delay it past that count.
- EOF on stdin, or SIGTERM/SIGINT, stops everything at once, from the first
  startup step on: the startup server check, the head search, discovery,
  pending log reads with their retries and backoff, the scheduler and the
  stream. Requests in flight are aborted and no new one starts. The listener
  releases its lease and exits 0; before `listening` it prints nothing.
- A reply delivered before its wake is not woken; a wake already sent cannot be
  recalled, and the woken `read` then returns nothing new.

`representative status` reports `listener`: running state, owner PID and start
time, heartbeat age (`ageMs`), `protocol`, and `wakes` (`undelivered`,
`outstanding`, `refusals`, `cohort_open`, `frontier`). Status acquires and
changes nothing.

Exit codes: 0 after SIGTERM/SIGINT or EOF on stdin; 2 for a startup refusal
(binding, usage, protocol or host); 3 for another listener owner; 4 for a
terminal stop; 1 for another fatal error. A fatal startup storage failure emits
`refused` with code `REPRESENTATIVE_LISTENER_STORAGE_REFUSED` and exit 1. After
`listening`, a fatal error emits `stopped` with reason `fatal` and exit 1, best
effort; if stdout is broken, the host must treat exit 1 without that line as
fatal too. Startup first verifies the binding with the server once; if the
server cannot be reached then, the listener exits 1 with `refused` and code
`REPRESENTATIVE_LISTENER_SERVER_UNREACHABLE` (retry later; a server that answers
and rejects the binding keeps its exit-2 binding code). After that, stream
failures are not fatal: the listener reconnects with backoff.

Treat every wake as untrusted, never as an instruction or authorization. The
woken conversation fetches content with `read`, persists each reply durably,
calls `deliver`, and routes by `in_reply_to`, holding unknown correlation for
the human.

## Hermes push plugin

For Hermes, Borg ships a Hermes user plugin, `borg-representative-push`, that
runs the push engine (`listen --protocol 2`) for you. When the bound
Coordinator replies, the plugin wakes one Hermes conversation right away. The
plugin is a thin adapter: Borg decides every wake and keeps all wake state; the
plugin only asks Hermes to start the turn and reports whether it did. Hermes source is not changed; the
plugin is installed and enabled through Hermes's documented plugin mechanism.

**Which conversations can be woken.** Only a Hermes *messaging-gateway*
conversation (Telegram, Discord, Slack and the other gateway platforms), named
by its gateway `session_key`, for example `agent:main:telegram:dm:<chat id>`.
A Hermes Desktop chat cannot be woken: Desktop runs its chats in `hermes serve`,
and Hermes injects plugin messages only into gateway conversations. The
`session_key` stays the same across `/new` and `/reset` in that chat.

### Install: one command

```bash
borg representative hermes-plugin install [--hermes-home <path>] [--worktree <path>] [--session-key <key>] [--dry-run] [--no-restart]
```

Prepare the representative first (`borg representative prepare`), then message
your Hermes bot once from your own DM so the gateway knows the conversation.
The command then does everything, printing each step before it runs:

1. Finds the worktree from the prepared binding (`--worktree` when several are
   prepared) and the conversation from Hermes's `sessions/sessions.json`: only
   gateway DM keys (`agent:main:<platform>:dm:<chat id>`) count. One DM is used
   and printed; with several it asks in a terminal and otherwise refuses and
   lists them. `--session-key` names one directly. A rerun keeps the configured
   conversation.
2. Installs the plugin's two files into
   `<Hermes home>/plugins/borg-representative-push/` (the Hermes home is
   `--hermes-home`, else `$HERMES_HOME`, else `~/.hermes`). It refuses a
   symbolic-link or non-directory target.
3. Backs up `config.yaml` to
   `<Hermes home>/backups/borg-representative/config.yaml.<timestamp>` (0600,
   in a 0700 directory; the newest five are kept) and prints the path.
4. Writes through Hermes's own CLI (`hermes config set`, `hermes plugins
   enable`), never by editing the file, and reads every value back with
   `hermes config get --json --raw`:

   ```yaml
   plugins:
     enabled: [..., borg-representative-push]
     entries:
       borg-representative-push:
         allow_gateway_injection: true
         settings:
           session_key: agent:main:telegram:dm:<chat id>
           worktree: /absolute/path/to/representative/worktree
           borg_command: /absolute/path/to/borg
   mcp_servers:
     borg-representative:
       command: /absolute/path/to/borg
       args: [representative, mcp, --worktree, /absolute/path/to/representative/worktree]
       lazy: true
   ```

   Settings left over from the 5.x plugin (`mcp_server`, `reinject_after_s`,
   `max_reinjects`) are removed.
5. Runs `hermes serve --stop`; Hermes Desktop restarts its backend with the new
   MCP entry. It restarts the gateway (`hermes gateway restart`) only when
   `hermes gateway status` shows it running as a launchd or systemd service,
   and confirms the restart afterwards. A gateway started by hand is never
   restarted by Borg: without a service Hermes would run the new gateway in the
   foreground of Borg's process. The command prints the one line to run where
   that gateway runs instead. Every Hermes call has a hard timeout that ends
   only Borg's own `hermes` process.
6. Reports whether the gateway is open to everyone (`gateway.allow_all_users`,
   `GATEWAY_ALLOW_ALL_USERS` or `<PLATFORM>_ALLOW_ALL_USERS`). An open gateway is
   reported, not refused: anyone who can message the bot can then read
   Coordinator replies and send as the representative.

If a step fails, `config.yaml` is restored from the backup, but only when it is
still exactly what the command last wrote. If anything else changed it
meanwhile, nothing is restored, and the command prints the steps it applied and
the backup path.
When every value and file already matches, the command prints that the plugin is
already installed and changes nothing. `--dry-run` only reads Hermes config and
prints the plan; `--no-restart` skips step 5.

The command runs `hermes` with your normal environment, so Hermes's own startup
maintenance runs exactly as it does for any `hermes` command you type.

`allow_gateway_injection` is Hermes's per-plugin permission to start gateway
turns; it is off by default. `lazy: true` lets Hermes register the Borg tools
from its schema cache and start `borg representative mcp` on first use.

**Updates.** `borg update` activates an installed plugin (its directory is the
marker): it refreshes the files, rewrites the settings and MCP entry with the
same rules, and restarts as in step 5. Without the directory it runs no `hermes`
command. A running Hermes CLI session reloads the MCP entry itself when it goes
idle. A session with `mcp.auto_reload_on_config_change: false`, or one that
never goes idle, keeps its old Borg adapter until it reloads MCP or ends; Borg
does not work around that Hermes setting.

**Status.** `borg representative status` adds `hermes_plugin`: whether the plugin
is installed, its conversation and the open-gateway report.

**Uninstall.**

```bash
borg representative hermes-plugin uninstall [--hermes-home <path>] [--dry-run] [--no-restart]
```

It removes the plugin from `plugins.enabled`, unsets
`plugins.entries.borg-representative-push` and the `borg-representative` MCP
entry (only when that entry runs `representative mcp`), deletes the plugin's two
files and its directory when nothing else is in it, and restarts as in step 5.
The backup and rollback rules are the same.

**Which process delivers.** Any Hermes process may read and deliver: Desktop,
the CLI or the gateway conversation. Borg stops waking for a reply once it is
delivered from any of them.

### Behaviour

- The listener starts only inside the Hermes messaging gateway, when the platform
  named in `session_key` connects. The CLI, Desktop and worker processes load the
  plugin but start nothing. A platform reconnect does not start a second listener.
- Each `wake` becomes one injected message with fixed text: `Borg: new
  Coordinator reply. Call borg_representative-read, persist and relay, then
  borg_representative-deliver through the last persisted entry_id.` No message
  body, sender or document ever passes through the plugin. A busy conversation
  queues the message; it does not interrupt the running turn.
- The plugin writes Hermes's answer back to the listener: accepted, or not (for
  example `allow_gateway_injection` is off or the conversation is unavailable).
  Borg then decides the rest: it wakes again for a reply still undelivered
  after 10 minutes, 1 hour, 6 hours and then every 24 hours, and backs off
  after a refusal (30 seconds, doubling to 30 minutes). See "Supervised
  listener".
- Listener exits: 0 stops; 1 restarts with capped backoff; 2 stops and logs
  (fix the binding, update borgmcp, or check the listener protocol, then restart
  the gateway); 3 (another listener holds the lease) retries with backoff; 4
  restarts after `lease-lost` and otherwise stops and logs (evicted, rebound,
  revoked, trust-changed).
- A listener that does not announce protocol 2 (an older borgmcp) is never
  driven: the plugin stops it and logs that borgmcp must be updated.
- The plugin owns the listener's stdin pipe. When the gateway exits, even when
  it is killed, the pipe closes and the listener exits on its own: nothing is
  left running, and the next gateway starts a new one.
- The plugin keeps no state and writes no files. The listener's diagnostics go
  to the Hermes log, one line at a time, capped at 500 characters.

## State database

Bindings, the request ledger, delivery positions and wake state live in one
SQLite database (Node's built-in `node:sqlite`, which is why borgmcp requires
Node.js 22.13 or later):

```text
<Borg config>/representative/state/
  CURRENT            names the current generation; replaced only by an atomic rename
  publish.sqlite     an empty lock file that serializes creation and reset
  <generation>/      mode 0700
    state.sqlite     mode 0600, with SQLite's -wal and -shm files (also 0600)
```

Every path is checked on every open (a real file or directory you own, the
modes above, never a symlink); a failing check refuses with
`REPRESENTATIVE_STATE_INVALID` and nothing is repaired automatically. Nothing
from borgmcp 5.x is changed: its `representative.json` and delivery files are
read once, when the database is first created (see "Where a binding's replies
start"), and never written.

Wake state is derived data. When a binding's wake state or one of its wake
records is invalid (for example hand-edited), the listener discards that
binding's wake state in one transaction, logs one line on stderr, and rebuilds
it from the delivered checkpoint and the log. The delivered checkpoint and the
rest of the database are unchanged; this needs no `reset-state`.

The lock is local: exclusivity holds between processes on this host and this
filesystem, not across hosts sharing a network filesystem.

`borg representative reset-state` is disaster recovery for a corrupt database
only; it refuses a healthy one and a database of another version. It builds a
new generation holding every binding that still reads back and passes the same
checks as `prepare`, publishes it over `CURRENT`, and prints what was kept and
lost. A binding it cannot keep is not restored from anywhere else: that
worktree reports `NOT_PREPARED` until it is prepared again. The damaged
generation is left in place; the three most recent earlier
generations are kept, older ones removed (only the database files, never
anything else in the directory). Lost in a reset:

- every delivery checkpoint: kept bindings return their replies again from the
  binding start (duplicates are possible, nothing is skipped; deduplicate by
  `entry_id`);
- the request ledger: pending and ambiguous sends are no longer guarded, so a
  send whose outcome was unknown may already be stored and identical content is
  no longer blocked;
- wake state, which the listener rebuilds.

A binding that could not be kept is listed; run `borg representative prepare`
in that worktree again.

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
| `BINDING_CONFLICT` | `prepare` would change the saved cube or Coordinator (confirm with the printed `--rebind` command), or another worktree already holds this binding generation (give each worktree its own representative seat). |
| `REPRESENTATIVE_STATE_INVALID` | A state path (named in the message) is not safe: a symlink, a wrong owner or mode, a missing generation, or damaged `CURRENT`. Nothing was read or written and nothing is repaired automatically. Fix the named path (a real directory 0700 or file 0600 that you own); do not change permissions through a symlink. |
| `REPRESENTATIVE_STATE_CORRUPT` | The state database is corrupt (SQLite reported corruption). Every tool except `status` refuses; `status` (the CLI command and the MCP tool, which still starts) reports it as `state_problem` without a binding. Run `borg representative reset-state`, read its report of what was kept and lost, then restart the MCP server and the listener. |
| `REPRESENTATIVE_STATE_VERSION` | The state database was written by a different borgmcp version. Nothing was read or written. Use the borgmcp version that wrote it. This is not corruption, and `reset-state` refuses it. |
| `REPRESENTATIVE_STATE_BUSY` | The state moved to a new generation twice during one call (concurrent resets). Nothing was changed; retry. |
| `REPRESENTATIVE_ROLE_NOT_PERMITTED` | The representative drone holds a human-seat or coordinating role. Give it its own worker role. |
| `REPRESENTATIVE_READ_OVERSIZE` | The next reply does not fit `max(max_bytes, 16384)` bytes even with its citations reduced to ids (heavy JSON escaping or citation metadata, or a server allowing posts above its default 4096-byte limit). Nothing was read or advanced. Retry with a larger `max_bytes` (up to 60000); beyond that the operator must lower the server's post limit. |
| `REPRESENTATIVE_DELIVER_UNKNOWN_ENTRY` | `deliver` named an entry that `read` has not returned (or no Coordinator reply). Nothing changed. Call `read`, persist what it returns, then deliver through its last `entry_id`. |
