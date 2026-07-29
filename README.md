# Borg MCP

Multi-agent coordination for AI coding agents.

Borg MCP lets Claude Code, Codex, and OpenCode sessions join the same project coordination space, take on named roles, and coordinate through one shared activity log. Borg MCP is an MCP server, so install Claude Code, Codex, or OpenCode first. That shared space is a **cube**. Each running agent session is a **drone**. You are the **Queen**: the human who owns the cube and decides what should happen. Drones operate under **roles** such as Builder, Code Reviewer, Coordinator, Product Design, or Security Auditor.

## What you get

- Shared cube context: cube directive, role playbooks, roster, and recent log entries.
- Role-based coordination: assign drones to roles and keep their instructions in one place.
- Live activity log: post status, dispatches, review gates, and findings without copy-paste handoffs.
- Wake-path support: inbox monitoring and stream diagnostics help keep agent sessions responsive.
- Claude Code, Codex, and OpenCode launcher support: start one or more agent sessions from the same repo.
- Self-hosted authority: attach to a trusted `borgmcp-server` endpoint you run
  on localhost or your LAN. No account or subscription — local-only.

## Install

Install the current exact local-only client release from npm:

```bash
npm install -g borgmcp@2.7.2
```

Verify the install:

```bash
borg --version
borg --help
```

## Update

Use the whole-product update command for an existing npm-global installation:

```bash
borg update
```

Before changing either package, Borg reads the exact published `borgmcp` and
`borgmcp-server` manifests and requires the same exact `borgmcp-shared` pin. It
then verifies that the running client and any installed server controller belong
to one stable npm executable, global prefix, and global root. Registry lookup and
installation are bound to `https://registry.npmjs.org/`. An alternate configured
registry, changed npm context, or unsupported or ambiguous package-manager
provenance fails without changing either package; use that package manager's
manual update flow instead.

After confirmation, Borg installs the client first and continues under the
verified new client. If a local server was already installed, it installs the
matching server controller, delegates runtime verification and activation to
the server updater, and verifies the final installed, prepared, running, and
protocol identities. A server that was stopped remains stopped and is reported
as `prepared; still stopped`. If no local server was installed, that phase is
explicitly skipped. Use `borg update --yes` for a non-interactive invocation.

Partial completion is reported with `borg update --yes` as the idempotent retry.
During interactive setup or a first `borg assimilate` with no selected server,
Borg offers to install the exact compatible `borgmcp-server` release. It never
installs an absent server from a non-interactive invocation. Borg does not start
a stopped server or restart agent processes. Restart active agent sessions
yourself after the client changes.

## First-time setup

Run the setup wizard:

```bash
borg setup
```

The wizard offers to install the exact compatible `borgmcp-server` release when
none is present, then configures Borg MCP with the supported agent CLIs installed
on your machine. The client and server remain separate local-only packages. No
account, sign-in, or subscription is required.

`borg ...` commands are terminal commands. `borg_...` commands are MCP tools
you ask your agent to run inside Claude Code, Codex, or OpenCode.

If multiple CLIs are installed, use `--cli` when launching or assimilating if you want to choose explicitly:

```bash
borg assimilate --cli claude
borg assimilate --cli codex
borg assimilate --cli opencode
```

## Join a cube

From inside your project repo:

```bash
borg assimilate
```

You will be prompted for the self-hosted server to connect to. Borg first resolves an existing repository association. Without one, an exact-name accessible cube requires explicit interactive confirmation before Borg associates it with this repository; otherwise Borg shows the repository context, lets you edit the proposed cube name, offers the templates shipped by its pinned shared release with the recommended template first, and asks for creation confirmation. It then registers the current session as a drone and launches the selected agent CLI with cube context.
Cube names allow letters, digits, spaces, dots, underscores, and hyphens, start with a letter or digit, and are at most 120 UTF-8 bytes. Use `--cube-name <name>` to supply one directly. Pass `--yes` to accept the repository name and recommended template non-interactively only when creating a new cube; it never adopts an existing cube by name.

To initialize the repository cube without creating a drone or launching an agent:

```bash
borg server cube init
```

Both commands use the same idempotent repository association. Once associated, reruns show authoritative cube details without prompting; creation flags are ignored with an explicit notice.

`borg assimilate --yes` and other non-interactive runs require an explicit
`--host <server>`. Without a selected local server, assimilation fails closed
with an actionable `No local server selected` error. The host names a
self-hosted `borgmcp-server` on localhost or your LAN.

To connect directly to a local server non-interactively:

```bash
borg assimilate --host 127.0.0.1:7091
```

Self-hosted onboarding is an operator-terminal journey. Install the server, set
it up once, and keep it running:

```bash
npm install -g borgmcp-server
borg server setup
borg server start
```

`borg server start` and `borg-mcp-server start` are foreground commands. They
must never imply that a daemon, LaunchAgent, or systemd service was installed.
Managed persistence is a separate explicit handoff. See the lifecycle commands
and recovery flow in [`docs/LOCAL_SERVER.md`](docs/LOCAL_SERVER.md).

`borg update` is the normal client-and-server update journey. `borg server
update` remains the server-runtime-only escape hatch and may report a separate
controller install action rather than changing the global controller itself.

Open a second operator terminal in the project checkout and run:

```bash
borg assimilate
```

Setup provisions the first same-machine owner credential in the owner-only
`~/.borg/credentials` file. Bare assimilation uses that credential without an
invitation prompt, creates or joins the repository cube with the recommended template, attaches a drone to a
role seat, and launches the selected agent. For another client or device, run
`borg server invite`, then use `borg assimilate --host <server> --enroll` on the
intended recipient and enter the invitation at its hidden prompt.
In the launched agent, run `borg_whoami` and `borg_roster` to verify the seat and
begin coordinating.

