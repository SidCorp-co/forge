// What a message into a web room is refused for before it is taken in, asked once for every door that
// sends one: the Forge UI's `POST /api/conversations/:id/messages` and the MCP door's `bot.send`
// (REQ-91), so a send from an MCP client meets the very refusals a typed one meets.

import {
  type ConversationRow,
  conversationAgentUnavailableReason,
  derivedScope,
  effectiveConversationMode,
  readMessages,
  refuseConversation,
  writableConversation,
} from '../conversations/index.js';
import type { ConversationMode } from '../db/schema-conversations.js';
import { chatModelName } from '../integrations/llm/index.js';

/**
 * The one project a web turn runs under.
 */
export function soleProject(row: ConversationRow, scope: string[]): string {
  const only = scope[0];
  if (scope.length !== 1 || !only) {
    throw refuseConversation(
      'CONVERSATION_SCOPE_AMBIGUOUS',
      `conversation ${row.id} is about ${scope.length} projects (${scope.join(', ') || 'none'}) and a turn runs under exactly one, so there is no project for this message to be answered under`,
    );
  }
  return only;
}

export interface WebSendSubject {
  conversation: ConversationRow;
  projectId: string;
  /** The mode this message is answered in: the one it names, else the room's. */
  asking: ConversationMode;
}

/**
 * The room a person may send into, the project its turn runs under and the mode it answers in, or
 * the refusal naming why this message would not be taken in.
 */
export async function webSendSubject(args: {
  id: string;
  userId: string;
  mode: ConversationMode | undefined;
}): Promise<WebSendSubject> {
  const { id, userId, mode } = args;
  const conversation = await writableConversation(id, userId);
  if (conversation.adapter !== 'web') {
    throw refuseConversation(
      'CONVERSATION_NOT_WEB',
      `conversation ${id} is a ${conversation.adapter} room, and the Forge UI speaks only in the rooms it opened — answer there instead`,
    );
  }
  const scope = await derivedScope(id);
  const projectId = soleProject(conversation, scope);

  const already = await readMessages(id, 1);
  const settled = conversation.mode !== null || already.length > 0;
  if (mode !== undefined && settled) {
    throw refuseConversation(
      'CONVERSATION_MODE_SETTLED',
      `conversation ${id} already answers in ${effectiveConversationMode(conversation)} mode; a room's mode is written by its first message and never changes, so open another conversation to talk to the other one`,
    );
  }
  const asking = mode ?? effectiveConversationMode(conversation);
  if (conversation.requirementId && asking === 'agent') {
    throw refuseConversation(
      'CONVERSATION_BA_ASSISTANT_ONLY',
      `conversation ${id} is a BA room about a requirement, answered in Assistant mode through its narrow tool set; an Agent turn would reach past it, so this message was not taken in`,
    );
  }
  // Assistant mode with no chat model is refused here by name (503), never taken in and
  // answered with an "overloaded" apology the person would retry for ever (REQ-19)
  if (asking === 'assistant') {
    chatModelName();
  }
  const unavailable =
    asking === 'agent' ? await conversationAgentUnavailableReason(projectId) : null;
  if (unavailable) {
    throw refuseConversation(
      'CONVERSATION_AGENT_NO_DEVICE',
      `no paired device can take an Agent turn for project ${projectId} (${unavailable}), so this message was not taken in — nothing was answered in Assistant mode in its place`,
      '/mode',
    );
  }
  return { conversation, projectId, asking };
}
