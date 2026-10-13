import { z } from 'zod';
import { describeOperation, fail, json, raw } from '../api-reference/declare/describe.js';

export const commentAttachmentSchema = z.object({
  id: z.string(),
  commentId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: z.date(),
  url: z.string(),
});

export const uploadCommentAttachment = describeOperation({
  summary: 'Attach a file to a comment',
  description: 'Send the file in the `file` field of a multipart form.',
  body: {
    contentType: 'multipart/form-data',
    description: 'a `file` field holding the file',
    filePart: 'file',
  },
  responses: {
    201: json(commentAttachmentSchema),
    400: fail({
      BAD_REQUEST:
        'the `file` field is missing, or the file is empty or its name is empty once cleaned',
      FILE_TOO_LARGE: 'the file is over the upload limit',
      MIME_NOT_ALLOWED: "the file's type is not one an attachment may have",
      ATTACHMENT_NAME_TAKEN: 'the comment already has an attachment with this name',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the comment does not exist'),
  },
});

export const downloadCommentAttachment = describeOperation({
  summary: 'Download a comment attachment',
  responses: {
    200: raw('application/octet-stream', 'the file, under the type it was stored with'),
    403: fail('FORBIDDEN', "the caller is not a member of the comment's project"),
    404: fail('NOT_FOUND', 'the attachment does not exist'),
    410: fail(
      'ATTACHMENT_FILE_MISSING',
      'the attachment is recorded but its file is gone from storage',
    ),
  },
});
