import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  agentSessions,
  commentAttachments,
  comments,
  issueAttachments,
  issues,
  sessionAttachments,
} from '../../db/schema.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import { getStorage } from '../../storage/index.js';
import {
  UPLOAD_TICKET_TTL_MS,
  UploadTicketError,
  createUploadTicket,
} from '../../uploads/ticket-service.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  principalUserId,
  zodToMcpSchema,
  assertPrincipalIsWriter,
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

async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

async function loadCommentProjectId(commentId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: comment not found');
  return row.projectId;
}

async function loadSessionProjectId(sessionId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: agentSessions.projectId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: session not found');
  return row.projectId;
}

interface AttachmentForFetch {
  name: string;
  mime: string;
  size: number;
  path: string;
  projectId: string;
  url: string;
}

async function loadAttachmentForFetch(
  target: 'issue' | 'comment' | 'session',
  attachmentId: string,
): Promise<AttachmentForFetch> {
  if (target === 'session') {
    const [row] = await db
      .select({
        name: sessionAttachments.name,
        mime: sessionAttachments.mime,
        size: sessionAttachments.size,
        path: sessionAttachments.path,
        sessionId: sessionAttachments.sessionId,
        projectId: agentSessions.projectId,
      })
      .from(sessionAttachments)
      .innerJoin(agentSessions, eq(agentSessions.id, sessionAttachments.sessionId))
      .where(eq(sessionAttachments.id, attachmentId))
      .limit(1);
    if (!row) throw new Error('NOT_FOUND: attachment not found');
    const { sessionId, ...rest } = row;
    return {
      ...rest,
      url: `/api/agent-sessions/${sessionId}/attachments/${attachmentId}/download`,
    };
  }
  if (target === 'issue') {
    const [row] = await db
      .select({
        name: issueAttachments.name,
        mime: issueAttachments.mime,
        size: issueAttachments.size,
        path: issueAttachments.path,
        projectId: issues.projectId,
      })
      .from(issueAttachments)
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(eq(issueAttachments.id, attachmentId))
      .limit(1);
    if (!row) throw new Error('NOT_FOUND: attachment not found');
    return { ...row, url: `/api/attachments/${attachmentId}/download` };
  }
  const [row] = await db
    .select({
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      size: commentAttachments.size,
      path: commentAttachments.path,
      projectId: issues.projectId,
    })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(commentAttachments.id, attachmentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: attachment not found');
  return { ...row, url: `/api/comments/attachments/${attachmentId}` };
}

const INLINE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv']);

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

      const meta = {
        attachmentId,
        name: att.name,
        mime: att.mime,
        size: att.size,
        url: att.url,
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
