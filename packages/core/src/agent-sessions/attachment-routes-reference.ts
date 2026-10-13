import { z } from 'zod';
import { describeOperation, fail, json, raw } from '../api-reference/describe.js';

export const sessionIdParamSchema = z.object({ sessionId: z.uuid() });
export const downloadParamSchema = z.object({ sessionId: z.uuid(), id: z.uuid() });

export const attachmentSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: z.date(),
  url: z.string(),
});

const noSession = fail('NOT_FOUND', 'no such agent session');

export const uploadAttachment = describeOperation({
  summary: 'Attach a file to a chat session, to ride on a later turn',
  description:
    'Send the file in the multipart field `file`. A device cannot upload; it downloads the files of a turn dispatched to it.',
  body: { contentType: 'multipart/form-data', description: 'one field, `file`' },
  responses: {
    201: json(attachmentSchema, 'The stored attachment'),
    400: fail({
      FILE_TOO_LARGE: 'the file is over the upload limit',
      MIME_NOT_ALLOWED: 'the file type is not allowed on a session',
      BAD_REQUEST: 'the `file` field is missing or empty, or its name is too long',
    }),
    403: fail('FORBIDDEN', 'the caller is below the project member role, or is a device'),
    404: noSession,
  },
});

export const downloadAttachment = describeOperation({
  summary: 'Download a session attachment',
  responses: {
    200: raw('application/octet-stream', 'The file, sent as an inert attachment'),
    403: fail(
      'FORBIDDEN',
      'the caller is below the project member role, or a device the session is not on',
    ),
    404: fail('NOT_FOUND', 'no such session or attachment'),
    410: fail('ATTACHMENT_FILE_MISSING', 'the file is no longer in storage'),
  },
});
