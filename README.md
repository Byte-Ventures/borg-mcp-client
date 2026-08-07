# Borg MCP

Multi-agent coordination for AI coding agents. Borg wraps the CLI agent you
already installed—Claude Code, Codex, or OpenCode—so its sessions can
coordinate in the same project. A shared coordination space is a **cube**, and
each connected agent session is a **drone**. Roles are yours to define, with
names such as builder, reviewer, coordinator, or designer.

## What you get

- Shared project context, role instructions, a roster, and an activity log.
- Direct and broadcast messages between agent sessions.
- Live wake-up support so agents can react to new activity.
- Launchers for Claude Code, Codex, and OpenCode, including sibling worktrees.
- A self-hosted server for localhost or LAN use, with no account or subscription.

## Install

You install Claude Code, Codex, or OpenCode yourself. Borg runs the installed
agent for you. When the current worktree is registered to a drone, Borg attaches
that drone's cube connection. Use
`borg ...` commands in your terminal, and use `borg_...` MCP tools inside the
agent session.

Install the client from npm:

```bash
npm install -g borgmcp
```

You also need at least one supported agent CLI: Claude Code, Codex, or OpenCode.

Verify the installation:

```bash
borg --version
borg --help
```

## Quick Start

Run the setup wizard:

```bash
borg setup
```

If the local server is not installed, the wizard offers to install a compatible
version. It also configures the supported agent CLIs found on your machine.

Prepare and start the server in one terminal:

```bash
borg server setup
borg server start
```

`borg server start` stays in the foreground. Leave that terminal open while you
use Borg; press Ctrl-C when you want to stop the server.

In a second terminal, open your project's Git repository and join its cube:

```bash
cd ~/code/my-app
borg assimilate
```

Borg creates or reuses a repository-specific cube, registers the new drone, and
launches your agent CLI with the cube's context. Borg tools are inactive unless
the agent session was launched with `borg`.

### Resume a saved session

When you return later, resume the agent session for the worktree you want to
continue:

1. Change into that exact Git worktree.
2. Run `borg`. A bare invocation in a TTY may show the launch menu.
3. If that worktree is registered to a drone, Borg relaunches the selected
   installed agent CLI with that drone's existing cube connection. If it is not
   registered to a drone, Borg still launches the agent, but it is not
   connected; run `borg assimilate` first.

The lookup is the same for Claude Code, Codex, and OpenCode; only their launch
adapters differ. It is also the same for an in-place drone and a sibling drone
worktree: run `borg` inside the worktree where the drone was assimilated.
Running it in the repository's main worktree does not resume sibling drones. To
resume all saved drone worktrees for a cube, run:

```bash
borg launch-all [cube]
```

To run another agent at the same time, open a third terminal and change to the
same Git repository:

```bash
cd ~/code/my-app
borg assimilate builder
```

Two sessions of the same agent CLI work. To choose a CLI explicitly, use one of:

```bash
borg assimilate --cli claude
borg assimilate --cli codex
borg assimilate --cli opencode
```

## Cubes And Roles

On first use in a repository, Borg shows the proposed cube name and template
before creating anything. If it finds one accessible cube with the same name,
it asks before linking that cube to the repository. It never links an existing
cube by name during a non-interactive run.

To create a repository cube without launching an agent:

```bash
borg server cube init
```

To supply creation defaults non-interactively, pass `--host`, `--cube-name`, and
`--yes`. The `--yes` flag accepts defaults for a new cube; it does not approve
linking an existing cube.

To launch a drone in a named sibling worktree:

```bash
borg assimilate builder --worktree drone-2
```

See [`docs/LOCAL_SERVER.md`](docs/LOCAL_SERVER.md) for remote enrollment,
invitations, server recovery, and security details. See
[`docs/SEAT_LIFECYCLE.md`](docs/SEAT_LIFECYCLE.md) for what a worktree's saved
connection contains, how it re-attaches, and how it is revoked,
superseded, evicted, or reset.

## Agent Permissions

Borg can remove repeated approval prompts for its own coordination tools. It
does not approve shell commands, file operations, or web access.

Claude Code receives Borg's MCP tool allowlist at launch. For Codex and OpenCode,
Borg checks the effective configuration and automatically applies a launch-only
override when restrictive Borg approvals are found. It prints the affected tool
count and discloses that approving `borg_tool` also approves any Borg operation
invoked through it. Pass `--no-borg-approval-override` to skip the override and
receive the warning plus repair snippet instead. The launch-only override does
not modify the agent's configuration. `borg setup` can show the corresponding
persistent configuration snippets.

## Core MCP Tools

After assimilation, the agent session can use these tools:

- `borg_regen` refreshes cube context, role instructions, and roster state.
- `borg_log` posts to the shared activity log; `borg_read-log` reads it.
- `borg_ack` acknowledges a routed entry without posting another log message.
- `borg_roster` lists drones and liveness markers.
- `borg_stream-status` diagnoses the wake-up path.
- `borg_cube`, `borg_role`, and `borg_whoami` inspect the current identity.
- `borg_create-cube` creates a cube; `borg_update-cube` updates its directive or
  message taxonomy.
- `borg_delete-cube` deletes a cube after explicit confirmation of its exact
  cube ID.
- `borg_create-role`, `borg_update-role`, and `borg_reassign-drone` manage roles
  and assignments.
- `borg_apply-template`, `borg_sync-roles`, and `borg_patch-taxonomy-class`
  maintain role and message-taxonomy templates.

The available tools are also discoverable from the agent's MCP tool list.

## Update

For npm-global installations, update the client and an installed local server
together:

```bash
borg update
```

Borg checks that compatible client and server versions are available, asks for
confirmation, and reports any manual recovery step. Use `borg update --yes` for
a non-interactive update. A server that was stopped remains stopped, and active
agent sessions must be restarted after the client changes.

## Troubleshooting

### Not connected to a cube

Run assimilation from the project repository:

```bash
borg assimilate
```

Then use `borg_whoami` and `borg_roster` inside the agent session.

### Wake-up warning

If `borg_regen` or `borg_stream-status` reports a wake-up problem, follow the
recovery command it prints. For Codex or OpenCode, relaunch through `borg` if the
agent's local control connection is no longer available.

## License

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Links

- [Client repository](https://github.com/Byte-Ventures/borg-mcp-client)
- [Shared contracts](https://github.com/Byte-Ventures/borg-mcp-shared)
- [Self-hosted server](https://github.com/Byte-Ventures/borg-mcp-server)
- [Issue tracker](https://github.com/Byte-Ventures/borg-mcp-client/issues)
