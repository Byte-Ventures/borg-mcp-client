/**
 * The borg binary that invoked launch-all (spec §5.1). `process.argv[1]` is the
 * absolute path to the running borg script — deterministic, independent of $PATH
 * inside the spawned window's shell (npm link / global / local .bin all work).
 */
export declare function resolveBorgPath(): string;
/**
 * The shell command run inside each worktree's window/tab.
 * `keepOpenOnFail` wraps a `|| read` pause so a failed assimilate doesn't close
 * the tmux window before the operator reads the error (tmux convenience only;
 * the pastelist backend omits it — the operator owns their own shell).
 */
export declare function buildLaunchCommand(worktreeDir: string, borgPath: string, opts?: {
    keepOpenOnFail?: boolean;
}): string;
//# sourceMappingURL=launch-all-command.d.ts.map