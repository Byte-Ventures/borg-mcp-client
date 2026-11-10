# hermes-plugin

## Overview

Python plugins that Borg ships for the Hermes agent gateway. Hermes loads these
files; Borg's TypeScript code does not import them. `borg representative
hermes-plugin install` (`src/hermes-plugin-install.ts`) copies the two plugin
files from this directory into a Hermes home. It also configures Hermes through
the Hermes CLI: it enables the plugin, sets
`plugins.entries.borg-representative-push.allow_gateway_injection = true` and
the plugin settings `session_key`, `worktree` and `borg_command`, and registers
the MCP server `mcp_servers.borg-representative` (`<borg> representative mcp
--worktree <path>`, `lazy: true`). It refuses a session key that is not a
gateway DM key (`SESSION_KEY_PATTERN`) and a `borg_command` that is not an
absolute path. `borg representative hermes-plugin uninstall` reverses the
install. `borg update` activates an existing install (`activateHermesPlugin`)
and never creates one. Only the two plugin files listed in `package.json`
`files` ship in the npm package.

`hermes-plugin/tests/` is test-only and has no contract file. Its Python unit
tests run with `python3 -m unittest discover -s hermes-plugin/tests -v`, in the
`hermes-plugin` CI job (`.github/workflows/ci.yml`), not in `npm test`.

## Subdirectories & Boundaries

- borg-representative-push: [./borg-representative-push/EGM.md](./borg-representative-push/EGM.md) -
  Hermes user plugin (`register`, `Supervisor`, `load_settings`,
  `exit_action`). Inside the messaging gateway it runs `borg representative
  listen --protocol 2` and, for each `wake` event, injects one fixed,
  body-free prompt into the configured gateway conversation and acks
  `{"wake_id", "accepted"}` to the listener. Borg owns every wake decision and
  all wake state; reply content never passes through the plugin.
