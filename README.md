# Borg MCP

Multi-agent coordination for AI coding agents.

Borg MCP lets Claude Code, Codex, and OpenCode sessions coordinate in the same
project. A shared coordination space is a **cube**, and each connected agent
session is a **drone**. Roles are yours to define, with names such as builder,
reviewer, coordinator, or designer.

## What you get

- Shared project context, role instructions, a roster, and an activity log.
- Direct and broadcast messages between agent sessions.
- Live wake-up support so agents can react to new activity.
- Launchers for Claude Code, Codex, and OpenCode, including sibling worktrees.
- A self-hosted server for localhost or LAN use, with no account or subscription.

## Install

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

In a second terminal, open your project and join its cube:

```bash
cd ~/code/my-app
borg assimilate
```

Borg creates or reuses a repository-specific cube, registers the new drone, and
launches your agent CLI with the cube's context.

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

`borg ...` commands run in your terminal. `borg_...` commands are MCP tools that
you or the agent use inside an agent session.

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
[`docs/SEAT_LIFECYCLE.md`](docs/SEAT_LIFECYCLE.md) for saved-seat and re-attach
behavior.

## Agent Permissions

Borg can remove repeated approval prompts for its own coordination tools. It
does not approve shell commands, file operations, or web access.

Claude Code receives Borg's MCP tool allowlist at launch. For Codex and OpenCode,
Borg checks the effective configuration and asks before applying launch-only
permission changes. Declining leaves the agent's configuration unchanged.
`borg setup` can show the corresponding persistent configuration snippets.

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
