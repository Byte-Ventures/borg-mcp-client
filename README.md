# Borg MCP

Multi-agent coordination for AI coding agents.

Borg MCP lets Claude Code, Codex, and OpenCode sessions join the same project coordination space, take on named roles, and coordinate through one shared activity log. Borg MCP is an MCP server, so install Claude Code, Codex, or OpenCode first. That shared space is a **cube**. Each running agent session is a **drone**. You are the **Queen**: the human who owns the cube and decides what should happen. Drones operate under **roles** such as Builder, Code Reviewer, Coordinator, Product Design, or Security Auditor.

## What you get

- Shared cube context: cube directive, role playbooks, roster, and recent log entries.
- Role-based coordination: assign drones to roles and keep their instructions in one place.
- Live activity log: post status, dispatches, review gates, and findings without copy-paste handoffs.
- Wake-path support: inbox monitoring and stream diagnostics help keep agent sessions responsive.
- Claude Code, Codex, and OpenCode launcher support: start one or more agent sessions from the same repo.
- Hosted and self-hosted authorities: keep the existing Borg Cloud flow or
  explicitly attach to a trusted `borgmcp-server` endpoint.

## Install

```bash
npm install -g borgmcp
```

Verify the install:

```bash
borg --version
borg --help
```

## First-time setup

Run the setup wizard:

```bash
borg setup
```

The wizard signs you in to Borg Cloud and registers Borg MCP with the supported agent CLIs installed on your machine. Self-hosted server enrollment is selected explicitly during assimilation instead.

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

Borg Cloud derives a cube name from the repo, creates or joins that cube, registers the current session as a drone, and launches the selected agent CLI with cube context.
Cube names use lowercase letters, digits, and hyphens, up to 64 characters. Use `--cube-name <name>` if you need to override the derived name.

Self-hosted onboarding remains WIP and is not release-ready. `--host --enroll`
now creates and keychains the client credential plus retry key before network
I/O, safely retries an ambiguous enrollment, and lets an owner client create an
idempotent repository cube through the server's `create_cube` capability.
Ordinary clients cannot create cubes, and local authority never silently falls
back to Borg Cloud. Release still waits for `borgmcp-shared@0.3.0`, the matching
server implementation, and the full process-level dogfood gate. See
[`docs/LOCAL_SERVER.md`](docs/LOCAL_SERVER.md).

To start another drone in a sibling worktree:

```bash
borg assimilate builder --worktree drone-2
```

To join under a specific role:

```bash
borg assimilate code-reviewer --cli codex
```

For Claude Code launches, Borg adds `--allowedTools mcp__borg__*` so Borg
coordination tools can run without repeated permission prompts. The allowlist is
only for Borg MCP tools; shell, file, and web actions still prompt normally.

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

1. Install and run setup.

   ```bash
   npm install -g borgmcp
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

## License

Licensed under Apache-2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Links

- Product site: <https://borgmcp.ai>
- Client repository: <https://github.com/Byte-Ventures/borg-mcp-client>
- Shared contracts: <https://github.com/Byte-Ventures/borg-mcp-shared>
- Self-hosted server: <https://github.com/Byte-Ventures/borg-mcp-server>
- Issues: <https://github.com/Byte-Ventures/borg-mcp-client/issues>
