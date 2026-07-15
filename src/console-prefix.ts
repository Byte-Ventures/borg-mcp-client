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
 * This module exports a one-shot initializer that resolves the prefix
 * from the local cube state cache, plus a synchronous getter that
 * call sites use to wrap each console.error.
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

import { basename } from 'node:path';
import chalk from 'chalk';
import { getActiveCube } from './cubes.js';

let cachedPrefix: string | null = null;

/** Neutral prefix for a not-yet-assimilated session (gh#818 P1). */
function unassimilatedPrefix(): string {
  return `[borg · ${basename(process.cwd())}]`;
}

/**
 * Resolve the drone-self-identification prefix from cube state and
 * cache it for subsequent synchronous reads. Idempotent — calling
 * multiple times returns the same value. Falls back silently to the
 * unassimilated shape on any read error so console emission is never
 * blocked.
 */
export async function initConsolePrefix(): Promise<string> {
  if (cachedPrefix !== null) return cachedPrefix;
  try {
    const active = await getActiveCube();
    if (active?.droneLabel && active?.name) {
      cachedPrefix = `[${active.droneLabel} · ${active.name}]`;
      return cachedPrefix;
    }
  } catch {
    // Fall through to unassimilated fallback.
  }
  cachedPrefix = unassimilatedPrefix();
  return cachedPrefix;
}

/**
 * Synchronous prefix getter. Returns the cached value if initialized,
 * otherwise the unassimilated fallback — safe to call before
 * initConsolePrefix() resolves.
 */
export function droneIdPrefix(): string {
  if (cachedPrefix !== null) return cachedPrefix;
  return unassimilatedPrefix();
}

/**
 * Prefix + trailing space, styled dim/gray so the prefix is metadata
 * and the message body retains visual emphasis. Use as
 * `${consolePrefix()}<message>`.
 */
export function consolePrefix(): string {
  return chalk.gray(droneIdPrefix()) + ' ';
}

/**
 * Drop-in replacement for `console.error` that prepends the drone
 * self-id prefix. If the first arg is a string, the prefix is
 * concatenated to it; otherwise the prefix is emitted as its own arg
 * (handles the `console.error('label:', value)` shape).
 */
export function cerr(...args: any[]): void {
  if (args.length === 0) {
    console.error(consolePrefix());
    return;
  }
  if (typeof args[0] === 'string') {
    console.error(consolePrefix() + args[0], ...args.slice(1));
  } else {
    console.error(consolePrefix(), ...args);
  }
}

export function _resetCachedPrefixForTests(): void {
  cachedPrefix = null;
}
