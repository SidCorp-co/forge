import { decisionFieldsSchema } from '@forge/contracts/comments';
import { writtenLangSchema } from '@forge/contracts/written-lang';
import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyRefusalHttp, rethrowBodyInvalid } from '../body/http-error.js';

export const COMMENT_BODY_MAX_CHARS = 64_000;

const BLANK_BODY =
  'the comment body is whitespace only — write the sentence somebody is meant to read';

/** Stored as written: leading whitespace decides what markdown draws, so this door decides none of it. */
const commentBodyField = z
  .string()
  .max(COMMENT_BODY_MAX_CHARS)
  .refine((body) => body.trim().length > 0, { message: BLANK_BODY });

const formatField = z.enum(BODY_FORMATS).optional();

/**
 * Any string: the closed set is checked by `comments/service.ts:resolveIntent`, so a wrong intent is
 * refused by name (COMMENT_INTENT_UNKNOWN) with the valid set rather than as a generic shape error.
 */
const intentField = z.string().max(64).optional();

/** An issue comment: a body, or for a decision its fields, from which the body is written. */
export const commentCreateSchema = z
  .object({
    body: commentBodyField.optional(),
    format: formatField,
    parentId: z.uuid().optional(),
    intent: intentField,
    decision: decisionFieldsSchema.optional(),
    writtenLang: writtenLangSchema.optional(),
  })
  .strict();

export const commentBodySchema = z
  .object({
    body: commentBodyField,
    format: formatField,
    writtenLang: writtenLangSchema.optional(),
  })
  .strict();

export { bodyRefusalHttp, rethrowBodyInvalid };
