// gh#556 Part 2 — the per-drone shell command + borg-binary resolution (spec §5).

import { shellEscape } from './shell-escape.js';

/**
 * The borg binary that invoked launch-all (spec §5.1). `process.argv[1]` is the
 * absolute path to the running borg script — deterministic, independent of $PATH
 * inside the spawned window's shell (npm link / global / local .bin all work).
 */
export function resolveBorgPath(): string {
  return process.argv[1];
}

/**
 * The shell command run inside each worktree's window/tab.
 * `borg launch <droneId>` is a prompt-free, network-free preflight that pins the
 * saved seat. The spawned child fail-closes through BORG_LAUNCH_EXPECTED_SEAT if
 * the worktree's seat changed instead of silently resuming a different drone.
 * `keepOpenOnFail` wraps a `|| read` pause so a failed launch doesn't close
 * the tmux window before the operator reads the error (tmux convenience only;
 * the pastelist backend omits it — the operator owns their own shell).
 */
export function buildLaunchCommand(
  candidate: { worktreeDir: string; droneId: string },
  borgPath: string,
  opts: { keepOpenOnFail?: boolean } = {}
): string {
  const base =
    `cd ${shellEscape(candidate.worktreeDir)} && ` +
    `${shellEscape(borgPath)} launch ${shellEscape(candidate.droneId)}`;
  if (opts.keepOpenOnFail) {
    return `${base} || { echo "borg launch failed — press Enter to close"; read _; }`;
  }
  return base;
}