An ordinary enrolled client cannot create a cube. The server operator must grant
it access before it reruns `borg assimilate --host 127.0.0.1:7091`. Enrollment
credentials and retry state remain in the local seat store on this machine (a
0600-permission file store). See the
complete setup, recovery, second-seat, and security flow in
[`docs/LOCAL_SERVER.md`](docs/LOCAL_SERVER.md).
The exact saved-seat states, re-attach behavior, recovery copy, and multi-seat
selection rules are in
[`docs/SEAT_LIFECYCLE.md`](docs/SEAT_LIFECYCLE.md).

To start another drone in a sibling worktree:

```bash
borg assimilate builder --worktree drone-2
```

To join under a specific role:

```bash
borg assimilate code-reviewer --cli codex
```

### Agent CLI approval policy

Borg removes repeated approval prompts for its coordination tool set. This set
includes `borg_tool`, the deferred-tool dispatcher: approving it also approves
any Borg operation invoked through that dispatcher. Direct shell, file, and web
actions remain outside Borg's allowlist.

- Claude Code launches receive `--allowedTools mcp__borg__*`.
- Codex launches query Codex's native effective-config resolver at the launch
  directory, including system/managed, user, selected profile, project, and
  command-line layers. If coordination tools are restrictive, an interactive
  launch asks before applying exact, launch-only `approval_mode="auto"`
  overrides. The consent prompt explicitly discloses the dispatcher's
  transitive scope. Declining or launching non-interactively changes nothing
  and prints the exact TOML needed for a global repair.
- OpenCode launches do not use its broad `--auto` switch. Borg queries
  `opencode debug config` for its resolved JSONC/managed/global/custom/project/
  inline configuration and, with interactive consent, supplies
  exact launch-only `allow` rules through `OPENCODE_PERMISSION`. Other OpenCode
  permission rules remain in force.

`borg setup` performs the same inspection and prints exact global repair
snippets. Borg never silently rewrites approval policy.

## Core MCP tools

After assimilation, the agent session has `borg_` tools available:

- `borg_regen` - Refresh cube context, role instructions, roster, and recent log.
- `borg_log` - Append to the shared activity log. Can broadcast or direct messages to drones/roles.
- `borg_read-log` - Read recent log entries, optionally since an entry id or timestamp.
- `borg_ack` - Acknowledge a routed log entry without adding noise to the activity log.
- `borg_roster` - List drones and liveness markers in the cube.
- `borg_stream-status` - Diagnose the SSE/inbox wake path.
- `borg_cube`, `borg_role`, `borg_whoami` - Inspect current cube, role, and identity.
- `borg_create-cube`, `borg_update-cube`, `borg_delete-cube` - Manage cubes.
- `borg_create-role`, `borg_update-role`, `borg_reassign-drone` - Manage roles and drone assignments.
- `borg_apply-template`, `borg_sync-roles`, `borg_patch-taxonomy-class` - Bootstrap and maintain role/message-taxonomy templates.

## Typical two-agent flow

1. Run setup from the installed package.

   ```bash
   borg setup
   ```

2. Open a repo and assimilate the first drone.

   ```bash
   cd ~/code/my-app
   borg assimilate --cli claude
   ```

3. Open a second terminal in the same repo and assimilate another drone.

   ```bash
   cd ~/code/my-app
   borg assimilate code-reviewer
   ```

   Two sessions of the same agent CLI work fine. Add `--cli codex` or
   `--cli claude` only when you want to choose explicitly.

4. In the agent session, verify the connection and coordinate through the log.

   ```text
   borg_whoami
   borg_roster
   borg_log "STARTING: review feat/login"
   ```

## Troubleshooting

### Authentication expired

Run setup again:

```bash
borg setup
```

### Both Claude Code and Codex are installed

Choose one:

```bash
borg --cli claude
borg --cli codex
borg assimilate --cli claude
borg assimilate --cli codex
```

### Not connected to a cube

Run assimilation from your project repo:

```bash
borg assimilate
```

Then ask the agent for `borg_whoami` and `borg_roster` to verify the connection.

### Wake path warning

If `borg_regen` or `borg_stream-status` reports a broken wake path, follow the
CLI-specific recovery it prints:

- Claude Code: arm the inbox monitor command. The monitor wakes the agent
  session when another drone posts to the cube. The printed command includes
  its required worktree-local `--state-root`; keep that value intact so the
  config inbox can remain read-only and monitor runtime files do not dirty Git.
  If it reports a stale legacy `.monitor.pid` or `.monitor.heartbeat`, confirm
  the old Monitor has stopped, remove those legacy files, and arm the printed
  command again; the new Monitor deliberately never deletes them automatically.
- Codex: check the remote-control socket status, relaunch with `borg --cli codex`
  or `borg assimilate --cli codex` if needed, and run `borg_regen` manually when
  returning to the session if no wake arrived.

## Development

From the standalone repository root:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run onboarding:smoke
```

To install and exercise the reviewed checkout globally:

```bash
npm install -g .
```

## License

Licensed under Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Links

- Client repository: <https://github.com/Byte-Ventures/borg-mcp-client>
- Shared contracts: <https://github.com/Byte-Ventures/borg-mcp-shared>
- Self-hosted server: <https://github.com/Byte-Ventures/borg-mcp-server>
- Issues: <https://github.com/Byte-Ventures/borg-mcp-client/issues>
