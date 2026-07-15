import type { BorgCli } from './cubes.js';
import { type AgentKind } from './regen-format.js';
/**
 * The claude kickoff prompt's wake-path section (gh#929) — the SAME shared
 * `wakePathArming` the SessionStart hook + /clear orientation use (one place,
 * not three), plus a one-line NEVER-TaskStop safety reminder preserved from
 * the pre-gh#929 monitorClause. Built by both launch call sites
 * (claude.ts + assimilate-cmd.ts) and passed to `buildAgentKickoffPrompt` as
 * `monitorClause`. Codex wakes via the app-server (no tail-Monitor / `/loop`
 * to arm) → empty; no active cube (no inboxPath) → empty.
 */
export declare function buildKickoffWakePathClause(agentKind: AgentKind, inboxPath: string | null, monitorStateRoot?: string | null): string;
export interface CodexWakeTargetDeps {
    setCodexWakeTarget: (cubeId: string, droneId: string, target: {
        threadId: string;
        socketPath: string;
    }) => Promise<void>;
    findLoadedCodexThread: (options: {
        socketPath: string;
        cwd: string;
        previewIncludes: string;
        updatedAfter: number;
    }) => Promise<string | null>;
}
export declare function buildAgentKickoffPrompt(options: {
    cli: BorgCli;
    codexWakeNonce: string | null;
    monitorClause: string;
    codexWakePathClause?: string;
}): string;
export declare function socketPathFromRemoteArgs(args: string[]): string | null;
export declare function threadIdFromPassthroughArgs(args: string[]): string | null;
export declare function recordCodexWakeTarget(options: {
    deps: CodexWakeTargetDeps;
    cubeId: string;
    droneId: string;
    socketPath: string;
    cwd: string;
    previewNeedle: string;
    launchedAtSeconds: number;
    passthroughArgs?: string[];
}): Promise<void>;
//# sourceMappingURL=codex-launch.d.ts.map