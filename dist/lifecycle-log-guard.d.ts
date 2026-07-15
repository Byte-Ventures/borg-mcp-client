export type LifecycleSignal = 'arrival' | 'ready';
export interface LifecycleLogSubject {
    cubeId: string;
    droneId: string;
}
interface LifecycleStateEntry {
    lastArrival?: {
        message: string;
        at: string;
    };
    idleReady?: {
        message: string;
        open: boolean;
        at: string;
    };
}
export declare function lifecycleSignalForMessage(message: string): LifecycleSignal | null;
export declare function shouldSuppressLifecycleLogFromState(message: string, state: LifecycleStateEntry | undefined, nowMs?: number): {
    suppress: boolean;
    signal: LifecycleSignal | null;
};
export declare function shouldSuppressLifecycleLog(subject: LifecycleLogSubject, message: string): Promise<{
    suppress: boolean;
    signal: LifecycleSignal | null;
}>;
export declare function nextLifecycleStateAfterLog(message: string, current: LifecycleStateEntry | undefined, nowIso?: string): LifecycleStateEntry;
export declare function recordLifecycleLog(subject: LifecycleLogSubject, message: string): Promise<void>;
export {};
//# sourceMappingURL=lifecycle-log-guard.d.ts.map