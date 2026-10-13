import { z } from 'zod';
import { describeOperation, fail, json } from '../../api-reference/declare/describe.js';

const attributeSchema = z.object({
  key: z.string(),
  label: z.string(),
  valueType: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  ref: z.string().nullable(),
  sourceCommentId: z.string().nullable(),
  assertedAt: z.string(),
});

export const attributesWrittenSchema = z.object({
  written: z.number(),
  attributes: z.array(attributeSchema),
});

export const attributesSchema = z.object({ attributes: z.array(attributeSchema) });

export const writeAttributes = describeOperation({
  summary:
    'Assert typed attributes on an issue, each optionally pointing at the comment that made it',
  description:
    'All or none are written. `attributes` in the answer is every attribute the issue now holds.',
  responses: {
    201: json(attributesWrittenSchema),
    400: fail({
      UNREGISTERED_KEY: 'a key is not in the attribute registry',
      WRONG_TYPE: 'a value is not of the type its key holds',
      OBLIGATION_UNOWNED: 'an obligation was asserted with no owner',
      EMPTY_TEXT: 'a text value is empty',
      SOURCE_COMMENT_NOT_FOUND: '`sourceCommentId` names no comment',
      SOURCE_COMMENT_OFF_ISSUE: '`sourceCommentId` names a comment on another issue',
    }),
    403: fail('FORBIDDEN', 'the caller is not a project member with write access'),
    404: fail('NOT_FOUND', 'the issue does not exist'),
    409: fail('ATTRIBUTE_DEF_MISSING', "the registry's two lists disagree about a key"),
  },
});

export const readAttributes = describeOperation({
  summary: "List an issue's attributes, oldest first",
  responses: {
    200: json(attributesSchema),
    403: fail('FORBIDDEN', "the caller is not a member of the issue's project"),
    404: fail('NOT_FOUND', 'the issue does not exist'),
  },
});
