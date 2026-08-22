import {
  probeCodexBridgeArmed,
  getCodexDeliveryState,
  codexWakePathHealthy,
  type CodexDeliveryState,
} from './codex-app-wake.js';
import { checkInboxMonitorHealthy } from './stream-status.js';
import {
  getOpenCodeConnectionState,
  type OpenCodeConnectionState,
} from './opencode-drone.js';
import type { AgentKind } from './agent-runtime.js';

export interface WakePathSnapshot {
  agentKind: AgentKind;
  healthy: boolean | null;
  openCode: OpenCodeConnectionState | null;
  // client#89: Codex remote-control delivery state, distinct from SSE health.
  codex?: CodexDeliveryState | null;
}

interface InspectWakePathInputs {
  agentKind: AgentKind;
  active: { cubeId: string; droneId: string } | null;
  inboxPath: string | null;
  monitorStateRoot: string | null;
}

interface InspectWakePathDeps {
  checkClaudeMonitor?: typeof checkInboxMonitorHealthy;
  probeCodex?: typeof probeCodexBridgeArmed;
  getCodexDelivery?: typeof getCodexDeliveryState;
  getOpenCodeState?: typeof getOpenCodeConnectionState;
}

export function openCodeWakePathHealthy(
  state: OpenCodeConnectionState,
): boolean | null {
  if (!state.connected) return false;
  if (
    state.deliveryStates.failed > 0 ||
    state.deliveryStates['delivered-unconfirmed'] > 0
  ) {
    return false;
  }
  if (
    state.deliveryStates.queued > 0 ||
    state.deliveryStates.retried > 0
  ) {
    return null;
  }
  if (state.sessionId === null) {
    return state.lastFailureCode === null ? null : false;
  }
  return true;
}

export async function inspectWakePath(
  inputs: InspectWakePathInputs,
  deps: InspectWakePathDeps = {},
): Promise<WakePathSnapshot> {
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
