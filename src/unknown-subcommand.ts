/**
 * gh#911: top-level CLI footgun guard.
 *
 * `borg <unknown>` (e.g. `borg evict-drone X`) used to fall through the
 * subcommand router, get ignored by parseCliFlag (which validates only
 * `--cli`), and silently LAUNCH a Claude Code session with the typo'd word as
 * its prompt — surprising + wasteful, and the trailing args were dropped.
 *
 * This pure predicate lets claude.ts reject an unknown NON-FLAG argv[2] before
 * the default launch. Bare `borg` (no argv[2]) and recognized flags
 * (`--cli`, `--remote`, agent passthrough, …) still fall through to launch.
 */

/** The subcommands the claude.ts router dispatches on (lines 107-176). */
export const KNOWN_SUBCOMMANDS = [
  'setup',
  'assimilate',
  'reset-local-seat',
  'spawn',
  'sync',
  'cleanup',
  'launch-all',
  'server',
] as const;

/**
 * Returns the offending command string when argv[2] is an unknown non-flag
 * positional (caller should error + exit 1), or null when it's bare `borg`,
 * a flag, or a known subcommand (caller falls through to existing handling).
 */
export function unknownSubcommand(argv2: string | undefined): string | null {
  if (argv2 === undefined) return null; // bare `borg`
  if (argv2.startsWith('-')) return null; // a flag → handled downstream
  if ((KNOWN_SUBCOMMANDS as readonly string[]).includes(argv2)) return null;
  return argv2; // unknown non-flag positional → footgun
}
