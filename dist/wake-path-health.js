import { probeCodexBridgeArmed } from './codex-app-wake.js';
import { checkInboxMonitorHealthy } from './stream-status.js';
import { getOpenCodeConnectionState, } from './opencode-drone.js';
export function openCodeWakePathHealthy(state) {
    if (!state.connected)
        return false;
    if (state.deliveryStates.failed > 0 ||
        state.deliveryStates['delivered-unconfirmed'] > 0) {
        return false;
    }
    if (state.deliveryStates.queued > 0 ||
        state.deliveryStates.retried > 0) {
        return null;
    }
    return true;
}
export async function inspectWakePath(inputs, deps = {}) {
    if (!inputs.active) {
        return {
            agentKind: inputs.agentKind,
            healthy: null,
            openCode: null,
        };
    }
    if (inputs.agentKind === 'claude') {
        const check = deps.checkClaudeMonitor ?? checkInboxMonitorHealthy;
        return {
            agentKind: inputs.agentKind,
            healthy: check(inputs.inboxPath, inputs.monitorStateRoot),
            openCode: null,
        };
    }
    if (inputs.agentKind === 'codex') {
        const probe = deps.probeCodex ?? probeCodexBridgeArmed;
        return {
            agentKind: inputs.agentKind,
            healthy: await probe(inputs.active),
            openCode: null,
        };
    }
    const getState = deps.getOpenCodeState ?? getOpenCodeConnectionState;
    const openCode = getState();
    return {
        agentKind: inputs.agentKind,
        healthy: openCodeWakePathHealthy(openCode),
        openCode,
    };
}
//# sourceMappingURL=wake-path-health.js.map