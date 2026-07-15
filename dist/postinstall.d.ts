#!/usr/bin/env node
/**
 * Post-install script
 *
 * Detects local vs global installation and rejects local installs.
 * gh#653 B1: also detects whether an agent CLI (Claude Code / Codex) is present
 * and adjusts the "next step" banner so a user with no agent CLI is told to
 * install one FIRST rather than being sent into `borg setup`'s dead-end.
 */
export {};
//# sourceMappingURL=postinstall.d.ts.map