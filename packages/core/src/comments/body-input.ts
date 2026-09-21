import { z } from 'zod';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyRefusalHttp, prepareBodyOrThrow, rethrowBodyInvalid } from '../body/http-error.js';

export const COMMENT_BODY_MAX_CHARS = 64_000;

export const commentBodyField = z.string().trim().min(1).max(COMMENT_BODY_MAX_CHARS);
const formatField = z.enum(BODY_FORMATS).optional();

export const commentCreateSchema = z
  .object({ body: commentBodyField, format: formatField, parentId: z.uuid().optional() })
  .strict();

export const commentBodySchema = z.object({ body: commentBodyField, format: formatField }).strict();

export { bodyRefusalHttp, prepareBodyOrThrow as prepareCommentBody, rethrowBodyInvalid };
