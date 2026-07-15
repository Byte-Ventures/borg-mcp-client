import type { DroneCandidate } from '../launch-all-discovery.js';
import type { LaunchAllDeps } from '../launch-all-deps.js';
export interface TmuxOpts {
    sessionName: string;
    borgPath: string;
    /** 'attach' = attach-session; 'switch' = switch-client (nested tmux); 'none' = skip. */
    attachMode: 'attach' | 'switch' | 'none';
    /** ISO-8601 captured before the first send-keys (lock-marker launchedAt). */
    launchedAtISO: string;
    /** Stagger between drone launches (ms) to avoid the rate limiter; 0 disables. */
    launchDelayMs: number;
    /** Injectable sleep (real setTimeout in prod; no-op spy in tests). */
    sleep: (ms: number) => Promise<void>;
}
export declare function runTmuxBackend(candidates: DroneCandidate[], opts: TmuxOpts, deps: LaunchAllDeps): Promise<void>;
//# sourceMappingURL=launch-all-tmux.d.ts.map