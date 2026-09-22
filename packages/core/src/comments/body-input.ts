import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyRefusalHttp, prepareBodyOrThrow, rethrowBodyInvalid } from '../body/http-error.js';

export const COMMENT_BODY_MAX_CHARS = 64_000;

const BLANK_BODY =
  'the comment body is whitespace only — write the sentence somebody is meant to read';

/** Stored as written: leading whitespace decides what markdown draws, so this door decides none of it. */
export const commentBodyField = z
  .string()
  .max(COMMENT_BODY_MAX_CHARS)
  .refine((body) => body.trim().length > 0, { message: BLANK_BODY });

const formatField = z.enum(BODY_FORMATS).optional();

export const commentCreateSchema = z
  .object({ body: commentBodyField, format: formatField, parentId: z.uuid().optional() })
  .strict();

export const commentBodySchema = z.object({ body: commentBodyField, format: formatField }).strict();

export { bodyRefusalHttp, prepareBodyOrThrow as prepareCommentBody, rethrowBodyInvalid };
