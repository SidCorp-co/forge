import { conversationAgentDeviceAvailable } from '../agent-sessions/conversation-agent.js';
import { listConversationAttachmentsByIds } from '../conversations/attachment-service.js';
import { roomRefusal } from '../conversations/room-refusal.js';
import { derivedScope } from '../conversations/scope.js';
import {
  type ConversationRow,
  effectiveConversationMode,
  readMessages,
  renameConversation,
} from '../conversations/store.js';
import type { ConversationMode } from '../db/schema-conversations.js';
import { foreignAttachmentIds, imagesFromAttachments } from './conversation-images.js';
import {
  ConversationModeSettledError,
  sendWebConversationMessage,
  type WebSendResult,
} from './conversation-send.js';

/** What `POST /api/conversations/:id/messages` carries, as its schema admitted it. */
export interface WebSendInput {
  content: string;
  mode?: ConversationMode | undefined;
  clientToken?: string | undefined;
  attachmentIds?: string[] | undefined;
}

/** A room's name, taken from the first thing said in it. */
const ROOM_NAME_MAX = 80;
function roomNameFrom(content: string, attached: readonly { name: string }[]): string {
  const line = content.trim().split('\n')[0]?.trim() || (attached[0]?.name ?? '');
  return line.length > ROOM_NAME_MAX ? `${line.slice(0, ROOM_NAME_MAX - 1)}…` : line;
}

/**
 * The one project a web turn runs under.
 */
function soleProject(row: ConversationRow, scope: string[]): string {
  const only = scope[0];
  if (scope.length !== 1 || !only) {
    throw roomRefusal(
      409,
      'CONVERSATION_SCOPE_AMBIGUOUS',
      scope.length === 0
        ? 'This room is about no project and a turn runs under exactly one, so there is no project for this message to be answered under'
        : `This room is about ${scope.length} projects and a turn runs under exactly one, so there is no project for this message to be answered under`,
      { conversationId: row.id, projectIds: scope },
    );
  }
  return only;
}

/** Every refusal a send can meet past the door, then the send itself. */
export async function takeWebSend(
  conversation: ConversationRow,
  userId: string,
  { content, mode, clientToken, attachmentIds }: WebSendInput,
): Promise<WebSendResult> {
  const id = conversation.id;
  const scope = await derivedScope(id);
  const projectId = soleProject(conversation, scope);

  const already = await readMessages(id, 1);
  const settled = conversation.mode !== null || already.length > 0;
  if (mode !== undefined && settled) {
    throw roomRefusal(
      409,
      'CONVERSATION_MODE_SETTLED',
      `This room already answers in ${effectiveConversationMode(conversation)} mode; a room's mode is written by its first message and never changes, so open another conversation to talk to the other one`,
      { conversationId: id },
    );
  }
  const asking = mode ?? effectiveConversationMode(conversation);
  const device = asking === 'agent' ? await conversationAgentDeviceAvailable(projectId) : null;
  if (device && !device.available) {
    if (device.unbound) throw device.unbound;
    throw roomRefusal(
      409,
      'CONVERSATION_AGENT_NO_DEVICE',
      "No paired device is free to take an Agent turn for this room's project, so this message was not taken in — nothing was answered in Assistant mode in its place",
      { conversationId: id, projectId },
    );
  }

  const attached = await listConversationAttachmentsByIds(id, attachmentIds ?? []);
  const foreign = foreignAttachmentIds(attachmentIds ?? [], attached);
  if (foreign.length > 0) {
    throw roomRefusal(
      409,
      'CONVERSATION_ATTACHMENT_FOREIGN',
      `${foreign.length === 1 ? 'One attached file is' : `${foreign.length} attached files are`} not in this room, so this message was not taken in — upload the file to this room and send it from here, rather than citing one from another`,
      { conversationId: id, attachmentIds: foreign },
    );
  }

  let sent: WebSendResult;
  try {
    sent = await sendWebConversationMessage({
      room: conversation,
      projectId,
      userId,
      content,
      mode: asking,
      namedMode: mode !== undefined,
      ...(clientToken ? { clientToken } : {}),
      ...(attached.length > 0 ? { images: imagesFromAttachments(attached) } : {}),
    });
  } catch (err) {
    if (err instanceof ConversationModeSettledError) {
      throw roomRefusal(
        409,
        'CONVERSATION_MODE_SETTLED',
        `This room was opened in ${err.settled} mode by a message that landed first; this one was not taken in — send it again, or open another conversation to talk to the other mode`,
        { conversationId: id },
      );
    }
    throw err;
  }

  if (conversation.title === null && sent.seq === 0) {
    await renameConversation(id, roomNameFrom(content, attached));
  }
  return sent;
}
