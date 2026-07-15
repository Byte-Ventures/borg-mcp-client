import type { DroneCandidate } from '../launch-all-discovery.js';
import type { LaunchAllDeps } from '../launch-all-deps.js';
export interface WindowsOpts {
    borgPath: string;
    platform: NodeJS.Platform;
    launchedAtISO: string;
    /** Stagger between drone launches (ms) to avoid the rate limiter; 0 disables. */
    launchDelayMs: number;
    /** Injectable sleep (real setTimeout in prod; no-op spy in tests). */
    sleep: (ms: number) => Promise<void>;
}
export declare function runWindowsBackend(candidates: DroneCandidate[], opts: WindowsOpts, deps: LaunchAllDeps): Promise<void>;
//# sourceMappingURL=launch-all-windows.d.ts.map