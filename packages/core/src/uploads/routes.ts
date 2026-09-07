import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  persistSessionAttachment,
  SessionAttachmentError,
} from '../agent-sessions/attachment-service.js';
import {
  AttachmentError as CommentAttachmentError,
  persistCommentAttachment,
} from '../comments/attachment-service.js';
import { env } from '../config/env.js';
import {
  AttachmentError as IssueAttachmentError,
  persistIssueAttachment,
} from '../issues/attachment-service.js';
import { getStorage } from '../storage/index.js';
import { loadAttachmentBytesTarget } from './attachment-bytes.js';
import { resolveDownloadTicket } from './download-ticket-service.js';
import { claimUploadTicket, releaseUploadTicket } from './ticket-service.js';

const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });
const goneOrNotFound = () =>
  new HTTPException(404, {
    message: 'upload ticket not found, expired, or already used',
    cause: { code: 'UPLOAD_TICKET_INVALID' },
  });

const uploadIdParamSchema = z.object({ uploadId: z.uuid() });

/**
 * Capability-authenticated upload endpoint (presigned-URL pattern).
 *
 * Mounted at `/api/uploads` with NO auth middleware: the ticket id minted by
 * `forge_uploads` is an unguessable, single-use, short-TTL capability — its
 * possession IS the authorization, so this sidesteps the JWT/PAT/device-token
 * tangle on the bearer-guarded `/api/{issues,comments}/:id/attachments` routes.
 *
 * The holder streams raw file bytes with `PUT /api/uploads/:uploadId` (no
 * multipart, no token). All attachment params (target, name, mime, uploader)
 * come from the server-side ticket, so the URL cannot be tampered with.
 */
export const uploadRoutes = new Hono();

uploadRoutes.put(
  '/:uploadId',
  bodyLimit({
    maxSize: env.UPLOADS_MAX_BYTES,
    onError: () => {
      throw badRequest('file too large', 'FILE_TOO_LARGE');
    },
  }),
  zValidator('param', uploadIdParamSchema, (r) => {
    if (!r.success) throw badRequest('invalid uploadId', 'BAD_REQUEST');
  }),
  async (c) => {
    const { uploadId } = c.req.valid('param');

    // cm:guard the claim must stay a single atomic UPDATE ... WHERE status = 'pending' RETURNING, never a read-then-write: two callers holding one presigned URL would both pass a separate check and both upload, and the second's bytes would land under a ticket the first already consumed.
    const ticket = await claimUploadTicket(uploadId);
    if (!ticket) throw goneOrNotFound();

    try {
      const bytes = Buffer.from(await c.req.arrayBuffer());
      if (bytes.length === 0) throw badRequest('empty file', 'EMPTY_FILE');

      let persisted: unknown;
      if (ticket.targetType === 'issue') {
        persisted = await persistIssueAttachment({
          issueId: ticket.targetId,
          name: ticket.name,
          mime: ticket.mime,
          bytes,
          uploaderId: ticket.uploaderId,
          // cm:guard `'human'` here is a PLACEHOLDER, not a measurement — this route authenticates by the upload ticket alone, and `upload_tickets` records who the uploader is but not whether an agent was driving. Carry agency on the ticket at mint time and read it here; until then an agent's upload is filed under its owner, which is what the row already said before this column existed.
          uploaderAgency: 'human',
        });
      } else if (ticket.targetType === 'session') {
        persisted = await persistSessionAttachment({
          sessionId: ticket.targetId,
          name: ticket.name,
          mime: ticket.mime,
          bytes,
          uploaderId: ticket.uploaderId,
          uploaderDeviceId: ticket.uploaderDeviceId,
        });
      } else {
        persisted = await persistCommentAttachment({
          commentId: ticket.targetId,
          name: ticket.name,
          mime: ticket.mime,
          bytes,
          uploaderId: ticket.uploaderId,
          uploaderDeviceId: ticket.uploaderDeviceId,
        });
      }

      return c.json(persisted, 201);
    } catch (err) {
      // cm:why re-open rather than burn the ticket — the bytes never landed, so a transient failure lets the holder retry the same presigned URL instead of paying a second mint
      await releaseUploadTicket(uploadId);
      if (
        err instanceof IssueAttachmentError ||
        err instanceof CommentAttachmentError ||
        err instanceof SessionAttachmentError
      ) {
        throw badRequest(err.message, err.code, err.details);
      }
      throw err;
    }
  },
);

// cm:edge contract -> packages/core/src/uploads/download-ticket-service.ts — the ticket id in this path IS the credential, so this route must stay OUTSIDE any auth middleware; adding one here re-breaks third-party fetchers, which is the whole reason it exists
uploadRoutes.get(
  '/download/:ticketId',
  zValidator('param', z.object({ ticketId: z.uuid() }), (r) => {
    if (!r.success) throw badRequest('invalid ticketId', 'BAD_REQUEST');
  }),
  async (c) => {
    const { ticketId } = c.req.valid('param');
    const ticket = await resolveDownloadTicket(ticketId);
    if (!ticket) {
      throw new HTTPException(404, {
        message: 'download ticket not found or expired',
        cause: { code: 'DOWNLOAD_TICKET_INVALID' },
      });
    }

    const att = await loadAttachmentBytesTarget(ticket.targetType, ticket.attachmentId);
    if (!att) {
      throw new HTTPException(404, {
        message: 'attachment not found',
        cause: { code: 'NOT_FOUND' },
      });
    }

    const bytes = await getStorage().get(att.path);
    // cm:guard the filename is uploaded (untrusted) content — keep it quoted and header-encoded so it cannot inject additional response headers
    const safeName = att.name.replace(/[\r\n"]/g, '_');
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': att.mime,
      'content-length': String(bytes.byteLength),
      // cm:edge contract -> packages/core/src/lib/attachment-headers.ts — the same bytes are also served by the three bearer-guarded routes through that helper, which sends `nosniff` on every response; this route sends its own headers and must carry it too, or the one surface reachable with no credential is the one where a browser may sniff an uploaded blob into markup
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${safeName}"`,
      'cache-control': 'private, no-store',
    });
  },
);
