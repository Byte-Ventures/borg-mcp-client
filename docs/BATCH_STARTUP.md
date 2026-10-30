# Batch startup

`borg launch-all [cube]` starts the saved drone worktrees of a cube. A cube is
a shared coordination space; a drone is one connected agent session. The
human seat is the role that speaks with the human's authority.

To use one agent CLI for the whole batch, run `borg launch-all --cli opencode`
(or `--cli claude` / `--cli codex`). Without `--cli`, each worktree uses its
saved CLI choice. An explicit choice is remembered in each launched worktree,
just like running `borg --cli opencode` there. Skipped drones keep their saved
choices. `--dry-run` shows the requested CLI without changing preferences;
`--mode pastelist` includes it in the printed commands and changes preferences
only when those commands are run. For one drone, use
`borg launch <drone-label-or-id-prefix> --cli opencode`.
If the requested CLI is not installed, the batch stops before opening windows or
marking drones as launched. Preview and printed commands still work without it.

Existing windows stay open. An explicit CLI choice applies to new launches;
it does not switch an already running session. Stop an existing session before
reopening its drone in another CLI. `--force` overrides live-session checks in
both the batch and its child launchers and can create duplicate sessions.
For one drone, the override is `borg launch <drone-label-or-id-prefix> --cli codex --force`.

The summary counts launch commands sent. Recent roster activity can come from
an older session for the same drone, so it does not confirm that the new CLI
finished starting. Check each new window for errors or prompts. Codex may ask
you to trust a worktree before it starts the agent.

By default, non-human-seat drones run in one `borg-<cube>` tmux session, with
one window per drone. Closing the terminal that displays tmux detaches from
that session; its drones keep running. Reattach with `tmux attach -t borg-<cube>`
(replace `<cube>` with the cube name). The human-seat drone opens in its own terminal. This
also applies when `borg quickstart` launches a roster. Drones whose human-seat
identity cannot be confirmed by the server open in terminals too; saved role
metadata is not used after a failed check.

If tmux is missing, Borg uses terminals for the entire batch and prints tmux
installation guidance. If a required terminal is unavailable, Borg prints
commands for manual use before starting any sessions. Quickstart reports that
no sessions launched in this case. Automatic terminal launching requires an
interactive terminal and, on Linux, an X11 or Wayland display. Linux terminal
windows are spawned without waiting for their drone sessions to exit. Worker-only batches can run in detached tmux without one.

Use `borg launch-all --dry-run` to inspect the destinations. Existing live-session
and invalid-session skips still apply. `--no-attach` leaves tmux detached.

Explicit `--mode tmux`, `--mode terminals`, and `--mode pastelist` override the
split for the whole batch. Explicit tmux mode fails with installation guidance
when tmux is missing. Native Windows prints commands; use WSL for tmux.
