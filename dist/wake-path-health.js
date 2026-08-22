import { probeCodexBridgeArmed, getCodexDeliveryState, codexWakePathHealthy, } from './codex-app-wake.js';
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
    if (state.sessionId === null) {
        return state.lastFailureCode === null ? null : false;
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
        // client#89: fold the delivery state into health so a deferred, retrying,
        // or failed injection surfaces as degraded — never as armed/healthy — even
        // while the app-server socket is alive. SSE health is not the discriminator.
        const probe = deps.probeCodex ?? probeCodexBridgeArmed;
        const getDelivery = deps.getCodexDelivery ?? getCodexDeliveryState;
        const armed = await probe(inputs.active);
        const codex = getDelivery();
        return {
            agentKind: inputs.agentKind,
            healthy: codexWakePathHealthy(armed, codex),
            openCode: null,
            codex,
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