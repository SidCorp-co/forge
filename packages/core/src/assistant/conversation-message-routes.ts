// `POST /api/conversations/:id/messages` — a person says something in a web room, and gets back
// what the room now holds.

import {
  RETIRED_UI_SNAPSHOT_KEYS,
  retiredSnapshotKeySentence,
  uiSnapshotSchema,
} from '@forge/contracts/ui-actions';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  listConversationAttachmentsByIds,
  refuseConversation,
  renameConversation,
} from '../conversations/index.js';
import { conversationModes } from '../db/schema-conversations.js';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { idParamSchema } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { ROOM_WRITE } from './conversation-declarations.js';
import { foreignAttachmentIds, imagesFromAttachments } from './conversation-images.js';
import { sendWebConversationMessage } from './conversation-send.js';
import { webSendSubject } from './conversation-send-checks.js';
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

type Retired = keyof typeof RETIRED_UI_SNAPSHOT_KEYS;
const isRetired = (key: string): key is Retired => Object.hasOwn(RETIRED_UI_SNAPSHOT_KEYS, key);

/**
 * A snapshot carrying a key an earlier web build sent comes from a tab loaded before the deploy. It
 * is refused under CONVERSATION_PAGE_OUT_OF_DATE, a code outside every web build's fixed lines, so
 * that tab prints the sentence telling its person to reload, rather than "Invalid input" (ISS-441).
 * Every other fault in the body keeps its BAD_REQUEST row.
 */
function refuseRetiredSnapshotKeys(r: { success: boolean; error?: z.core.$ZodError }): void {
  if (r.success || !r.error) return;
  const issues = r.error.issues;
  const snapshotKeys = (i: z.core.$ZodIssue): string[] =>
    i.code === 'unrecognized_keys' && i.path.length === 1 && i.path[0] === 'uiSnapshot'
      ? i.keys
      : [];
  const retired = issues.flatMap(snapshotKeys).filter(isRetired);
  if (retired.length === 0) return;
  // an issue naming only retired keys is said by the rows above it; any other fault keeps its row
  const others = issues.filter(
    (i) => !snapshotKeys(i).length || snapshotKeys(i).some((k) => !isRetired(k)),
  );
  const rows: Refusal[] = [
    ...retired.map((key) => ({
      code: 'CONVERSATION_PAGE_OUT_OF_DATE',
      path: jsonPointer(['uiSnapshot', key]),
      detail: retiredSnapshotKeySentence(key),
    })),
    ...others.map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  throw new RefusalError(rows, 'CONVERSATION_PAGE_OUT_OF_DATE');
}

/** A room's name, taken from the first thing said in it. */
const ROOM_NAME_MAX = 80;
function roomNameFrom(content: string, attached: readonly { name: string }[]): string {
  const line = content.trim().split('\n')[0]?.trim() || (attached[0]?.name ?? '');
  return line.length > ROOM_NAME_MAX ? `${line.slice(0, ROOM_NAME_MAX - 1)}…` : line;
}

/**
 * Say something in this room, and get back what the room now holds.
 */
conversationMessageRoutes.post(
  '/:id/messages',
  zValidator('param', idParamSchema),
  ROOM_WRITE,
  zValidator('json', sendSchema, refuseRetiredSnapshotKeys),
  async (c) => {
    const { id } = c.req.valid('param');
    const { content, mode, clientToken, attachmentIds, uiSnapshot } = c.req.valid('json');
    const userId = c.get('userId');

    const { conversation, projectId, asking } = await webSendSubject({ id, userId, mode });

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
