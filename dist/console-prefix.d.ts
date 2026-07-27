/**
 * Drone self-identification prefix for client-emitted console messages.
 *
 * Per gh#25: when a drone session emits a console error (e.g.
 * "Authentication expired — your saved login has expired. Run: borg setup"),
 * the Queen has no way to
 * tell which drone window the message came from without scanning every
 * open terminal. Window title alone (set by terminal-title.ts) is
 * insufficient — the Queen reads the active terminal's output stream,
 * not its title bar.
 *
 * This module exports a one-shot initializer that seeds the process-local
 * display identity from the selected seat, plus a synchronous getter that
 * follows later server confirmations and wraps each console.error.
 *
 * Format (matches the terminal-title.ts middle-dot convention so
 * surfaces stay internally consistent):
 *   `[<drone-label> · <cube-name>]`  (assimilated)
 *   `[borg · <repo-basename>]`       (no cube cached)
 *
 * The not-yet-assimilated shape reads as neutral metadata ("this is
 * borg, in project X"), NOT a fault the user must fix — and mirrors the
 * unassimilated terminal-title shape (`borg · <repo-basename>`), so the
 * title bar and the console prefix agree (gh#818 P1).
 */
/**
 * Resolve the drone-self-identification prefix from cube state and seed the
 * shared display source. Idempotent — later calls do not re-read the store,
 * while the synchronous prefix still follows server-confirmed display changes.
 * Falls back silently on any read error so console emission is never blocked.
 */
export declare function initConsolePrefix(): Promise<string>;
/**
 * Synchronous prefix getter. Returns the current process-local display value
 * if initialized, otherwise the unassimilated fallback — safe to call before
 * initConsolePrefix() resolves.
 */
export declare function droneIdPrefix(): string;
/**
 * Prefix + trailing space, styled dim/gray so the prefix is metadata
 * and the message body retains visual emphasis. Use as
 * `${consolePrefix()}<message>`.
 */
export declare function consolePrefix(): string;
/**
 * Drop-in replacement for `console.error` that prepends the drone
 * self-id prefix. If the first arg is a string, the prefix is
 * concatenated to it; otherwise the prefix is emitted as its own arg
 * (handles the `console.error('label:', value)` shape).
 */
export declare function cerr(...args: any[]): void;
export declare function _resetCachedPrefixForTests(): void;
//# sourceMappingURL=console-prefix.d.ts.map