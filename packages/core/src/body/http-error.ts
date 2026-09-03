/**
 * The one place a refused body becomes a 400.
 *
 * Both REST routes that accept a body (comment create/patch, issue
 * create/patch) need the same mapping, and the message is the deliverable:
 * `BodyInvalidError` already names the element, the attribute and its legal
 * set, so this hands that string through rather than replacing it with the
 * generic `Invalid input` the zod validators return.
 */

import { HTTPException } from 'hono/http-exception';
import { BodyInvalidError } from './errors.js';
import { type PreparedBody, type PrepareInput, prepareBody } from './prepare.js';

// cm:guard the 400 carries `err.message` VERBATIM. It names the offender, and that is the entire reason this gate produces compliance where a guide produced 14-28% — a caller told only "invalid body" has nothing to correct.
export function bodyInvalidHttp(err: BodyInvalidError): HTTPException {
  return new HTTPException(400, {
    message: err.message,
    cause: { code: err.code, details: err.details },
  });
}

/** Re-throw a body refusal as a 400; anything else passes through untouched. */
export function rethrowBodyInvalid(err: unknown): never {
  if (err instanceof BodyInvalidError) throw bodyInvalidHttp(err);
  throw err;
}

export function prepareBodyOrThrow(input: PrepareInput): PreparedBody {
  try {
    return prepareBody(input);
  } catch (err) {
    rethrowBodyInvalid(err);
  }
}
