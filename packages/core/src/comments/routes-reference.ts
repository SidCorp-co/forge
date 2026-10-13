import { z } from 'zod';
import { describeOperation, empty, fail, json } from '../api-reference/describe.js';
import { tableRow } from '../api-reference/rows.js';
import { bodyNodeSchema } from '../body/routes-reference.js';
import { comments } from '../db/schema.js';
import { resolvedActorSchema } from '../issues/activity-routes-reference.js';
import { ISSUE_REF_REFUSALS } from '../issues/search-reference.js';
import { paginationSchema } from '../lib/pagination.js';

export const commentRowSchema = tableRow(comments);

/** The file a comment carries, as a thread lists it. */
export const commentAttachmentLiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
  createdAt: z.date(),
});

const recordSchema = z.object({
  kind: z.string().nullable(),
  contract: z.number().nullable(),
  fields: z.array(z.object({ key: z.string(), value: z.string(), over: z.number() })).readonly(),
  lead: z.string().nullable(),
  absent: z.array(z.string()).readonly(),
  at: z.number(),
  to: z.number(),
  lens: z.enum(['product', 'technical']),
});

/** A comment in a thread: its row, the files on it, its body as nodes, its record and its replies. */
export const commentNodeSchema = commentRowSchema
  .extend({
    attachments: z.array(commentAttachmentLiteSchema),
    nodes: z.array(bodyNodeSchema).nullable(),
    record: recordSchema.nullable(),
    author: resolvedActorSchema.nullable().optional(),
    get replies() {
      return z.array(commentNodeSchema);
    },
  })
  .meta({ id: 'CommentNode' });

export const commentThreadSchema = z.object({
  items: z.array(commentNodeSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export const commentRepliesSchema = z.object({
  items: z.array(commentRowSchema),
  returned: z.number(),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});

/** A comment as written: its row, and what the screens said about the body. */
export const writtenCommentSchema = commentRowSchema.extend({
  warnings: z.array(z.string()).optional(),
});

export const threadQuerySchema = paginationSchema.extend({
  cursor: z.string().min(1).optional(),
  projectId: z.uuid().optional(),
});

const BODY_REFUSALS = {
  BODY_INVALID: 'the HTML body is empty once markup outside the allowlist is removed',
  MESSAGE_REFUSED: 'the message screen refused the body; details names the door and the refusals',
};

export const createComment = describeOperation({
  summary: 'Comment on an issue, or reply to a comment of it',
  description:
    'A thread is at most three deep. `warnings` says what the body screens removed or flagged.',
  responses: {
    201: json(writtenCommentSchema),
    400: fail({
      ...BODY_REFUSALS,
      PARENT_MISMATCH: '`parentId` names a comment of another issue',
      DEPTH_EXCEEDED: 'the reply would make the thread more than three deep',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue or the parent comment does not exist'),
  },
});

export const listComments = describeOperation({
  summary: "Read an issue's comment thread, a page of root comments at a time",
  description:
    'Each page carries its roots with every reply under them. A display id such as ISS-42 needs `?projectId=`. Send `nextCursor` back as `cursor` to continue.',
  responses: {
    200: json(commentThreadSchema),
    ...ISSUE_REF_REFUSALS,
    400: fail(
      'BAD_REQUEST',
      'the id is neither a uuid nor a display key, a display key came without `projectId`, or `cursor` is not one this route issued',
    ),
  },
});

export const listReplies = describeOperation({
  summary: 'List the direct replies to a comment, oldest first',
  responses: {
    200: json(commentRepliesSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the comment's project"),
    404: fail('NOT_FOUND', 'the comment does not exist'),
  },
});

export const patchComment = describeOperation({
  summary: 'Replace the body of a comment',
  responses: {
    200: json(writtenCommentSchema),
    400: fail(BODY_REFUSALS),
    403: fail(
      'FORBIDDEN',
      'the caller may not change this comment: not its author or a project admin, or not a writer',
    ),
    404: fail('NOT_FOUND', 'the comment does not exist'),
  },
});

export const deleteComment = describeOperation({
  summary: 'Delete a comment',
  responses: {
    204: empty(),
    403: fail(
      'FORBIDDEN',
      'the caller may not change this comment: not its author or a project admin, or not a writer',
    ),
    404: fail('NOT_FOUND', 'the comment does not exist'),
  },
});
