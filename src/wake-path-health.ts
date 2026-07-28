import { probeCodexBridgeArmed } from './codex-app-wake.js';
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
  if (state.sessionId === null) return null;
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
