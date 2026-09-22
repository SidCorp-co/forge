import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyRefusalHttp, prepareBodyOrThrow, rethrowBodyInvalid } from '../body/http-error.js';

export const COMMENT_BODY_MAX_CHARS = 64_000;

const BLANK_BODY =
  'the comment body is whitespace only — write the sentence somebody is meant to read';

/**
 * A comment body is stored as it was written. Leading whitespace is markdown and belongs to the
 * author: four spaces open an indented code block and one to three open a fence, so stripping it
 * hands every reader below a body nobody typed. A body holding nothing but whitespace is refused
 * by name rather than rewritten into one that fails a length nobody can see.
 */
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
