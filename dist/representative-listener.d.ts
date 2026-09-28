import type { Readable } from 'node:stream';
import { type StreamDeps } from './log-stream.js';
import { type RepresentativeCmdDeps } from './representative-cmd.js';
import { type RepresentativeBinding, type RepresentativeStore } from './representative-store.js';
import { type PushEngineDeps } from './representative-push.js';
export declare const LISTENER_PROTOCOL = 2;
export interface ListenerOptions {
    /** Controlled transport/timing seams; the CLI supplies no overrides. */
    streamDeps?: StreamDeps;
    heartbeatIntervalMs?: number;
    reconnectDelay?: (attempt: number) => number;
    reconcileMs?: number;
    now?: () => Date;
    /** The host pipe. Default process.stdin, which must be a pipe or socket. */
    stdin?: Readable;
    hooks?: PushEngineDeps['hooks'];
}
/** Listener lease holder and wake state for `status`. Read-only. */
export declare function representativeListenerStatus(binding: RepresentativeBinding, store: RepresentativeStore): Promise<{
    protocol: number;
    running: boolean;
    wakes: import("./representative-push.js").WakeSummary | null;
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
    protocol?: number;
}, deps: RepresentativeCmdDeps, options?: ListenerOptions): Promise<number>;
//# sourceMappingURL=representative-listener.d.ts.map