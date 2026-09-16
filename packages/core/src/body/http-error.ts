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

export function bodyInvalidHttp(err: BodyInvalidError): HTTPException {
  return new HTTPException(400, {
    message: err.message,
    cause: { code: err.code, details: err.details },
  });
}

/**
 * The 400 a body refusal becomes, or `null` when this error is not one.
 *
 * Returned rather than thrown for the one caller that has more mapping to do
 * after it: the comment create route reads pg error codes off the same catch
 * (depth trigger, parent FK), and a helper that always throws would swallow
 * that arm.
 */
export function bodyRefusalHttp(err: unknown): HTTPException | null {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  return null;
}

/** Re-throw a body refusal as a 400; anything else passes through untouched. */
export function rethrowBodyInvalid(err: unknown): never {
  const mapped = bodyRefusalHttp(err);
  if (mapped) throw mapped;
  throw err;
}

export function prepareBodyOrThrow(input: PrepareInput): PreparedBody {
  try {
    return prepareBody(input);
  } catch (err) {
    rethrowBodyInvalid(err);
  }
}
