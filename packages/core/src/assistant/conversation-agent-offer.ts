import { conversationAgentDeviceAvailable } from '../agent-sessions/conversation-agent.js';
import { type ConversationRow, effectiveConversationMode } from '../conversations/store.js';

/** The device a project would hand a turn, paired but not bound to it: what a person assigns. */
export interface UnboundDevice {
  deviceId: string;
  deviceName: string | null;
  projectSlug: string | null;
}

export interface AgentModeOffer {
  available: boolean;
  reason: string | null;
  unbound: UnboundDevice | null;
}

/** Whether a turn in this project could be handed to a box now, and which box is unassigned if not. */
export async function projectAgentModeOffer(projectId: string): Promise<AgentModeOffer> {
  const device = await conversationAgentDeviceAvailable(projectId);
  if (device.available) return { available: true, reason: null, unbound: null };
  const err = device.unbound;
  return {
    available: false,
    reason: device.reason,
    unbound: err
      ? { deviceId: err.deviceId, deviceName: err.deviceName, projectSlug: err.projectSlug }
      : null,
  };
}

export async function agentModeOffer(
  row: ConversationRow,
  scope: string[],
  messageCount: number,
): Promise<AgentModeOffer> {
  if (row.mode !== null || messageCount > 0) {
    return {
      available: false,
      reason: `this conversation already answers in ${effectiveConversationMode(row)} mode — open another one to talk to the other`,
      unbound: null,
    };
  }
  const projectId = scope.length === 1 ? scope[0] : undefined;
  if (!projectId) {
    return {
      available: false,
      reason: `a turn runs under exactly one project, and this room is about ${scope.length}`,
      unbound: null,
    };
  }
  return projectAgentModeOffer(projectId);
}
