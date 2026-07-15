export interface LaunchAllFlags {
    mode?: 'tmux' | 'windows' | 'pastelist';
    only?: string;
    dryRun?: boolean;
    cli?: 'claude' | 'codex' | 'opencode';
    noAttach?: boolean;
    yes?: boolean;
    force?: boolean;
    /**
     * Milliseconds to wait BETWEEN each drone launch, to avoid the per-user/IP
     * rate limiter when a fleet's worth of agents all bootstrap at once
     * (assimilate + regen + roster). 0 disables. Default + env override: see
     * launch-all-cmd (DEFAULT_LAUNCH_DELAY_MS / BORG_LAUNCH_DELAY_MS).
     */
    launchDelayMs?: number;
}
export interface LaunchAllArgs {
    cubeName?: string;
    flags: LaunchAllFlags;
}
export type ParseLaunchAllResult = {
    ok: true;
    args: LaunchAllArgs;
} | {
    ok: false;
    error: string;
};
export declare function parseLaunchAllArgs(rawArgs: string[]): ParseLaunchAllResult;
//# sourceMappingURL=parse-launch-all-args.d.ts.map