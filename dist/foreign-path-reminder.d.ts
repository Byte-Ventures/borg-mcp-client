#!/usr/bin/env node
/**
 * Non-blocking pre-tool reminder for a Borg-launched seat.
 *
 * Claude Code and Codex pass a JSON hook payload on stdin. The hook only
 * emits a reminder when the payload names a working directory or target path
 * outside the two paths Borg granted to this seat. It never returns a deny
 * decision and exits successfully for malformed, missing, or unconfigured
 * input so the harness permission layer remains the enforcement point.
 */
export {};
//# sourceMappingURL=foreign-path-reminder.d.ts.map