import { z } from 'zod';
import { env } from '../config/env.js';
import { getStorage } from '../integrations/index.js';
import { type ContextScopedMcpToolFactory, zodToMcpSchema } from '../lib/tool.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { loadAttachment } from './attachment-lookup.js';
import { createDownloadTicket } from './download-ticket-service.js';

const inputSchema = z
  .object({
    action: z.literal('fetch').default('fetch'),
    data: z
      .object({
        target: z.enum(['issue', 'comment', 'session']),
        attachmentId: z.uuid(),
      })
      .strict(),
  })
  .strict();

const INLINE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv']);

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
      issuedToUserId: principal.userId,
      issuedToDeviceId: null,
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
  reach: 'project',
  route: '/api/issues',
  grant: 'issues:read',
  description:
    'READ an issue, comment or session attachment so you can analyze it: the one Forge read no shell ' +
    'command can do, because an image comes back as a viewable image block. Uploading is ' +
    '`POST /api/issues/:id/attachments` (multipart) or `forge attach`. ' +
    'data={target:"issue"|"comment"|"session", attachmentId:<uuid from any attachments[].id>}. ' +
    'Images (png/jpeg/gif/webp) return as a viewable image block; the structured answer carries no bytes, ' +
    'so it says `inlined: false` with `reason: image_block_in_content` and names the block as ' +
    '`image: { contentIndex, mimeType }`. Text/markdown return inline, framed as data, with `inlined: true`. ' +
    'PDFs/video and oversized files (> inline cap) return metadata only. EVERY fetch also returns ' +
    '`downloadUrl` (+ `downloadExpiresAt`): a short-lived, self-authenticating URL to `curl` the raw bytes ' +
    'onto disk or hand to a service that must fetch the file itself. Treat it as a secret: do not log it ' +
    'or paste it into a comment.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    const { target, attachmentId } = input.data;
    const att = await loadAttachment(target, attachmentId);
    if (!att) throw new Error('NOT_FOUND: attachment not found');
    await requireCan(actorFor(principal.userId), 'project.write', projectResource(att.projectId));

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
        inlined: false,
        reason: 'image_block_in_content',
        image: { contentIndex: 1, mimeType: att.mime },
        note: 'The image is content block 1, which this structured answer does not repeat; read that block, or download it via `downloadUrl`.',
      };
    }

    // ISS-532: inlined attachment text is fully untrusted (uploaded content)
    // and reaches the agent verbatim — frame the file body as DATA. The
    // untrusted filename + mime are NOT echoed in a raw external label (that
    // would be an unframed injection vector); they ride INSIDE the frame via
    // the sanitized `source=` attribute. Only a constant label sits outside.
    const text = markUntrusted(bytes.toString('utf8'), {
      source: `attachment name="${att.name}" mime="${att.mime}"`,
    });
    return {
      _mcpContent: [
        {
          type: 'text',
          text: `Attachment text follows (name + type carried as data in the frame):\n\n${text}`,
        },
      ],
      ...meta,
      inlined: true,
      text,
    };
  },
});
