# Batch startup

`borg launch-all [cube]` starts the saved drone worktrees of a cube. A cube is
a shared coordination space; a drone is one connected agent session. The
human seat is the role that speaks with the human's authority.

By default, non-human-seat drones run in one `borg-<cube>` tmux session, with
one window per drone. The human-seat drone opens in its own terminal. This
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
