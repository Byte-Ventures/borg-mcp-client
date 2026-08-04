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
import { spawn } from 'child_process';
import { buildDefaultAssimilateDeps } from './assimilate-deps.js';
import { connectOpenCodeDrone, createOpenCodeLaunchKickoff } from './opencode-drone.js';
export type AssimilateDepsBuilder = typeof buildDefaultAssimilateDeps;
export declare function createOpenCodeLaunchPlan(cwd: string, port: number, prompt: string, passthroughArgs?: string[]): {
    launchArgs: string[];
    envPort: string;
    serverUrl: string;
};
export declare function launchOpenCodeProcess(options: {
    cwd: string;
    port: number;
    prompt: string;
    passthroughArgs: string[];
    env: NodeJS.ProcessEnv;
    droneLabel: string;
    cubeName: string;
    kickoff: ReturnType<typeof createOpenCodeLaunchKickoff>;
    spawnProcess?: typeof spawn;
    connect?: typeof connectOpenCodeDrone;
}): {
    launchArgs: string[];
    launchEnv: NodeJS.ProcessEnv;
    process: ReturnType<typeof spawn>;
};
export declare function runAssimilateEntry(args: readonly string[], buildDeps?: AssimilateDepsBuilder): Promise<number>;
//# sourceMappingURL=claude.d.ts.map