import type { DroneCandidate } from '../launch-all-discovery.js';
import type { LaunchAllDeps } from '../launch-all-deps.js';
export interface TerminalsOpts {
    borgPath: string;
    platform: NodeJS.Platform;
    cubeName: string;
    launchedAtISO: string;
    /** Stagger between drone launches (ms) to avoid the rate limiter; 0 disables. */
    launchDelayMs: number;
    /** Injectable sleep (real setTimeout in prod; no-op spy in tests). */
    sleep: (ms: number) => Promise<void>;
}
export declare function hasMacOSTerminalApp(deps: Pick<LaunchAllDeps, 'pathExists'>): boolean;
export declare function runTerminalsBackend(candidates: DroneCandidate[], opts: TerminalsOpts, deps: LaunchAllDeps): Promise<void>;
//# sourceMappingURL=launch-all-terminals.d.ts.map