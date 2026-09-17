/**
 * Whether a room may still be opened in Agent mode — the Forge UI's own question.
 *
 * `GET /api/conversations/agent-mode` answers the same question for a DRAFT, which holds no room to
 * read; the two must answer in one vocabulary, which is why the probe they share
 * (`conversationAgentDeviceAvailable`) is the only thing either of them asks.
 */

import { conversationAgentDeviceAvailable } from '../agent-sessions/conversation-agent.js';
import { type ConversationRow, effectiveConversationMode } from '../conversations/store.js';

/**
 * Whether this room may still be opened in Agent mode, and why not where it may not.
 */
// cm:guard the reason travels with the `false` and is never left for the client to compose: "Agent
// is unavailable" tells a person nothing they can act on, and the two reasons are acted on
// differently — a room that has already been answered needs a NEW conversation, and a project with
// no box needs one paired (ISS-1039).
// cm:guard it lives in a module of its OWN rather than on the route that serves it, and the reason is
// the one `conversation-access.ts` was carved out for: `conversation-routes.ts` reached its 500-line
// budget, and the piece that comes out is the one nothing about routing depends on. It stays under
// `assistant/` because it is the Forge UI's own surface — beside the probe in
// `agent-sessions/conversation-agent.ts` it would make that file a reader of the conversation store,
// which `conversations/transport-free.test.ts` freezes against and would have widened for a line
// budget rather than for an argument (ISS-1078).
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
    return { available: false, reason: 'this project has no box paired' };
  }
  return { available: true, reason: null };
}
