# Self-Hosted Server

Install and initialize the server in the human operator's terminal:

```bash
npm install -g borgmcp-server
borg server setup
borg server start
```

The client owns the `borg server` facade. It forwards commands and renders
verified server evidence. It does not infer a checkout, activate an artifact,
create a service, or claim a build identity by itself. The server owns artifact
verification, activation, data and identity preservation, runtime build
identity, rollback, and explicit Linux/macOS service adapters. The server
executable remains the direct foreground authority.

`borg server start` and `borg-mcp-server start` are foreground commands. They
must never imply that a daemon, LaunchAgent, or systemd service was installed.
Ctrl-C stops the foreground process. Managed persistence is a separate explicit
handoff.

The available lifecycle facade commands are:

```text
Usage: borg server <command> [arguments]

Commands:
  setup    Prepare local server identity and data; does not start the server.
  start    Start the verified server in the foreground.
  stop     Stop the managed local server.
  status   Report verified runtime evidence.
  update   Verify and activate a local server artifact.
  invite   Create a single-use invitation in an interactive terminal.

Run borg server <command> --help for server command options.
```

Local server client credentials are stored in the owner-controlled
`~/.borg/credentials` file with mode 0600. Fresh same-machine setup provisions
the first owner record there, so bare `borg assimilate` can use it without an
invitation prompt. Use `borg server invite` explicitly when another client or
device needs a single-use invitation; its output is owned by the server.

Status reports only runtime evidence supplied by the server: running/stopped
state, exact running artifact and immutable build identity when available,
endpoint, process mode, and data-identity availability. If the running build
identity is unavailable, status says it is unavailable. It never substitutes a
source checkout, package cache, or guessed version.

Update has four visible phases: verification, activation, result, and next
action. Only a verified artifact may activate. A verification failure says no
activation occurred and that the last verified runtime remains available.

Keep the foreground server running. Open a second operator terminal in the
project checkout and run:

```bash
borg assimilate
```

Setup provisions the first same-machine owner credential directly, so this flow
does not ask for an invitation. For another client or device, run `borg server
invite` in the server operator's interactive terminal. On the intended recipient,
run `borg assimilate --host <server> --enroll` and enter the single-use invitation
at the labeled hidden prompt. Never put an invitation in argv, environment
variables, logs, or diagnostics.

For explicit invitation enrollment, the client generates a 256-bit credential
and UUID retry key and persists the exact tuple as `PENDING` in the 0600
credential file before network I/O. An ambiguous exchange retries that tuple
exactly; the credential becomes active only after the versioned response is
decoded and the authenticated protocol handshake succeeds. A new process
resumes that pending enrollment before displaying another invitation prompt.

`--cube-name <name>` explicitly selects the repository cube name. Without an
explicit name, Borg uses the `origin` repository name or, when `origin` is
absent, proposes the sanitized repository-directory basename. Confirm
interactively or pass `--yes`; bare repositories fail closed.

The connection is HTTPS-only. Borg validates the server trust material, stores
parent enrollment credentials in `~/.borg/credentials` and session credentials
in the existing 0600 seat store, and persists only an opaque credential
reference with the active cube. Local requests
use the server's `/api/cubes/*` coordination routes. They cannot use hosted OAuth
credentials or change authority implicitly.

The lifecycle facade invokes the separately installed `borgmcp-server`; it does
not bundle the server into the client. The server must be running and trusted
before assimilation. An owner enrollment carrying the persisted `create_cube`
capability creates one idempotent cube per repository during normal
assimilation, using the server-owned `default` role template; repeating an
ambiguous request does not duplicate the cube, and distinct repositories can
create distinct bounded cubes. An ordinary enrolled client is denied before a
create request is sent. Cloud-only capabilities fail explicitly rather than
being redirected.

After the first attach, the launched agent should run `borg_whoami` and
`borg_roster` to verify its seat and begin coordinating. To create a second seat,
the operator runs the explicit local assimilation command from the intended
worktree. A fresh worktree operation creates a distinct drone; an ambiguous
retry of that same operation resumes the same drone.

An identical `--here` rerun validates the saved local seat and reattaches by
re-sending the same client-generated session bearer — the sole server correlator —
instead of choosing another role or minting a new drone. The bearer is REUSED, not
rotated: the server binds only its digest, so a re-sent identical bearer resolves to
the existing seat. Ambiguous liveness or transport results never authorize a
replacement; only an authoritative eviction mints a fresh bearer and permits a
remint. (The `retry_key` idempotency key applies to enrollment and cube-creation
only — never to seat re-attach, which is idempotent through the bearer itself.)

The default discovery endpoint is `https://127.0.0.1:7091`. Explicit `--host` values may include another port but must pass the same trust and endpoint policy.

## Recovery commands

- No saved or rejected enrollment: generate a single-use invitation with
  `borg server invite`, then run `borg assimilate --host <server> --enroll` from
  the intended recipient's interactive terminal.
- Rejected or expired invitation: keep the server running and mint a replacement
  invitation with `borg server invite`, then rerun `borg assimilate --host
  <server> --enroll` with the replacement invitation.
- Revoked or superseded local session: run `borg reset-local-seat`, ask the
  operator for a new invitation from `borg server invite`, then run `borg
  assimilate --host <server> --enroll` with the server still running.
- Unloadable local seat: run `borg reset-local-seat --host <server>` to clear
  ONLY this worktree's saved local seat, then rerun `borg assimilate --host
  <server>` with the server still running.
- Unreachable server: start or restart it with `borg server start`, then
  rerun `borg assimilate --host <server>`.
- Trust mismatch after an intentional server re-initialization: verify the
  expected server identity, stop and restart `borg server start`, then retry.
- Busy local seat store: wait for the other Borg process to finish, then rerun
  the same command. If the local seat store cannot be read or written, ensure its
  directory on this machine is readable and writable, then rerun.
- Unusable project name: rerun with `--cube-name <name>`.
- Incompatible response: verify compatible client and server versions, then
  retry the same endpoint.

## Release status

This self-hosted path consumes the published `borgmcp-shared@0.6.1` v3 registry
release. The matching server owner-enrollment, cube-create, attach, restart, log,
and SSE implementation must also pass the full process-level local dogfood gate.
Until that gate opens the self-hosted path remains preview-only, and the client
publish is deferred accordingly.
