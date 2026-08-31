import { z } from 'zod';
import { env } from '../../config/env.js';
import type { McpPrincipal } from '../../middleware/require-pat-or-device.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import { getStorage } from '../../storage/index.js';
import {
  loadAttachmentForFetch,
  loadCommentProjectId,
  loadIssueProjectId,
  loadSessionProjectId,
} from '../../uploads/attachment-lookup.js';
import { createDownloadTicket } from '../../uploads/download-ticket-service.js';
import {
  createUploadTicket,
  UPLOAD_TICKET_TTL_MS,
  UploadTicketError,
} from '../../uploads/ticket-service.js';
import {
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalUserId,
  zodToMcpSchema,
} from './lib.js';

// Single top-level object schema (NOT a discriminated union) — MCP tool
// inputSchemas MUST be `type:object`, so per-action fields are optional here
// and validated in the handler. `action=request` needs data.targetId+name;
// `action=fetch` needs data.attachmentId.
const inputSchema = z
  .object({
    action: z.enum(['request', 'fetch']),
    data: z
      .object({
        target: z.enum(['issue', 'comment', 'session']),
        // request: the file to upload
        targetId: z.uuid().optional(),
        name: z.string().trim().min(1).max(200).optional(),
        // Optional — inferred from the file extension when omitted; the ticket
        // service rejects anything outside ALLOWED_MIMES regardless.
        mime: z.string().trim().min(1).max(255).optional(),
        // fetch: the attachment to read (issue_attachments.id /
        // comment_attachments.id), as returned in any `attachments[].id` from
        // forge_issues / forge_step_start / forge_comments.
        attachmentId: z.uuid().optional(),
      })
      .strict(),
  })
  .strict();

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function mimeFromName(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

const INLINE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv']);

// cm:guard the returned URL carries its own credential — never log it, echo it into a comment, or hand it to anything that persists request URLs
async function mintDownloadTicket(
  target: 'issue' | 'comment' | 'session',
  attachmentId: string,
  projectId: string,
  principal: McpPrincipal,
): Promise<{ url: string; expiresAt: string } | null> {
  try {
    const ticket = await createDownloadTicket({
      targetType: target,
      attachmentId,
      projectId,
      issuedToUserId: principal.kind === 'pat' ? principal.userId : principal.device.ownerId,
      issuedToDeviceId: principal.kind === 'device' ? principal.device.id : null,
    });
    return {
      url: `/api/uploads/download/${ticket.id}`,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  } catch {
    return null;
  }
}

export const forgeUploadsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_uploads',
  description:
    'Upload (action=request) or READ (action=fetch) an issue/comment/session attachment.\n' +
    'action=request — mint a short-lived, single-use upload URL WITHOUT base64-inlining ' +
    'bytes through the model context (presigned-URL pattern). data={target:"issue"|"comment"|"session", ' +
    'targetId:<uuid>, name:"<filename>", mime?:"<type>"}. Returns {uploadId, method:"PUT", ' +
    'uploadUrl, uploadPath, expiresIn (~300s), maxBytes}. Upload out-of-band with NO auth ' +
    'header: `curl -X PUT -T <localPath> "<uploadUrl>"` (if uploadUrl is null, prepend your ' +
    'Forge API origin to uploadPath). The PUT returns the attachment {id,name,mime,size,url}.\n' +
    "action=fetch — read an EXISTING attachment's content so you can analyze it. " +
    'data={target:"issue"|"comment"|"session", attachmentId:<uuid from any attachments[].id>}. Images ' +
    'EVERY fetch also returns `downloadUrl` (+ `downloadExpiresAt`): a short-lived, ' +
    'self-authenticating URL you can `curl` to get the RAW BYTES onto disk, and that you can hand ' +
    'to a third-party service that must fetch the file itself (e.g. re-hosting an owner-supplied ' +
    'image into a store media library). Use it instead of `url`, which requires a Forge session ' +
    'the runner does not have. Treat it as a secret: do not log it or paste it into a comment. ' +
    '(png/jpeg/gif/webp) return as a viewable image block (you SEE the screenshot); text/markdown ' +
    'return inline as text. PDFs/video and oversized files (> inline cap) return metadata + the ' +
    'download url only (not inlined). Use this whenever an issue/comment references an attached ' +
    'image or file — the prompt does NOT inline attachment bytes.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    if (input.action === 'fetch') {
      const { target, attachmentId } = input.data;
      if (!attachmentId) {
        throw new Error('BAD_REQUEST: data.attachmentId is required for fetch');
      }
      const att = await loadAttachmentForFetch(target, attachmentId);
      await assertPrincipalIsWriter(principal, att.projectId);

      // cm:why every fetch mints one, inlinable or not — the bearer-guarded `url` 401s for a device token, a PAT and no-auth alike, so without this an agent that can SEE an attachment still has no way to obtain its bytes (or to hand a fetchable URL to a third-party service that must re-host it)
      const download = await mintDownloadTicket(target, attachmentId, att.projectId, principal);
      const meta = {
        attachmentId,
        name: att.name,
        mime: att.mime,
        size: att.size,
        url: att.url,
        downloadUrl: download?.url ?? null,
        downloadExpiresAt: download?.expiresAt ?? null,
      };

      const isImage = att.mime.startsWith('image/');
      const isText = INLINE_TEXT_MIMES.has(att.mime);

      // Decide inlinability from metadata BEFORE touching storage, so a PDF /
      // video / oversized file never costs a (potentially large) read.
      if (!isImage && !isText) {
        return {
          ...meta,
          inlined: false,
          reason: 'unsupported_inline',
          note: `mime '${att.mime}' can't be inlined for the model; download it via \`url\`.`,
        };
      }

      if (att.size > env.UPLOADS_INLINE_MAX_BYTES) {
        return {
          ...meta,
          inlined: false,
          reason: 'too_large',
          note: `Attachment is ${att.size} bytes (> inline cap ${env.UPLOADS_INLINE_MAX_BYTES}). Download it via \`url\` instead of inlining.`,
        };
      }

      const bytes = await getStorage().get(att.path);

      if (isImage) {
        // ISS-532: the filename + mime are uploaded (untrusted) content. The
        // image block carries no DATA frame of its own, so an attacker-named
        // file would otherwise inject raw instructions via the label. Frame the
        // metadata as DATA — markUntrusted sanitizes + de-tokens both fields.
        return {
          _mcpContent: [
            {
              type: 'text',
              text: markUntrusted(`Image attachment name="${att.name}" mime="${att.mime}".`, {
                source: 'attachment-metadata',
              }),
            },
            { type: 'image', data: bytes.toString('base64'), mimeType: att.mime },
          ],
          ...meta,
          inlined: true,
        };
      }

      // ISS-532: inlined attachment text is fully untrusted (uploaded content)
      // and reaches the agent verbatim — frame the file body as DATA. The
      // untrusted filename + mime are NOT echoed in a raw external label (that
      // would be an unframed injection vector); they ride INSIDE the frame via
      // the sanitized `source=` attribute. Only a constant label sits outside.
      return {
        _mcpContent: [
          {
            type: 'text',
            text: `Attachment text follows (name + type carried as data in the frame):\n\n${markUntrusted(
              bytes.toString('utf8'),
              { source: `attachment name="${att.name}" mime="${att.mime}"` },
            )}`,
          },
        ],
        ...meta,
        inlined: true,
      };
    }

    const { target, targetId, name } = input.data;
    if (!targetId || !name) {
      throw new Error('BAD_REQUEST: data.targetId and data.name are required for request');
    }

    const projectId =
      target === 'issue'
        ? await loadIssueProjectId(targetId)
        : target === 'session'
          ? await loadSessionProjectId(targetId)
          : await loadCommentProjectId(targetId);
    await assertPrincipalIsWriter(principal, projectId);

    const mime = input.data.mime ?? mimeFromName(name);

    let ticket: { id: string; expiresAt: Date; maxBytes: number };
    try {
      ticket = await createUploadTicket({
        targetType: target,
        targetId,
        uploaderId: principalUserId(principal),
        uploaderDeviceId: principal.kind === 'device' ? principal.device.id : null,
        name,
        mime,
      });
    } catch (err) {
      if (err instanceof UploadTicketError) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    }

    const uploadPath = `/api/uploads/${ticket.id}`;
    const base = env.PUBLIC_API_BASE_URL?.replace(/\/$/, '');
    return {
      uploadId: ticket.id,
      method: 'PUT' as const,
      uploadUrl: base ? `${base}${uploadPath}` : null,
      uploadPath,
      name,
      mime,
      maxBytes: ticket.maxBytes,
      expiresIn: Math.round(UPLOAD_TICKET_TTL_MS / 1000),
      expiresAt: ticket.expiresAt.toISOString(),
    };
  },
});
