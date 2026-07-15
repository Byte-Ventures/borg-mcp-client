import type { LaunchAllArgs } from './parse-launch-all-args.js';
import type { LaunchAllDeps } from './launch-all-deps.js';
/**
 * Default ms to wait BETWEEN each drone launch, so a fleet's agents don't all
 * bootstrap at once and trip the per-user/IP rate limiter. Override per-run with
 * `--launch-delay <ms>` or persistently with `$BORG_LAUNCH_DELAY_MS`; 0 disables.
 */
export declare const DEFAULT_LAUNCH_DELAY_MS = 2000;
/** Resolve the inter-launch stagger: flag > env > default (each must be a non-negative integer to win). */
export declare function resolveLaunchDelayMs(flag: number | undefined, env: string | undefined): number;
export interface RunLaunchAllOptions {
    /** Injectable clock/sleep for deterministic reconciliation tests. */
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    nowISO?: () => string;
    borgPath?: string;
}
export declare function runLaunchAll(args: LaunchAllArgs, deps: LaunchAllDeps, opts?: RunLaunchAllOptions): Promise<number>;
//# sourceMappingURL=launch-all-cmd.d.ts.map