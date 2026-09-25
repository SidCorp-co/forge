// The files a room holds, and the stop that ends the turn it is running.
//
// Carved out of `conversation-routes.ts` for its size, the way
// `conversation-member-routes.ts` was (ISS-1011), and mounted into it at the
// same path — so `/api/conversations/:id/...` is one router to a caller and
// three files to a reader.

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readConversationAgentTurns } from '../agent-sessions/conversation-agent.js';
import { loadConversationAttachment } from '../conversations/attachment-service.js';
import { listWindowsForConversation } from '../conversations/windows.js';
import { contentDisposition } from '../lib/attachment-headers.js';
import { allowedSetForTarget } from '../lib/attachment-mime.js';
import type { AuthVars } from '../middleware/auth.js';
import { getStorage } from '../storage/index.js';
import {
  createUploadTicket,
  UPLOAD_TICKET_TTL_MS,
  UploadTicketError,
} from '../uploads/ticket-service.js';
import { readableConversation, writableConversation } from './conversation-access.js';
import { isTurnRunning, stopConversationTurns } from './conversation-stops.js';

const idParamSchema = z.object({ id: z.uuid() });

/**
 * Why this core cannot stop this room's turn. The registry is this process's
 * own, so the turn may be a paired box's or another core's, and answering
 * "idle" to either tells the caller something this door never read.
 */
async function nothingHereToStop(id: string): Promise<HTTPException | null> {
  const handed = (await readConversationAgentTurns(id)).find(
    (t) => t.state === 'dispatched' || t.state === 'running',
  );
  if (handed) {
    return new HTTPException(409, {
      message: `conversation ${id} handed this turn to a paired box, so there is nothing here to stop — end agent session ${handed.sessionId} instead`,
      cause: {
        code: 'CONVERSATION_TURN_HANDED_OFF',
        details: { sessionId: handed.sessionId },
      },
    });
  }

  const elsewhere = (await listWindowsForConversation(id, 5)).find(
    (w) => w.claimedAt !== null && w.closedAt === null && w.claimedBy !== null,
  );
  // A turn that registered during those reads is this core's to stop after all.
  if (isTurnRunning(id)) return null;
  if (elsewhere) {
    return new HTTPException(409, {
      message: `conversation ${id} has window ${elsewhere.id} still open under claim "${elsewhere.claimedBy}", and no turn for it is running on this core — a stop reaches only the core running the turn, so this one cannot end it`,
      cause: {
        code: 'CONVERSATION_TURN_ON_ANOTHER_CORE',
        details: { windowId: elsewhere.id, claimedBy: elsewhere.claimedBy },
      },
    });
  }

  return new HTTPException(409, {
    message: `conversation ${id} is not answering anything right now, so there was nothing to stop`,
    cause: { code: 'CONVERSATION_NOTHING_RUNNING', details: {} },
  });
}

const attachmentTicketSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    mime: z.string().trim().min(1).max(255),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', attachmentTicketSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { name, mime } = c.req.valid('json');
    const userId = c.get('userId');
    await writableConversation(id, userId);

    try {
      const ticket = await createUploadTicket({
        targetType: 'conversation',
        targetId: id,
        uploaderId: userId,
        uploaderDeviceId: null,
        name,
        mime,
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
        201,
      );
    } catch (err) {
      if (err instanceof UploadTicketError) {
        throw new HTTPException(400, {
          message: err.message,
          cause: {
            code: err.code,
            details: err.details ?? { allowed: allowedSetForTarget('conversation') },
          },
        });
      }
      throw err;
    }
  },
);

/** The bytes behind one of this room's attachments, for whoever may read it. */
conversationAttachmentRoutes.get(
  '/:id/attachments/:attachmentId/download',
  zValidator('param', idParamSchema.extend({ attachmentId: z.uuid() }), (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
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
