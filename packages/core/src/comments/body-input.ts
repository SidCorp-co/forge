import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyRefusalHttp, prepareBodyOrThrow, rethrowBodyInvalid } from '../body/http-error.js';

export const COMMENT_BODY_MAX_CHARS = 64_000;

const BLANK_BODY =
  'the comment body is whitespace only — write the sentence somebody is meant to read';

/**
 * A comment body is stored as it was written. Leading whitespace belongs to the author and decides
 * what markdown draws — four spaces make an indented code block of a line markdown would otherwise
 * read as a fence — so stripping it hands every reader below a body nobody typed. Which of those
 * the record reader takes is its own rule and not this door's: it opens a record at the left margin
 * and nowhere else. A body holding nothing but whitespace is refused by name rather than rewritten
 * into one that fails a length nobody can see.
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
