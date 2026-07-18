/**
 * Pure CLI help-text + flag helpers.
 *
 * Kept in its own module (not in claude.ts) so importing them in tests does NOT
 * run claude.ts's `main()` side effects — the same pattern as parse-assimilate-args.ts
 * and cli-platform.ts.
 */
/** True for the standard help flags `--help` / `-h`. */
export declare function isHelpFlag(arg: string | undefined): boolean;
/**
 * Help text for top-level `borg --help`.
 *
 * Kept pure so tests can pin user-facing discoverability without importing
 * claude.ts, which launches agent CLIs as a side effect.
 */
export declare function topLevelHelpText(version: string): string;
/**
 * Help text for `borg assimilate --help` — the home for the full assimilate flag
 * set. Model/provider configuration belongs to the selected agent CLI.
 */
export declare function assimilateHelpText(version: string): string;
/**
 * Help text for `borg reset-local-seat --help`. The offline, network-free seat
 * reset recommended by the pin-matched SESSION_REJECTED diagnostic (#1082).
 */
export declare function resetLocalSeatHelpText(version: string): string;
/**
 * Help text for `borg setup --help` (gh#520 — previously this ran the setup
 * wizard instead of showing help). Mirrors the `borg setup` description in the
 * top-level `borg --help`.
 */
export declare function setupHelpText(version: string): string;
//# sourceMappingURL=cli-help.d.ts.map