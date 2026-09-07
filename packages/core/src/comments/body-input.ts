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

/**
 * One number for every comment body, because a client has to be able to refuse
 * locally before it uploads evidence it cannot take back (ISS-958).
 *
 * A typed record — `format:'html'` with a root `<forge-*>` component — carries one
 * block per acceptance criterion, and a 34-criterion verdict measures ~48,000
 * characters. Under the old 10,000 the client split one record across five
 * comments, and the refusal arrived after the evidence uploads. This is NOT
 * tiered by record kind: a cap that differs per kind cannot be written as the one
 * `maxLength` a client reads out of the tool schema, and a client that has to know
 * its tier first cannot refuse before sending.
 */
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

export { prepareBodyOrThrow as prepareCommentBody, rethrowBodyInvalid };
