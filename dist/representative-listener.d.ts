import { type StreamDeps } from './log-stream.js';
import { type RepresentativeCmdDeps } from './representative-cmd.js';
import type { RepresentativeBinding } from './representative-store.js';
export interface ListenerOptions {
    /** Controlled transport/timing seams; the CLI supplies no overrides. */
    streamDeps?: StreamDeps;
    heartbeatIntervalMs?: number;
    reconnectDelay?: (attempt: number) => number;
}
export declare function representativeListenerStatus(binding: RepresentativeBinding): Promise<{
    watermark: string | null;
    inbox: string;
    running: boolean;
    state: "owner" | "owned-by-other-process" | "initializing" | "orphaned-initialization" | "unowned";
    pid?: number;
    processNonce?: string;
    cwd?: string;
    startedAt?: string;
    heartbeatAt?: string;
    worktree?: string;
    droneLabel?: string;
    cubeName?: string;
    ageMs?: number;
    lockPath?: string;
    lockDev?: number;
    lockIno?: number;
}>;
export declare function runListener(command: {
    worktree?: string;
    replayAfter?: string;
}, deps: RepresentativeCmdDeps, options?: ListenerOptions): Promise<number>;
//# sourceMappingURL=representative-listener.d.ts.map