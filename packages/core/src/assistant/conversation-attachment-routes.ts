// The files a room holds, and the stop that ends the turn it is running.
//
// Carved out of `conversation-routes.ts` for its size, the way
// `conversation-member-routes.ts` was (ISS-1011), and mounted into it at the
// same path — so `/api/conversations/:id/...` is one router to a caller and
// three files to a reader.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  loadConversationAttachment,
  readableConversation,
  writableConversation,
} from '../conversations/index.js';
import { getStorage } from '../integrations/index.js';
import { contentDisposition } from '../lib/attachment-headers.js';
import type { AuthVars } from '../middleware/auth.js';
import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { noQuery, zValidator } from '../middleware/zod-validator.js';
import { createUploadTicket, UPLOAD_TICKET_TTL_MS } from '../uploads/index.js';
import { ROOM_READ, ROOM_WRITE } from './conversation-declarations.js';
import { isTurnRunning, nothingHereToStop, stopConversationTurns } from './conversation-stops.js';

const attachmentTicketSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    mime: z.string().trim().min(1).max(255),
    /** One per file the caller means to store: minted again on a retry, so a lost answer stores nothing twice. */
    operationId: z.string().trim().min(8).max(128),
  })
  .strict();

export const conversationAttachmentRoutes = new Hono<{ Variables: AuthVars }>();

/**
 * Mint the capability that puts one file in this room.
 *
 * The ticket path rather than a multipart route of its own: the bytes then
 * stream through `PUT /api/uploads/:uploadId`, which already owns the body
 * limit and the type-from-the-bytes resolution. What this call owns is the one
 * question that route cannot ask — may THIS caller write in THIS room.
 */
conversationAttachmentRoutes.post(
  '/:id/attachments',
  zValidator('param', idParamSchema),
  ROOM_WRITE,
  zValidator('json', attachmentTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { name, mime, operationId } = c.req.valid('json');
    const userId = c.get('userId');
    await writableConversation(id, userId);

    const ticket = await createUploadTicket({
      targetType: 'conversation',
      targetId: id,
      uploaderId: userId,
      uploaderDeviceId: null,
      name,
      mime,
      operationId,
    });
    return c.json(
      {
        uploadId: ticket.id,
        method: 'PUT' as const,
        uploadPath: `/api/uploads/${ticket.id}`,
        maxBytes: ticket.maxBytes,
        expiresAt: ticket.expiresAt.toISOString(),
        expiresInMs: UPLOAD_TICKET_TTL_MS,
      },
      ticket.replay ? 200 : 201,
    );
  },
);

/** The bytes behind one of this room's attachments, for whoever may read it. */
conversationAttachmentRoutes.get(
  '/:id/attachments/:attachmentId/download',
  zValidator('param', idParamSchema.extend({ attachmentId: z.uuid() })),
  ROOM_READ,
  noQuery,
  async (c) => {
    const { id, attachmentId } = c.req.valid('param');
    await readableConversation(id, c.get('userId'));
    const att = await loadConversationAttachment(id, attachmentId);
    if (!att) throw notFound(`no attachment ${attachmentId} on conversation ${id}`);
    const bytes = await getStorage().get(att.path);
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': att.mime,
      'content-length': String(bytes.byteLength),
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition('inline', att.name),
      'cache-control': 'private, no-store',
    });
  },
);

/**
 * End the turn this room is running.
 *
 * Only a turn THIS core holds open can be ended here. A turn handed to a paired
 * box is that session's to cancel, and a room running nothing is told so by
 * name rather than answered 200 over a stop that stopped nothing.
 */
conversationAttachmentRoutes.post(
  '/:id/stop',
  zValidator('param', idParamSchema),
  ROOM_WRITE,
  async (c) => {
    const { id } = c.req.valid('param');
    await writableConversation(id, c.get('userId'));

    if (!isTurnRunning(id)) {
      const refusal = await nothingHereToStop(id);
      if (refusal) throw refusal;
    }

    return c.json({ conversationId: id, stopped: stopConversationTurns(id) }, 200);
  },
);
