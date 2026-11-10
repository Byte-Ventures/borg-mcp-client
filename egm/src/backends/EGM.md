# src/backends

Contract for `src/backends/` (stored outside `src/` because `src/` is packed to npm).

## Overview

The three window backends that `borg launch-all` uses to open one agent seat per
worktree. Each backend gets a list of `DroneCandidate` records (from
[`src/launch-all-discovery.ts`](../../../src/launch-all-discovery.ts)) and, for each candidate, runs or prints the shell
line that `buildLaunchCommand` ([`src/launch-all-command.ts`](../../../src/launch-all-command.ts)) builds. The
dispatcher in [`src/launch-all-cmd.ts`](../../../src/launch-all-cmd.ts) selects the backend. All process, file
and environment access goes through the injected `LaunchAllDeps`
([`src/launch-all-deps.ts`](../../../src/launch-all-deps.ts)). Because of this, tests can replace each effect.

The dispatcher has four modes, not three. Besides `tmux`, `terminals` and
`pastelist`, it has a `split` mode. `split` has no `--mode` value. With no
`--mode`, `selectBackend` picks it when tmux is available and, if any seat is
not a worker, a compatible terminal is also available
(`src/launch-all-cmd.ts:selectBackend`, dispatch step 8). In `split` mode the dispatcher runs `runTmuxBackend` with
`attachMode: 'none'` for the worker seats (`isHumanSeat === false`), waits
`launchDelayMs`, and runs `runTerminalsBackend` for the human and unclassified
seats. Then the dispatcher itself attaches or switches to the tmux session, or
prints the cheat sheet.

## Interface

- Source files: [`launch-all-tmux.ts`](../../../src/backends/launch-all-tmux.ts),
  [`launch-all-terminals.ts`](../../../src/backends/launch-all-terminals.ts),
  [`launch-all-pastelist.ts`](../../../src/backends/launch-all-pastelist.ts).
  Parent contract: [`src/` contract](../EGM.md).
- `runTmuxBackend(candidates, opts: TmuxOpts, deps)` (`launch-all-tmux.ts`):
  the primary backend. It uses one detached tmux session (`opts.sessionName`)
  with one window for each drone. Then it attaches (`attach-session`), switches
  (`switch-client`, for nested tmux) or does nothing, as `opts.attachMode`
  specifies (`'attach' | 'switch' | 'none'`).
- `TmuxOpts` (`launch-all-tmux.ts`): `sessionName`, `borgPath`, `cli?`, `force?`,
  `attachMode`, `launchedAtISO`, `launchDelayMs`, `sleep`.
- `runTerminalsBackend(candidates, opts: TerminalsOpts, deps)`
  (`launch-all-terminals.ts`): `--mode terminals`, and the human-seat half of
  `split`. It selects the platform from `opts.platform`. On macOS it opens
  iTerm through `osascript` if iTerm exists, else Terminal. In iTerm it creates
  a window if none is open, else a tab, and sets the session name. In Terminal
  it sets a custom title and activates the app. On other platforms it runs
  `<term> -e sh -c '<cmd>'`, where `<cmd>` is an OSC-0 title `printf` followed
  by the launch line. The emulator must therefore accept `-e <program>
  <args>`.
- `TerminalsOpts` (`launch-all-terminals.ts`): `borgPath`, `cli?`, `force?`,
  `platform`, `cubeName`, `launchedAtISO`, `launchDelayMs`, `sleep`.
- `hasMacOSTerminalApp(deps)` (`launch-all-terminals.ts`): true if
  `/Applications/iTerm.app` or one of the `TERMINAL_APPS` paths exists.
- `resolveLinuxTerminal(deps)` (`launch-all-terminals.ts`): uses `$BORG_TERMINAL`,
  then `$TERMINAL`, then the first of `gnome-terminal`, `konsole`, `kitty`,
  `wezterm` or `xterm` that `which` finds.
- `hasCompatibleTerminal(deps)` (`launch-all-terminals.ts`): preflight. It
  selects the platform from `deps.platform()`, not from an option. It needs a
  TTY. On macOS it also needs a terminal app. On Linux it also needs `DISPLAY`
  or `WAYLAND_DISPLAY`, a terminal that `resolveLinuxTerminal` returns, and
  `which <terminal>` to exit 0. An explicit `$BORG_TERMINAL` or `$TERMINAL`
  value that is not on `PATH` therefore fails the preflight, although
  `resolveLinuxTerminal` accepts it.
- `runPastelistBackend(candidates, borgPath, deps, cli?, force?)`
  (`launch-all-pastelist.ts`): the fallback that cannot fail. It writes only
  to stdout: one header line (`# borg launch-all: open each worktree in a
  terminal window and run:`), then one launch line for each candidate, so that
  the operator can paste them.

## Invariants

- Every backend builds the per-seat command only with `buildLaunchCommand`
  ([`src/launch-all-command.ts`](../../../src/launch-all-command.ts)). They do not compose launch lines in other ways.
- The tmux backend targets windows by the window id that it captures
  (`-P -F '#{window_id}'`), not by a computed index. This makes it work with
  any `base-index` setting and with gaps in the window list
  (`launch-all-tmux.ts:runTmuxBackend`). If the session already exists, the
  backend adds windows to it. It does not create a second session.
- The first launch has no delay. Each subsequent launch waits `launchDelayMs`
  through the injected `sleep`. A value of 0 disables the delay. The delay
  prevents an agent fleet from tripping the rate limiter (tmux and terminals
  backends).
- The terminals backend skips (and reports on stderr) each candidate whose
  `worktreeDir` contains a control character (`WORKTREE_CONTROL_CHAR_RE`).
  Such a path cannot be escaped into an AppleScript string literal without a
  change to the launch target.
- The terminals backend throws `NoTerminalError` (not exported) if it finds no
  compatible terminal app or emulator. It does not fall back to another
  backend.
- The tmux backend and the Linux terminals path launch with
  `keepOpenOnFail: true`. The macOS terminals path and pastelist do not.
- AppleScript string arguments are escaped with `appleScriptEscape`.
  Linux window titles are escaped with `shellEscape` ([`src/shell-escape.ts`](../../../src/shell-escape.ts)).
  Titles come from `composeTerminalTitle` ([`src/terminal-title.ts`](../../../src/terminal-title.ts)).

## Side Effects

- They start the external processes `tmux` (`has-session`, `new-session`,
  `new-window`, `rename-window`, `send-keys`, `attach-session` or
  `switch-client`), `osascript` and the Linux terminal emulator (detached
  spawn), and they run `which` probes. All of these go through
  `LaunchAllDeps.runSync`, `runSyncExitCode`, `spawnDetached` and
  `attachInteractive`.
- After each dispatch, the tmux and terminals backends write a launch lock
  marker through `writeLockMarker` ([`src/launch-all-locks.ts`](../../../src/launch-all-locks.ts)). The file is
  `~/.config/borgmcp/locks/<cubeId>/<sha1(worktreeDir)>.pid`, it is written
  with mode `0o600`, and it holds JSON `{ launchedAt, droneLabel, worktreeDir }`.
  Pastelist writes no lock marker.
- They write to stdout (pastelist lines) and stderr (skipped-candidate
  warnings).

## Verification

- Run: `npm test` (Vitest unit suite and release-lane suite); `npm run check`
  for types.
