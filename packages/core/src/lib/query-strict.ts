/**
 * The refusal a strict query schema owes its caller.
 *
 * ISS-991 — `GET /api/projects/:id/issues?key=ISS-376` answered 200 with the
 * project's whole issue list, and the caller worked `items[0]`: four contract
 * records and four status transitions landed on a different issue. An unknown
 * filter that returns an unfiltered page is the worst of the three shapes
 * available; a 400 is the only one a caller can act on.
 *
 * `.strict()` alone gets the 400. What it does not get is the second half of
 * the same round trip: zod names the key it rejected and says nothing about
 * what the route would have taken, so a caller who guessed wrong guesses again.
 */

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

function unrecognizedKeys(error: z.core.$ZodError<unknown>): string[] {
  const keys = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) keys.add(key);
  }
  return [...keys];
}

/**
 * The 400 for a query that failed `schema`, naming any unregistered parameter
 * and listing what the route does take.
 *
 * A query carrying both faults — an unknown parameter and a bad value for a
 * known one — reports both, because zod collects them in one pass and a caller
 * sent back to find the second on a second round is the round this exists to
 * save.
 */
// cm:guard the accepted list is read off `schema.shape` at refusal time and NEVER from a literal beside the route. A hand-kept copy drifts silently in the one direction that matters — a route grows a parameter, the refusal goes on omitting it, and the caller reads the omission as "this route does not filter on that" (ISS-991).
// cm:edge contract -> packages/core/src/issues/routes.ts — `UNKNOWN_QUERY_PARAMETER` is the code a caller branches on to tell "a parameter I do not have" from "a value I cannot parse"; the two are one `BAD_REQUEST` everywhere else and a caller cannot separate them
// cm:why the error type is zod's CORE `$ZodError` and not `z.ZodError`: `zValidator`'s failure hook hands over the core shape, and the classic wrapper's extra members (`flatten`, `addIssue`) make the two unassignable under `exactOptionalPropertyTypes`
export function queryBadRequest<T>(
  schema: z.ZodObject<z.ZodRawShape>,
  error: z.core.$ZodError<T>,
): HTTPException {
  const unknown = unrecognizedKeys(error);
  const details = z.flattenError(error);
  if (unknown.length === 0) {
    return new HTTPException(400, {
      message: 'Invalid input',
      cause: { code: 'BAD_REQUEST', details },
    });
  }
  const accepted = Object.keys(schema.shape).sort();
  const named = unknown.map((key) => `\`${key}\``).join(', ');
  return new HTTPException(400, {
    message:
      `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${named}. ` +
      `This route takes: ${accepted.join(', ')}.`,
    cause: {
      code: 'UNKNOWN_QUERY_PARAMETER',
      details: { unknownParameters: unknown, accepted, ...details },
    },
  });
}
