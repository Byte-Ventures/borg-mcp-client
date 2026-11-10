# borg-representative-push

## Overview

A Hermes user plugin that Borg ships inside the `borgmcp` npm package. It runs
inside the Hermes messaging gateway. When the bound Borg Coordinator replies to
the human representative, the plugin wakes one gateway conversation. It is a
thin adapter: Borg's listener (`borg representative listen --protocol 2`, owned
by `src/representative-cmd.ts`) makes every wake decision and holds all wake
state. Reply content never passes through the plugin; the woken conversation
fetches it with `borg_representative_read` and confirms it with
`borg_representative_deliver`.

The plugin is installed into a Hermes home by
`borg representative hermes-plugin install` (`src/hermes-plugin-install.ts`,
`HERMES_PLUGIN_NAME`, `HERMES_PLUGIN_FILES`). It copies exactly the two files
in this directory. It also writes the plugin settings below, sets
`plugins.entries.borg-representative-push.allow_gateway_injection = true`, and
registers the MCP server `borg-representative`. The wake depends on
`allow_gateway_injection`. The plugin's refusal warning names this key. The
installer is stricter than `load_settings`: it accepts only a DM key that matches
`^agent:main:[a-z0-9_-]{1,32}:dm:[A-Za-z0-9_.:@+=-]{1,128}$`
(`SESSION_KEY_PATTERN`) and an absolute `borg_command`.

## Interface

- `plugin.yaml` - Hermes manifest: `name: borg-representative-push`,
  `version: 2.0.0`, `manifest_version: 2`, `api_version: 1`. `config_schema`:
  - `session_key` (str, required) - gateway session key of the conversation to
    wake, for example `agent:main:telegram:dm:<chat id>`.
  - `worktree` (str, required) - absolute path of the prepared representative
    worktree.
  - `borg_command` (str, default `borg`) - the borg executable
    (borgmcp >= 6.0.0).
- `__init__.py` (standard library only):
  - `register(ctx)` - Hermes entry point. Reads settings through
    `load_settings(ctx.get_config)`, calls
    `ctx.register_platform_handler(settings.platform, on_platform_connect)`, and
    registers `_shutdown` with `atexit`. On invalid or unreadable settings it
    logs `disabled: <reason>` and registers nothing.
  - `load_settings(get) -> (Settings | None, reason | None)` - validates the
    three settings. `session_key` must split on `:` into at least 4 non-empty
    parts, start with `agent`, and have a platform part matching
    `^[a-z0-9_-]+$`. `worktree` must be absolute. `borg_command` must be
    non-empty and contain no newline.
  - `Settings(NamedTuple)` - `session_key`, `platform`, `worktree`,
    `borg_command`.
  - `exit_action(code, stop_reason) -> "stop" | "restart" | "backoff"` -
    listener exit policy: `0` and `2` stop; `3` (lease held by another
    listener) returns `"backoff"`; `4` stops unless
    `stop_reason == "lease-lost"`, which returns `"restart"`; `1` and any other
    code return `"restart"`. `Supervisor._run` treats `"backoff"` and
    `"restart"` the same: both wait the current backoff delay and then start a
    new listener.
  - `Supervisor(settings, inject, *, popen, backoff_start_s, backoff_cap_s,
    reject_grace_s)` - owns one listener child. Public methods:
    `ensure_started() -> bool`, `shutdown(timeout=5.0)`. Public counters and
    state: `injections`, `refusals`, `final_action`, `final_reason`.
  - Constants: `PLUGIN_NAME = "borg-representative-push"`, `PROTOCOL = 2`,
    `WAKE_TEXT`, `BACKOFF_START_S = 1.0`, `BACKOFF_CAP_S = 60.0`,
    `REJECT_GRACE_S = 2.0`, `STDERR_LINE_MAX = 500`.

## Invariants

- The wake prompt is the fixed constant `WAKE_TEXT`. No entry id, sender, text,
  or document from the listener enters the prompt (`Supervisor._wake`).
- The listener is started only from the platform-connect handler registered by
  `register`, so it never runs in the Hermes CLI, `hermes serve`, or worker
  processes. `_start` keeps one process-wide `_SUPERVISOR`; a reconnect calls
  `ensure_started()` again and does nothing (`_started` guard).
- Protocol gate (`Supervisor._run_once`): before a `{"event": "listening",
  "protocol": 2}` announcement, only `refused` events are accepted (their
  `code` becomes the stop reason). A line that is not JSON or not a JSON
  object is skipped silently at all times; it is not an event and does not
  cause a rejection. Any other event first is treated as an older
  or incompatible listener: the child is rejected via `_reject` (stdin EOF, then
  SIGTERM, then SIGKILL, each after `reject_grace_s`) and the run returns
  `(2, "protocol-mismatch")`, which stops supervision.
- After `listening`, only `wake` and `stopped` events are acted on; unknown
  events and fields are ignored by contract. A `wake` whose `wake_id` is not a
  UUID (`_UUID`) is dropped without an ack.
- Every accepted `wake` gets exactly one ack line on the listener's stdin:
  `{"wake_id": <id>, "accepted": <bool>}`. An exception from
  `ctx.inject_message` counts as `accepted: false`.
- Restart backoff starts at `backoff_start_s`, doubles to `backoff_cap_s`, and
  resets after a run that reached `listening`. A `stop` action ends supervision
  until the gateway restarts. A spawn failure (`OSError`, for example a
  `borg_command` that is not found) counts as exit code `1`, so supervision
  restarts with capped backoff indefinitely and does not stop.
- The child is spawned with `close_fds=True` and a stdin pipe owned by this
  process, so the listener sees EOF and exits when the gateway exits for any
  reason, including SIGKILL.
- `package.json` `files` ships exactly `plugin.yaml` and `__init__.py` from
  this directory. `scripts/verify-packed-artifact.mjs`
  (`HERMES_PLUGIN_ARTIFACTS`) fails the release if any other file under
  `hermes-plugin/` is packed or either file is missing.

## Side Effects

- Spawns a subprocess: `<borg_command> representative listen --worktree
  <worktree> --protocol 2` with piped stdin, stdout, and stderr
  (`Supervisor._run_once`).
- Starts daemon threads `borg-representative-push:listener` and
  `borg-representative-push:stderr`.
- Calls `ctx.inject_message(WAKE_TEXT, role="user",
  session_key=settings.session_key)` for each wake.
- Writes JSON ack lines to the listener's stdin.
- Logs to the Python `logging` logger of this module: the `disabled: <reason>`
  warning, `listening (binding <binding_fingerprint>)` (info), listener stderr
  lines (truncated to `STDERR_LINE_MAX`), spawn failures, `inject_message raised`
  (with traceback), refusals (first and every tenth), protocol mismatches, and
  the stop reason when supervision stops with a non-zero exit code. Listener
  output never reaches the prompt.
- Registers an `atexit` hook (`shutdown(timeout=5.0)`). It closes the
  listener's stdin, waits up to `timeout`, and sends SIGTERM (`terminate()`)
  if the listener has not exited.

## Verification

- Python unit tests (not part of `npm test`):
  `python3 -m unittest discover -s hermes-plugin/tests -v`. CI runs this in the
  `hermes-plugin` job of `.github/workflows/ci.yml`.
- Packaging and install coverage in `npm test`:
  `test/release-lane.test.mjs` (packed-artifact plugin checks) and
  `__tests__/hermes-plugin-install.test.ts` (install and uninstall).
