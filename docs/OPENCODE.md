# OpenCode integration

Borg supports OpenCode 1 and OpenCode 2.1.2 or newer. Install and configure
OpenCode yourself, then launch an assimilated worktree with `borg --cli opencode`.
`borg assimilate --cli opencode`, targeted launches, and batch launches use the
same generation-specific launcher. Borg never installs or updates OpenCode.

Each launch resolves the executable on PATH and reads that executable's version.
An upgrade takes effect on the next launch. A running session retains its
original transport. If OpenCode changes during startup, Borg closes the private
server and checks the executable again once before submitting a kickoff.

OpenCode 1 retains its TUI-owned HTTP server and single-submit wake behavior.
OpenCode 2 gets a private loopback server for each launched drone. Borg verifies
the server's version and process identity, binds a human session in the selected
worktree, and attaches the TUI. It does not start, replace, or stop your shared
OpenCode service. Exiting the TUI closes the private server and revokes its
session broker. The root API password stays in launcher memory and the attached
TUI environment; the MCP process receives a separate, session-scoped capability.

Use `borg --cli opencode --session <id>` or `borg --cli opencode --continue` to
resume a V2 session. Borg checks the selected session's worktree and saved drone
ownership. A native child session or another drone's session is refused. After
launch, a new human session becomes the wake target only after its human prompt
is verified in durable history. Borg never guesses a wake target from the most
recent session. Server and kickoff overrides such as `--server` and `--prompt`
conflict with Borg's launcher and are refused.

## Code Mode and permissions

OpenCode 2 keeps its native Code Mode default. Borg does not set `codemode` unless
you explicitly configured it. To expose Borg tools directly, set
`mcp.servers.borg.codemode` to `false` in your OpenCode configuration.

In Code Mode, use discovery and generated declarations for the exact callable
names. Punctuation can change the generated names; do not derive JavaScript
identifiers from MCP names. Batch independent reads, await dependent operations
and mutations in order, and return compact findings rather than entire logs.
Borg supplies this guidance through the V2 context and compaction hooks.

Borg can apply narrow session-only approval rules for its coordination tools.
It reports restrictive tools and discloses the dispatcher's scope. Pass
`--no-borg-approval-override` to keep your rules and receive a repair snippet.
Borg never automatically allows the outer `execute` tool. A configured deny on
`execute` or a managed policy can still block Code Mode; either change that
policy yourself or choose direct Borg tools. Other tool permissions remain yours.

The advisory log audit counts completed material runtime operations, including
nested Code Mode operations, once per execution ID. It does not count the outer
`execute` call or inspect JavaScript source. A successful persisted `borg_log`
resets the count for that session; an attempted or failed post does not. The
counter survives MCP and plugin reconnects while the launcher remains alive.

## Configuration and recovery

Setup retains a V1-readable MCP registration. V2 uses an additional launch-only
native overlay, preserving user providers, policies, plugins, and unrelated MCP
servers. V1 and V2 plugins have separate per-launch entrypoints outside OpenCode's
shared plugin autoload directories, so alternating versions does not replace a
shared plugin with an incompatible export.

Borg removes an old global `borg-orient.js` only when its entire contents match
the Borg generator. A modified or unrecognized file is preserved and launch is
refused with its path; move that file out of the autoload directory and relaunch.
`borg doctor` recognizes launch-scoped plugins and reports legacy file problems.

V2 wakes use native ascending message IDs persisted before submission. An
ambiguous admission reuses the same ID. Admission, delivery into durable history,
and Borg acknowledgement are separate states; queued or unconfirmed wakes do not
report a healthy delivery path. Session inbox and history queries reconcile
delivery across MCP reconnects. Live events are not a replay source.

The integration is measured against published native binaries. Its V1 baseline
is 1.18.15; its V2 client and schema dependencies are pinned to 2.1.2. Compatibility
checks also exercise the current stable V2 binary with a deterministic local
provider, without external model calls.

Upstream contracts: [V2 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1),
[permissions](https://opencode.ai/v2/docs/permissions), and
[MCP configuration](https://opencode.ai/v2/docs/mcp-servers).
