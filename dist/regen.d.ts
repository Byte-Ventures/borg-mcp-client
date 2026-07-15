#!/usr/bin/env node
/**
 * borg-regen CLI
 *
 * Prints a markdown-formatted regen of the active cube to stdout.
 * Designed to be wired into a Claude Code SessionStart hook so that
 * each new session begins fully oriented to the cube.
 *
 * Behavior:
 * - No active cube: print a friendly notice to stdout, exit 0.
 *   (A SessionStart hook should not block session start over a missing
 *   cube — the user may not be using Borg in this directory.)
 * - Active cube + success: print regen markdown to stdout, exit 0.
 * - Active cube + HTTP/auth error: print one-line message to stderr,
 *   exit non-zero so the hook surfaces the failure but doesn't drown
 *   the session in a stack trace.
 */
export {};
//# sourceMappingURL=regen.d.ts.map