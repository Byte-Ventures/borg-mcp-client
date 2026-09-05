import type { BorgCli } from './cubes.js';
import type { AgentKind } from './agent-runtime.js';
import { type CodexRemoteReadyLaunch } from './codex-remote.js';
/**
 * The claude kickoff prompt's wake-path section (gh#929) — the SAME shared
 * `wakePathArming` the SessionStart hook + /clear orientation use (one place,
 * not three), plus a one-line NEVER-TaskStop safety reminder preserved from
 * the pre-gh#929 monitorClause. Built by both launch call sites
 * (claude.ts + assimilate-cmd.ts) and passed to `buildAgentKickoffPrompt` as
 * `monitorClause`. Codex wakes via the app-server (no tail-Monitor to arm) →
 * empty; no active cube (no inboxPath) → empty.
 */
export declare function buildKickoffWakePathClause(agentKind: AgentKind, inboxPath: string | null, monitorStateRoot?: string | null): string;
export declare function buildAgentKickoffPrompt(options: {
    cli: BorgCli;
    monitorClause: string;
}): string;
export type CodexLaunchArgsResult = {
    ready: true;
    args: string[];
} | {
    ready: false;
    reason: string;
};
export declare function buildCodexLaunchArgs(options: {
    remote: CodexRemoteReadyLaunch;
    cwd: string;
    kickoff: string;
    approvalArgs?: string[];
    accessArgs?: string[];
    seatExpectationArgs?: string[];
    passthroughArgs?: string[];
}): CodexLaunchArgsResult;
//# sourceMappingURL=codex-launch.d.ts.map