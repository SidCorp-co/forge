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

// cm:why one number for EVERY comment body, not a tier per record kind: a typed record (`format:'html'`, root `<forge-*>`) carries one block per acceptance criterion, and a 34-criterion verdict measures ~48,000 chars. A cap that differs by kind cannot be written as the single `maxLength` a client reads out of the tool schema, and a client that must know its tier before it can refuse cannot refuse before it uploads evidence it cannot take back (ISS-958).
// cm:edge contract -> packages/core/src/mcp/tools/forge-comments.ts — this constant is what `z.toJSONSchema` publishes as `data.body.maxLength`, and that number IS the client-side contract (forge-plugin ISS-456 reads it). Restate the literal at the MCP door instead of importing this and the two drift, which is the state ISS-958 found them in.
export const COMMENT_BODY_MAX_CHARS = 64_000;

// cm:guard the shared field, not a copy — every door that takes a comment body imports THIS, so the cap a client reads off the tool schema and the cap the REST routes enforce cannot become two numbers
export const commentBodyField = z.string().trim().min(1).max(COMMENT_BODY_MAX_CHARS);
// cm:edge contract -> packages/core/src/body/prepare.ts — `format` is OPTIONAL and absent means `markdown`, so every client that has never heard of it keeps working byte-for-byte. `html` opts into the allowlisted `<forge-*>` validator, which refuses a bad body with 400 BODY_INVALID naming the element, attribute or missing slot.
const formatField = z.enum(BODY_FORMATS).optional();

export const commentCreateSchema = z
  .object({ body: commentBodyField, format: formatField, parentId: z.uuid().optional() })
  .strict();

export const commentBodySchema = z.object({ body: commentBodyField, format: formatField }).strict();

// cm:guard the comment domain reaches `body/` THROUGH this file and nowhere else. `routes.ts` imported `bodyRefusalHttp` directly for one line and the archmap fan-out gate refused it — this module already exists to be "the mapping from a refusal to a 400, in one place", so the re-export is where that line belongs rather than a widened budget.
export { bodyRefusalHttp, prepareBodyOrThrow as prepareCommentBody, rethrowBodyInvalid };
