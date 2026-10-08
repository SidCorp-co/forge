// `POST /api/conversations/:id/messages` — a person says something in a web room, and gets back
// what the room now holds.

import { uiSnapshotSchema } from '@forge/contracts/ui-actions';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  type ConversationRow,
  conversationAgentUnavailableReason,
  derivedScope,
  effectiveConversationMode,
  listConversationAttachmentsByIds,
  readMessages,
  refuseConversation,
  renameConversation,
  writableConversation,
} from '../conversations/index.js';
import { conversationModes } from '../db/schema-conversations.js';
import { chatModelName } from '../integrations/llm/index.js';
import type { AuthVars } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { foreignAttachmentIds, imagesFromAttachments } from './conversation-images.js';
import { sendWebConversationMessage } from './conversation-send.js';
import { roomTail, speakerLabelOf } from './read.js';
import { rememberUiSnapshot } from './ui-snapshot.js';

export const conversationMessageRoutes = new Hono<{ Variables: AuthVars }>();

const sendSchema = z
  .object({
    content: z.string().max(40_000),
    mode: z.enum(conversationModes).optional(),
    /**
     * The caller's own id for this message, echoed on `conversation.accepted`.
     */
    clientToken: z.string().min(1).max(200).optional(),
    /**
     * Files already uploaded to THIS room, staged in its composer (ISS-1146).
     */
    attachmentIds: z.array(z.uuid()).max(10).optional(),
    /** The page beside the chat as the browser holds it, typed by the UI-action registry (ISS-47). */
    uiSnapshot: uiSnapshotSchema.optional(),
  })
  .strict()
  .refine((v) => v.content.trim().length > 0 || (v.attachmentIds?.length ?? 0) > 0, {
    error:
      'a message carries text, a file, or both — this one carries neither, so there is nothing to say',
  });

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
    throw refuseConversation(
      'CONVERSATION_SCOPE_AMBIGUOUS',
      `conversation ${row.id} is about ${scope.length} projects (${scope.join(', ') || 'none'}) and a turn runs under exactly one, so there is no project for this message to be answered under`,
    );
  }
  return only;
}

/**
 * Say something in this room, and get back what the room now holds.
 */
conversationMessageRoutes.post(
  '/:id/messages',
  zValidator('param', idParamSchema),
  zValidator('json', sendSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { content, mode, clientToken, attachmentIds, uiSnapshot } = c.req.valid('json');
    const userId = c.get('userId');

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

    const attached = await listConversationAttachmentsByIds(id, attachmentIds ?? []);
    const foreign = foreignAttachmentIds(attachmentIds ?? [], attached);
    if (foreign.length > 0) {
      throw refuseConversation(
        'CONVERSATION_ATTACHMENT_FOREIGN',
        `attachment ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not on conversation ${id}, so this message was not taken in — upload the file to this room and send its id, rather than citing one from another`,
        '/attachmentIds',
      );
    }

    const userLabel = await speakerLabelOf(userId);

    if (uiSnapshot) rememberUiSnapshot(conversation.id, uiSnapshot);
    const sent = await sendWebConversationMessage({
      room: {
        id: conversation.id,
        externalId: conversation.externalId,
        shape: conversation.shape,
      },
      projectId,
      userId,
      viaTokenId: c.get('patTokenId') ?? null,
      userLabel,
      content,
      mode: asking,
      namedMode: mode !== undefined,
      ...(clientToken ? { clientToken } : {}),
      ...(attached.length > 0 ? { images: imagesFromAttachments(attached) } : {}),
    });

    if (conversation.title === null && sent.seq === 0) {
      await renameConversation(id, roomNameFrom(content, attached));
    }

    return c.json({ ...sent, ...(await roomTail(id, userId)) }, sent.mode === 'agent' ? 202 : 201);
  },
);
