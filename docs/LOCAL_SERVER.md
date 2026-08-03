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
  cube init   Initialize this Git repository's cube; does not create a drone.

Run borg server <command> --help for server command options.
```

`borg server cube init --help` derives accepted template names from the pinned
shared release. Relevant options include:

```text
borg server cube init (borgmcp <version>) — initialize this Git repository's cube without creating a drone

Usage:
  borg server cube init [options]

Options:
  --host <host>                    Borg server host or URL (bare hosts default to HTTPS)
  --enroll                         Prompt for a hidden enrollment invitation
  --cube-name <name>               Repository cube name (otherwise edit the proposed name)
  --template <name>                 New-cube template (default: recommended template)
  --yes, -y                        Accept new-cube defaults; never adopt by name
  --help, -h                       Show this help

An existing repository association skips all prompts. One accessible exact-name legacy
cube requires explicit interactive adoption; ambiguous matches fail closed. An enrolled
owner client may create a repository cube; ordinary clients require an explicit cube grant.
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

`borg assimilate` and `borg server cube init` share one repository-cube flow.
An existing local or server repository association is resolved without prompts.
Otherwise Borg checks accessible cubes against the exact proposed name. One
match displays the cube, repository, and server and requires explicit interactive
confirmation before the server atomically associates it; multiple matches fail
closed. `--yes` never adopts a cube by name. With no match, an authorized owner
continues to the creation guide, which shows the repository and server, proposes
an editable name, offers every new-cube template shipped by the pinned shared
release with the recommended template first, and asks for one confirmation.
`--cube-name <name>` and `--template <name>` supply those creation values
directly; run either command with `--help` for the accepted template names.
`--yes` accepts the repository default name and recommended template. `borg
server cube init` stops after authoritative cube readback and never creates a drone. Bare
repositories fail closed.

For repositories with a canonical public `origin`, that origin is the stable
repository identity. Repositories without one receive an invisible UUID stored
in an owner-only local file. Its lookup key is an HMAC of the canonical Git
common directory, so linked worktrees share one identity and local paths are not
stored in cleartext. A malformed identity secret or state file fails closed.

The connection is HTTPS-only. Borg validates the server trust material, stores
parent enrollment credentials in `~/.borg/credentials` and session credentials
in the existing 0600 seat store, and persists only an opaque credential
reference with the active cube. Local requests
use the server's `/api/cubes/*` coordination routes. They cannot use hosted OAuth
credentials or change authority implicitly.

The lifecycle facade invokes the separately installed `borgmcp-server`; it does
not bundle the server into the client. During interactive setup or a first
`borg assimilate` with no selected server, the client offers to install the
exact server release that pins the same `borgmcp-shared` version. A
non-interactive invocation never prompts or installs; run `borg setup` in an
interactive terminal, or pass `borg assimilate --host <host>` to use an
existing server. The server must be running and trusted before assimilation.
An owner enrollment carrying the persisted `create_cube`
capability creates one idempotent cube per repository during normal
assimilation or `borg server cube init`, using a template shipped by the pinned
shared release; repeating an
ambiguous request does not duplicate the cube, and distinct repositories can
create distinct bounded cubes. An ordinary enrolled client is denied before a
create request is sent. Cloud-only capabilities fail explicitly rather than
being redirected.

## Agent Launch State

Borg tools are inactive unless the agent session was launched with `borg`.
For Claude Code and Codex, `BORG_DISABLE_LAUNCH_REMINDER` is a presence-based
local opt-out for launch orientation messaging; setting it does not activate
Borg tools or change server authorization. OpenCode has no launch-reminder
surface.

## Updating Borg

For an npm-global installation, use the whole-product command:

```bash
borg update
```

The command performs a zero-mutation registry preflight for the exact proposed
`borgmcp` and `borgmcp-server` versions, their SHA-512 integrity values, and an
identical exact `borgmcp-shared` dependency pin. Lookup and installation are
bound to the canonical `https://registry.npmjs.org/` authority and one proven npm
executable, global prefix, and global root. An alternate configured registry,
changed npm context, registry failure, malformed manifest, mismatched or ranged
shared pin, unsupported package manager, or ambiguous binary fails before
confirmation and mutation with manual-update guidance.

The client is installed first. Borg then verifies and re-enters through the new
client binary before any server mutation. If that install, verification, or
re-entry fails, the server controller and runtime are untouched. When a server
was already installed, the new client installs the target controller before
invoking `borg-mcp-server update --json`; this ensures the runtime phase uses the
current structured contract rather than the stale controller being replaced.
The client strictly decodes server update and status JSON and never executes a
rendered `next_action` string.

Final verification requires the installed client and server manifests, their
installed shared packages, controller identity, prepared artifact and integrity,
and any running artifact and pinned-TLS protocol identity to agree. A previously
stopped server remains stopped; matching controller and prepared runtime are
reported as `prepared; still stopped` without inventing a live protocol check.
An absent server is skipped rather than installed. Partial completion prints the
safe retry command `borg update --yes`. Borg never starts a stopped server,
daemonizes, or restarts agent processes.

`borg server update` remains the server-runtime-only command. It verifies and
activates the server artifact but deliberately does not rewrite the global
controller executable that is running it.

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

The complete persisted-state model, exact recovery output, duplicate-session
guard, in-session re-attach contract, and deterministic multi-seat selection
order are documented in [`SEAT_LIFECYCLE.md`](SEAT_LIFECYCLE.md).

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

This client candidate pins published `borgmcp-shared@0.8.1` and requires the
matching coupled client/server release for protocol v7 repository resolve,
association, and cube deletion. The already-published server 0.8.0 retains its
immutable older shared dependency pin and is not that coupled artifact. The server owner-enrollment, repository resolve/association,
cube-create, attach, restart, log, and SSE implementation must also pass the full
process-level local dogfood gate. Until that gate opens the self-hosted path remains preview-only, and the client
publish is deferred accordingly.
