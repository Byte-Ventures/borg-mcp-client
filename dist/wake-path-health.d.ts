import { probeCodexBridgeArmed, getCodexDeliveryState, type CodexDeliveryState } from './codex-app-wake.js';
import { checkInboxMonitorHealthy } from './stream-status.js';
import { getOpenCodeConnectionState, type OpenCodeConnectionState } from './opencode-drone.js';
import type { AgentKind } from './agent-runtime.js';
export interface WakePathSnapshot {
    agentKind: AgentKind;
    healthy: boolean | null;
    openCode: OpenCodeConnectionState | null;
    codex?: CodexDeliveryState | null;
}
interface InspectWakePathInputs {
    agentKind: AgentKind;
    active: {
        cubeId: string;
        droneId: string;
    } | null;
    inboxPath: string | null;
    monitorStateRoot: string | null;
}
interface InspectWakePathDeps {
    checkClaudeMonitor?: typeof checkInboxMonitorHealthy;
    probeCodex?: typeof probeCodexBridgeArmed;
    getCodexDelivery?: typeof getCodexDeliveryState;
    getOpenCodeState?: typeof getOpenCodeConnectionState;
}
export declare function openCodeWakePathHealthy(state: OpenCodeConnectionState): boolean | null;
export declare function inspectWakePath(inputs: InspectWakePathInputs, deps?: InspectWakePathDeps): Promise<WakePathSnapshot>;
export {};
//# sourceMappingURL=wake-path-health.d.ts.map