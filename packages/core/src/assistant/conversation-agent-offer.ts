import { conversationAgentDeviceAvailable } from '../agent-sessions/conversation-agent.js';
import { type ConversationRow, effectiveConversationMode } from '../conversations/store.js';

export async function agentModeOffer(
  row: ConversationRow,
  scope: string[],
  messageCount: number,
): Promise<{ available: boolean; reason: string | null }> {
  if (row.mode !== null || messageCount > 0) {
    return {
      available: false,
      reason: `this conversation already answers in ${effectiveConversationMode(row)} mode — open another one to talk to the other`,
    };
  }
  const projectId = scope.length === 1 ? scope[0] : undefined;
  if (!projectId) {
    return {
      available: false,
      reason: `a turn runs under exactly one project, and this room is about ${scope.length}`,
    };
  }
  if (!(await conversationAgentDeviceAvailable(projectId))) {
    return { available: false, reason: 'this project has no runner paired' };
  }
  return { available: true, reason: null };
}
