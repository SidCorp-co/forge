import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import { z } from 'zod';
import { principalAgency } from '../issues/index.js';
import { egressBytesAs } from '../lib/data-egress.js';
import { env } from '../lib/env.js';
import {
  type ContextScopedMcpToolFactory,
  refusedAnswer,
  sourceOf,
  zodToMcpSchema,
} from '../lib/tool.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import type { McpPrincipal } from '../middleware/require-pat.js';
import { notFound } from '../middleware/route-errors.js';
import { onResolved, requireDeclaredOn } from '../permissions/index.js';
import { loadAttachment, readAttachmentBytes } from './attachment-lookup.js';
import { createDownloadTicket } from './download-ticket-service.js';

const inputSchema = z
  .object({
    action: z.literal('fetch').default('fetch'),
    data: z
      .object({
        target: z.enum(['issue', 'comment', 'session', 'feedback']),
        attachmentId: z.uuid(),
      })
      .strict(),
  })
  .strict();

const INLINE_TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv']);

async function mintDownloadTicket(
  target: 'issue' | 'comment' | 'session' | 'feedback',
  attachmentId: string,
  projectId: string,
  principal: McpPrincipal,
): Promise<{ url: string; expiresAt: string }> {
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
}

/** When an agent reaches for an attachment's content (ISS-1251), from how runs, masters and clients used it. */
const CARDS = {
  fetch: {
    purpose:
      'Reads an attachment of an issue, comment, session or feedback item: an image as a viewable block, text inline.',
    situations: [
      {
        when: 'an issue or comment you work carries a screenshot, mockup or log file that bears on the task',
        do: 'fetch it with its target and attachmentId from attachments[].id, and read the content, not its name',
      },
      {
        when: 'a feedback item you triage or answer carries a file',
        do: 'fetch it with target feedback and the id project_feedback.get lists for it',
        watch:
          'a project that keeps reporter data from models refuses it ATTACHMENT_REFUSED; say so, never guess the content',
      },
      {
        when: 'the file is a PDF or video, or larger than can be inlined',
        do: 'fetch answers inlined false with its reason; download the bytes from downloadUrl onto disk and open that file',
      },
    ],
    practice: [
      'An image is a content block the structured answer does not repeat; read the block image.contentIndex names.',
      'downloadUrl is a short-lived credential: never log it or paste it into a comment.',
    ],
    example: { data: { target: 'issue', attachmentId: '<attachment uuid>' } },
    // ISS-602 (release judge K7 on dev.266): forge_uploads was sent a projectId, which its input does
    // not take; the attachment names its own project
    redFlag:
      'Sending projectId or the target at the top level: fetch takes only data { target, attachmentId }, and the attachment names its project.',
    family: 'issue-work',
    audience: ['run', 'master', 'person'],
    scenarios: ['forge_uploads sent a projectId: ISS-602'],
  },
} satisfies Record<'fetch', CapabilityCardBody>;

export const forgeUploadsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_uploads',
  cards: CARDS,
  source: sourceOf(import.meta.url),
  reach: 'project',
  route: '/api/issues',
  grant: 'issues:read',
  description:
    'fetch { data: { target: issue | comment | session | feedback, attachmentId } }: ' +
    'READ an issue, comment, session or feedback-item attachment so you can analyze it: the one Forge read no shell ' +
    'command can do, because an image comes back as a viewable image block. Uploading is ' +
    '`POST /api/issues/:id/attachments` (multipart) or `forge attach`. ' +
    'data={target:"issue"|"comment"|"session"|"feedback", attachmentId:<uuid from any attachments[].id>}; ' +
    'a feedback item lists its attachments in project_feedback get, and one is attached with project_feedback attach. ' +
    'Images (png/jpeg/gif/webp) return as a viewable image block; the structured answer carries no bytes, ' +
    'so it says `inlined: false` with `reason: image_block_in_content` and names the block as ' +
    '`image: { contentIndex, mimeType }`. Text/markdown return inline, framed as data, with `inlined: true`. ' +
    'PDFs/video and oversized files (> inline cap) return metadata only. EVERY fetch also returns ' +
    '`downloadUrl` (+ `downloadExpiresAt`): a short-lived, self-authenticating URL to `curl` the raw bytes ' +
    'onto disk or hand to a service that must fetch the file itself. Treat it as a secret: do not log it ' +
    'or paste it into a comment.',
  inputSchema: zodToMcpSchema(inputSchema),
  // the attachment names its project, which the handler finds before it checks
  permission: onResolved('project.read', "the attachment's project, found from the attachment"),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    const { target, attachmentId } = input.data;
    const att = await loadAttachment(target, attachmentId);
    if (!att) throw notFound(`attachment ${attachmentId} not found on that ${target}`);
    await requireDeclaredOn(att.projectId, principal.userId, 'project.read');
    if (target === 'feedback') {
      // a feedback file is reporter data: a model reads it on a project that redacts only where a
      // person redacted it, and never at no_egress (REQ-66 BC-7), as the item's own route answers
      const gate = await egressBytesAs(
        { agency: principalAgency(principal) },
        att.projectId,
        'feedback.attachments',
        att.redacted === true,
        `attachment ${attachmentId}`,
      );
      if (!gate.ok) return refusedAnswer([gate.refusal], 'ATTACHMENT_REFUSED');
    }

    const download = await mintDownloadTicket(target, attachmentId, att.projectId, principal);
    const meta = {
      attachmentId,
      name: att.name,
      mime: att.mime,
      size: att.size,
      url: att.url,
      downloadUrl: download.url,
      downloadExpiresAt: download.expiresAt,
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
        note: `Attachment is ${att.size} bytes (> inline cap ${env.UPLOADS_INLINE_MAX_BYTES}). Download it via \`downloadUrl\` instead of inlining.`,
      };
    }

    const bytes = await readAttachmentBytes(att);

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
