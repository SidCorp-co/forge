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
import { prepareBodyOrThrow, rethrowBodyInvalid } from '../body/http-error.js';

// cm:edge contract -> packages/core/src/body/prepare.ts — `format` is OPTIONAL and absent means `markdown`, so every client that has never heard of it keeps working byte-for-byte. `html` opts into the allowlisted `<forge-*>` validator, which refuses a bad body with 400 BODY_INVALID naming the element, attribute or missing slot.
const bodyField = z.string().trim().min(1).max(10_000);
const formatField = z.enum(BODY_FORMATS).optional();

export const commentCreateSchema = z
  .object({ body: bodyField, format: formatField, parentId: z.uuid().optional() })
  .strict();

export const commentBodySchema = z.object({ body: bodyField, format: formatField }).strict();

export { prepareBodyOrThrow as prepareCommentBody, rethrowBodyInvalid };
