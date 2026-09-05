import type { AgentSessionIdentity } from './agent-session-identity.js';
export type LifecycleSignal = 'arrival' | 'ready';
export interface LifecycleLogSubject {
    cubeId: string;
    droneId: string;
}
interface LifecycleStateEntry {
    arrivedSessionIds?: string[];
    idleReady?: {
        message: string;
        open: boolean;
        at: string;
    };
}
export declare function lifecycleSignalForMessage(message: string): LifecycleSignal | null;
export declare function shouldSuppressLifecycleLogFromState(message: string, state: LifecycleStateEntry | undefined, identity?: AgentSessionIdentity): {
    suppress: boolean;
    signal: LifecycleSignal | null;
};
export declare function shouldSuppressLifecycleLog(subject: LifecycleLogSubject, message: string, identity?: AgentSessionIdentity): Promise<{
    suppress: boolean;
    signal: LifecycleSignal | null;
}>;
export declare function nextLifecycleStateAfterLog(message: string, current: LifecycleStateEntry | undefined, nowIso?: string, identity?: AgentSessionIdentity): LifecycleStateEntry;
export declare function recordLifecycleLog(subject: LifecycleLogSubject, message: string, identity?: AgentSessionIdentity): Promise<void>;
export {};
//# sourceMappingURL=lifecycle-log-guard.d.ts.map