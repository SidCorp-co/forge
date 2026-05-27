import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { comments, issues } from '../../db/schema.js';
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
} from './lib.js';

const inputSchema = z
  .object({
    action: z.literal('request'),
    data: z
      .object({
        target: z.enum(['issue', 'comment']),
        targetId: z.uuid(),
        name: z.string().trim().min(1).max(200),
        // Optional — inferred from the file extension when omitted; the ticket
        // service rejects anything outside ALLOWED_MIMES regardless.
        mime: z.string().trim().min(1).max(255).optional(),
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

export const forgeUploadsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_uploads',
  description:
    'Mint a short-lived, single-use upload URL for attaching a local file to an ' +
    'issue or comment WITHOUT base64-inlining bytes through the model context ' +
    '(presigned-URL pattern). action=request, data={target:"issue"|"comment", ' +
    'targetId:<uuid>, name:"<filename>", mime?:"<type>"}. Returns {uploadId, ' +
    'method:"PUT", uploadUrl, uploadPath, expiresIn (~300s), maxBytes}. Then upload ' +
    'the bytes out-of-band with NO auth header: `curl -X PUT -T <localPath> ' +
    '"<uploadUrl>"` (if uploadUrl is null, prepend your Forge API origin to ' +
    'uploadPath). The PUT returns the attachment {id, name, mime, size, url}; ' +
    'reference that url in the issue/comment body. The capability is bound to the ' +
    'target, your identity, name and mime server-side and is single-use — re-request ' +
    'for each file. Allowed mimes match the issue/comment attachment limits.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;
    const { target, targetId, name } = input.data;

    const projectId =
      target === 'issue'
        ? await loadIssueProjectId(targetId)
        : await loadCommentProjectId(targetId);
    await assertPrincipalIsMember(principal, projectId);

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
