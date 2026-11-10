# borg-mcp-client Blueprint

## System Overview

`borgmcp` 8.0.0 is the Borg MCP client: the `borg` launcher and CLI, the stdio MCP server `borg-mcp` that each agent session runs, the agent hooks, and the inbox monitor. Borg wraps an agent CLI that the user already installed (Claude Code, Codex or OpenCode). It does not install one. It is local-first: it talks only to a self-hosted [borg-mcp-server](https://github.com/Byte-Ventures/borg-mcp-server) (npm `borgmcp-server`, default `https://127.0.0.1:7091`) over pinned-CA HTTPS. There are no accounts and no hosted API. [AGENTS.md](./AGENTS.md) is authoritative.

The protocol envelopes, domain types and validators come from the exact pinned dependency `borgmcp-shared` `3.0.0` ([borg-mcp-shared](https://github.com/Byte-Ventures/borg-mcp-shared)). A wire change is made there first, and client and server move to a new shared version as a matched pair.

## Local Interface & Invariants

- `vitest.config.ts`: includes `__tests__/**/*.test.ts`, runs with `fileParallelism: false` and `testTimeout` 60 000 ms. `globalSetup` is `__tests__/global/real-home-guard.ts`, and `setupFiles` is `__tests__/setup-isolated-home.ts`.
- `package.json`:
  - `bin`: `borg`, `borg-setup`, `borg-mcp`, `borg-regen`, `borg-clear-rewake`, `borg-log-audit`, `borg-foreign-path-reminder`, `borg-inbox-monitor`.
  - `engines.node` is `>=22.13.0`.
  - `files` ships `dist`, `src`, `docs/*.md`, the two `hermes-plugin/borg-representative-push` files, and the root legal and README files.
  - `test` = `test:unit` (Vitest) + `test:release` (`node --test test/release-lane.test.mjs`). `check` runs the Node preflight (`preflight:node`) and then a typecheck only (`tsc --noEmit`). `build`, `dev`, `test:unit` and `test:release` also run `preflight:node` first.
- `dist/` is generated output and is TRACKED in git. Never edit it by hand. Run `npm run build` and commit the result. `publish.yml` rebuilds it and fails on any difference.

## Subdirectories & System Boundaries

The `src/` contracts are stored in `egm/src/`, not in `src/`. `src/` is packed to npm, and `scripts/verify-packed-artifact.mjs` rejects any non-`.ts` file under `src/`.

- src: [./egm/src/EGM.md](./egm/src/EGM.md). The 153 flat source modules, grouped in 11 areas: CLI dispatch, CLI commands, the MCP server and its 41 `borg_*` tools, server connection and trust, seats and local state, the inbox/stream/wake path, agent launch integrations (Claude, Codex, OpenCode v1/v2), launch-all, the human representative (Hermes), setup and health, and the rendering and documentation surfaces.
  - src/backends: [./egm/src/backends/EGM.md](./egm/src/backends/EGM.md). The tmux, terminals and pastelist window backends of `borg launch-all`.
- scripts: [./scripts/EGM.md](./scripts/EGM.md). Build, release and CI scripts that are not shipped: `clean.mjs`, `node-preflight.mjs`, `set-bin-mode.mjs`, `onboarding-smoke.mjs`, the release-lane verifiers, `smoke-packed-client.mjs`, `release-exercise.mjs`, `create-github-release.mjs` and `sha256-stdin.mjs`, plus the data file `local-dashboard-occurrences.json`.
- hermes-plugin: [./hermes-plugin/EGM.md](./hermes-plugin/EGM.md). The Python Hermes gateway plugin [borg-representative-push](./hermes-plugin/borg-representative-push/EGM.md), which supervises `borg representative listen --protocol 2` and injects a fixed wake prompt.

`docs/` (shipped Markdown), `__tests__/`, `test/` and `release/` contain no production code and have no contract. The `wt-*` directories at the repository root are git worktrees of other branches, not part of this tree.

## Global Invariants

- Borg never installs an agent CLI. `borg setup` configures the CLIs the user selected and initializes the separately published local server.
- The client is local-first. A change that introduces a remote authority is an architectural change, not a feature.
- `BORG_SESSION` is an activation gate, not a security boundary. The server enforces per-cube grants.
- Server requests use an HTTPS origin, the pinned-CA fetch (TLS 1.3 minimum) and `redirect: 'error'`. A trust mismatch is terminal.
- Operator state (`~/.config/borgmcp`, `~/.borg`, agent CLI configuration) is the operator's data. Store files are mode 0600 in 0700 directories, fail closed when malformed, and are never overwritten in that case. Filesystem mutation goes through `src/guarded-fs.ts`.
- A term must be defined on every documentation surface that uses it: the README, `src/cli-help.ts` and `src/docs-sections.ts` are separate surfaces.
- `package.json` and `package-lock.json` carry the version together. Releases are tag-triggered and immutable. Follow `docs/RELEASING.md`. A merged release-prep PR does not authorize tagging or publication.
- `scripts/verify-public-source.mjs` scans every working-tree file, including these contracts. Never write a developer-local absolute path, token or private endpoint into them.

## Global Side Effects

- Files: `~/.config/borgmcp` (seats, launch state, inboxes, cursors, stream locks, representative state), `~/.borg` (`credentials`, `server-trust/`, `worktrees/`, `scratch/`), per-worktree `.borgmcp/`, and agent CLI configuration (`~/.claude.json`, `~/.claude/settings.json`, `~/.codex/`, `~/.config/opencode/`).
- Network: HTTPS and SSE to the Borg server, the npm registry (`borg update`, first-run server install), and loopback HTTP to OpenCode servers and the v2 broker.
- Processes: the agent CLIs, `codex app-server`, `opencode serve`, `borg-mcp-server`, `npm`, `git`, `tmux`, `osascript`, terminal emulators and `hermes`.

## System Verification

- Run: `npm test` (`test:unit` + `test:release`)
- Run: `npm run check` (Node preflight and typecheck; no tests)
- Hermes plugin: `python3 -m unittest discover -s hermes-plugin/tests -v`
- Warning: `__tests__/inbox-monitor.test.ts` runs `npm run build`, which deletes `dist/` before compiling. If the compile fails (for example because `node_modules` is out of date), the tracked `dist/` stays deleted. Run `npm ci` first, and run the suite in a dedicated worktree, not in a checkout that other agents use. `git checkout -- dist` restores the tracked tree. Tracked as [client#643](https://github.com/Byte-Ventures/borg-mcp-client/issues/643).
