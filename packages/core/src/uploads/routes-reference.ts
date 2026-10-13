import { z } from 'zod';
import { describeOperation, fail, json, raw } from '../api-reference/describe.js';

/** The attachment as the target type stores it; the ticket decides which of the four it is. */
export const uploadedAttachmentSchema = z.union([
  z.object({
    id: z.string(),
    issueId: z.string(),
    uploaderId: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    createdAt: z.date(),
    url: z.string(),
  }),
  z.object({
    id: z.string(),
    commentId: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    createdAt: z.date(),
    url: z.string(),
  }),
  z.object({
    id: z.string(),
    sessionId: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    createdAt: z.date(),
    url: z.string(),
  }),
  z.object({
    id: z.string(),
    conversationId: z.string(),
    name: z.string(),
    mime: z.string(),
    size: z.number().int(),
    createdAt: z.date(),
    url: z.string(),
  }),
]);

export type UploadedAttachment = z.input<typeof uploadedAttachmentSchema>;

export const uploadAttachment = describeOperation({
  summary: 'Send the bytes of a file to a single-use upload ticket',
  description:
    'No sign-in: the unguessable, short-lived ticket in the path is the credential, and it fixes the target, the file name and the type, so the request carries only the bytes. A ticket that fails here is released again, so the same URL can be tried once more.',
  body: { contentType: 'application/octet-stream', description: 'The file, as raw bytes' },
  responses: {
    201: json(uploadedAttachmentSchema, 'The attachment, as its target type stores it'),
    400: fail({
      FILE_TOO_LARGE: 'the file is over the upload limit',
      EMPTY_FILE: 'the body has no bytes',
      MIME_NOT_ALLOWED: 'the target type does not take this kind of file',
      INVALID_NAME: 'the name stored on the ticket is not usable',
      ATTACHMENT_NAME_TAKEN: 'the target already holds an attachment with this name',
    }),
    404: fail(
      'UPLOAD_TICKET_INVALID',
      'the ticket does not exist, has expired, or was already used',
    ),
  },
});

export const downloadAttachment = describeOperation({
  summary: 'Download an attachment with a single-use download ticket',
  description: 'No sign-in: the ticket is the credential.',
  responses: {
    200: raw('application/octet-stream', 'The file, with the content type it was stored under'),
    404: fail({
      DOWNLOAD_TICKET_INVALID: 'the ticket does not exist or has expired',
      NOT_FOUND: 'the attachment the ticket names is gone',
    }),
  },
});
