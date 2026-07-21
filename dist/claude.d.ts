#!/usr/bin/env node
/**
 * Borg CLI launcher
 *
 * Spawns Claude Code with a minimal kickoff prompt so the SessionStart
 * hook's injected drone playbook actually fires on the first turn.
 * Without this, Claude sits waiting for user input and the autonomous
 * "look at the log and act" directive never executes.
 *
 * Commands:
 *   borg                → Launch Claude with kickoff prompt
 *   borg setup          → Re-route to the setup wizard
 *   borg spawn <name>   → Create a sibling git worktree + launch a
 *                         fresh drone inside it (see spawn.ts)
 *   borg sync           → Advance the current worktree across the 5
 *                         lifecycle states (see sync.ts, gh#33)
 *   borg server <cmd>   → Forward a lifecycle command to borg-mcp-server
 */
export {};
//# sourceMappingURL=claude.d.ts.map