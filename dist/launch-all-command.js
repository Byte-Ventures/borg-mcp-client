// gh#556 Part 2 — the per-drone shell command + borg-binary resolution (spec §5).
import { shellEscape } from './shell-escape.js';
/**
 * The borg binary that invoked launch-all (spec §5.1). `process.argv[1]` is the
 * absolute path to the running borg script — deterministic, independent of $PATH
 * inside the spawned window's shell (npm link / global / local .bin all work).
 */
export function resolveBorgPath() {
    return process.argv[1];
}
/**
 * The shell command run inside each worktree's window/tab.
 * `keepOpenOnFail` wraps a `|| read` pause so a failed assimilate doesn't close
 * the tmux window before the operator reads the error (tmux convenience only;
 * the pastelist backend omits it — the operator owns their own shell).
 */
export function buildLaunchCommand(worktreeDir, borgPath, opts = {}) {
    const base = `cd ${shellEscape(worktreeDir)} && ${shellEscape(borgPath)} assimilate --here`;
    if (opts.keepOpenOnFail) {
        return `${base} || { echo "borg assimilate failed — press Enter to close"; read _; }`;
    }
    return base;
}
//# sourceMappingURL=launch-all-command.js.map