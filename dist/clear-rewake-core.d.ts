export declare const CLEAR_REWAKE_REMINDER = "Post-/clear recovery: full regen, drain the unread log; handle actionable cube entries, otherwise resume the work from before this wake.";
export interface ClearRewakeResult {
    exitCode: 0 | 2;
    stderr: string;
}
/**
 * Resolve the Claude `/clear` async-rewake response without consulting cube
 * state. The reminder is deliberately static: hook input can contain local
 * paths and session metadata, none of which may cross into stderr.
 */
export declare function evaluateClearRewake(raw: string, env?: NodeJS.ProcessEnv): ClearRewakeResult;
//# sourceMappingURL=clear-rewake-core.d.ts.map