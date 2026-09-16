/**
 * What a caller may send as a comment body, and what comes back when it is
 * wrong.
 *
 * Split out of `routes.ts` rather than declared there: the route was already
 * the widest coordinator in this module, and the body format is a concern the
 * comment domain owns end to end — the two request shapes, the format enum they
 * share, and the mapping from a refusal to a 400 all belong in one place.
 */

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
