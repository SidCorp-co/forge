import { z } from 'zod';
import { describeOperation, empty, fail, json, raw } from '../api-reference/declare/describe.js';
import { ISSUE_REF_REFUSALS } from './search-reference.js';

export const issueAttachmentSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  uploaderId: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: z.date(),
  url: z.string(),
});

export const issueAttachmentListSchema = z.array(issueAttachmentSchema);

const UPLOAD_REFUSALS = {
  BAD_REQUEST:
    'the `file` field is missing, or the file is empty or its name is empty once cleaned',
  FILE_TOO_LARGE: 'the file is over the upload limit',
  MIME_NOT_ALLOWED: "the file's type is not one an attachment may have",
  ATTACHMENT_NAME_TAKEN: 'the issue already has an attachment with this name',
};

export const uploadIssueAttachment = describeOperation({
  summary: 'Attach a file to an issue',
  description: 'Send the file in the `file` field of a multipart form.',
  body: {
    contentType: 'multipart/form-data',
    description: 'a `file` field holding the file',
    filePart: 'file',
  },
  responses: {
    201: json(issueAttachmentSchema),
    400: fail(UPLOAD_REFUSALS),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue does not exist'),
  },
});

export const listIssueAttachments = describeOperation({
  summary: "List an issue's attachments, oldest first, without their bytes",
  responses: {
    200: json(issueAttachmentListSchema),
    ...ISSUE_REF_REFUSALS,
  },
});

export const downloadIssueAttachment = describeOperation({
  summary: 'Download an attachment',
  responses: {
    200: raw('application/octet-stream', 'the file, under the type it was stored with'),
    403: fail('FORBIDDEN', "the caller is not a member of the issue's project"),
    404: fail('NOT_FOUND', 'the attachment does not exist'),
    410: fail(
      'ATTACHMENT_FILE_MISSING',
      'the attachment is recorded but its file is gone from storage',
    ),
  },
});

export const deleteIssueAttachment = describeOperation({
  summary: 'Delete an attachment',
  responses: {
    204: empty(),
    403: fail('FORBIDDEN', 'the caller is neither the uploader nor a project admin'),
    404: fail('NOT_FOUND', 'the attachment does not exist'),
  },
});
