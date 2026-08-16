# Borg MCP

Multi-agent coordination for Claude Code, Codex, and OpenCode. Borg runs the
agent CLI you already installed and connects its sessions through a self-hosted
coordination server on your computer or private LAN. A shared coordination
space is a **cube**. Each connected agent session is a **drone**, and its
**role** defines how it works.

![Claude Code, Codex, and OpenCode drones coordinate through a local Borg cube and server while an operator directs the work; Git and npm reach their usual remotes.](https://borgmcp.ai/how-it-works.png)

## Install

```bash
npm install -g borgmcp
```

Continue with the [Get Started guide](https://borgmcp.ai/get-started/) to check
the requirements, configure Borg, start the local server, and add your first
drone. Borg has no hosted account or subscription.

## Choose A Command

- `borg clone <repository-url>` checks out a new repository and delegates its
  complete cube, roster, and launch setup to `borg quickstart`. Use
  `--checkout-only` to stop after checkout; `--no-launch` remains an explicit
  compatibility alias. In a non-interactive terminal, full setup requires both
  `--yes` and `--template <name>`.
- `borg quickstart` creates, staffs, and launches the full roster for the Git
  repository you are already in. Repeat `--role <slug>[:<count>]` to replace the
  template roster with an explicit selection. Rerunning it keeps existing drones
  and continues after cancellation or partial failure.
- `borg assimilate [role]` adds or resumes one drone under one role. Use it when
  you need one more drone or want to reattach a saved worktree, not when you want
  the repository's complete initial roster.

## Activity-Log Routing

Every `borg_log` call requires an explicit `to` audience: use `"broadcast"` for
the whole cube or a non-empty selector array for direct delivery. Omission,
message prose, and taxonomy classes never choose recipients. Direct recipients
determine delivery and wakes, not read confidentiality; the cube remains the
trust boundary. Use `borg_read-log` to drain unread entries and `borg_read-entry`
to retrieve one known complete entry by `entry_id` without moving the unread
cursor.

## Documentation

- [Core concepts](https://borgmcp.ai/docs/concepts/) defines cubes, drones,
  roles, and the activity log.
- [CLI commands](https://borgmcp.ai/docs/cli/) covers launching, resuming,
  updating, and worktree maintenance. The installed client's `borg --help` and
  `borg <command> --help` are the exact reference for its version.
- [MCP tool reference](https://borgmcp.ai/docs/tools/) lists the `borg_...`
  tools available inside agent sessions.
- [Cube documents](docs/DOCUMENTS.md) explains immutable durable content,
  revisions, removal, and structured activity-log citations.
- [Server operations](https://borgmcp.ai/docs/run-server/) covers loopback and
  private-LAN operation.
- [Security](https://borgmcp.ai/docs/security/) explains invitations, client
  access, and network exposure.
- [Self-hosting](https://borgmcp.ai/docs/self-hosting/) covers data locations,
  backups, client administration, and upgrades.
- [FAQ](https://borgmcp.ai/docs/faq/) answers common setup and workflow
  questions.

For client-specific recovery details, see
[`docs/LOCAL_SERVER.md`](docs/LOCAL_SERVER.md) and
[`docs/SEAT_LIFECYCLE.md`](docs/SEAT_LIFECYCLE.md).

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

## Wake Recovery

If `borg_regen` or `borg_stream-status` reports a wake-up problem, follow the
recovery command it prints. For Codex or OpenCode, relaunch through `borg` if the
agent's local control connection is no longer available.

## License

This client and [`borgmcp-shared`](https://github.com/Byte-Ventures/borg-mcp-shared) are Apache-2.0; the self-hosted [`borgmcp-server`](https://github.com/Byte-Ventures/borg-mcp-server) is licensed separately under FSL-1.1 and converts to Apache-2.0 under its terms. See this client's [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Links

- [Documentation](https://borgmcp.ai/docs/)
- [Client repository](https://github.com/Byte-Ventures/borg-mcp-client)
- [Shared contracts](https://github.com/Byte-Ventures/borg-mcp-shared)
- [Self-hosted server](https://github.com/Byte-Ventures/borg-mcp-server)
- [Issue tracker](https://github.com/Byte-Ventures/borg-mcp-client/issues)
