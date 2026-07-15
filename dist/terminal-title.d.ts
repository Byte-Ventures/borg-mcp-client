/**
 * Terminal-title setter for borg drone sessions.
 *
 * Multiple Claude Code sessions across sibling worktrees are visually
 * indistinguishable in Cmd-Tab / tab bars / Mission Control on macOS,
 * and likewise on most Linux terminal emulators. Setting the terminal
 * title via the OSC 0 / OSC 2 escape gives each window a free per-
 * session identity.
 *
 * Format (Queen-specified):
 *   - Assimilated drone session: `borg · <label> · <cubeName>`
 *   - Unassimilated session:     `borg · <repo-basename>`
 *
 * Why OSC 0 (`\x1b]0;…\x07`): sets both window title AND icon name on
 * most terminals. OSC 2 sets only window title; OSC 1 sets only icon
 * name. OSC 0 is the maximally-portable choice — works in iTerm2,
 * macOS Terminal, kitty, alacritty, ghostty, GNOME Terminal, xterm.
 *
 * Lifetime: the escape is emitted once, before spawning Claude Code.
 * Claude Code itself does not set its own window title (verified
 * 2026-05-11), so the borg-set title persists for the whole session.
 *
 * Limitations (acceptable for v1; flagged for future):
 *   - Title doesn't update mid-session on `borg_assimilate`. The
 *     borgmcp client process can't write the escape post-spawn
 *     because stdio is owned by Claude Code at that point (and stdio
 *     to Claude is JSON-RPC — terminal escapes would be parsed as
 *     invalid messages).
 *   - Falls back to repo-basename for the unassimilated case; loses
 *     drone identity until the cube is joined. Typical pattern is
 *     "drone has been around long enough that cubes.json is already
 *     populated," so the assimilated path is the common case.
 */
/**
 * Pure: compose the title string for a session. Exported so tests can
 * exercise every branch without TTY / process / fs dependencies.
 *
 * @param activeDrone — `{label, cubeName}` if this project is
 *   assimilated to a cube, null otherwise.
 * @param repoBasename — fallback identity for the unassimilated case
 *   (typically `basename(process.cwd())`).
 */
export declare function composeTerminalTitle(activeDrone: {
    label: string;
    cubeName: string;
} | null, repoBasename: string): string;
/**
 * Side-effecting: emit the OSC 0 escape to stdout, but only if stdout
 * is a TTY. When stdout is piped (CI, redirection, scripted
 * invocation), emitting the raw escape would pollute the captured
 * output without doing anything useful — so we no-op.
 *
 * Returns the title string that WOULD have been emitted, regardless of
 * TTY state, so callers can log it independently for diagnostics.
 */
export declare function setTerminalTitle(activeDrone: {
    label: string;
    cubeName: string;
} | null, repoBasename: string, stdout?: NodeJS.WriteStream): string;
//# sourceMappingURL=terminal-title.d.ts.map