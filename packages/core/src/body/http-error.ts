import { HTTPException } from 'hono/http-exception';
import { BodyInvalidError } from './errors.js';
import { type PreparedBody, type PrepareInput, prepareBody } from './prepare.js';

export function bodyInvalidHttp(err: BodyInvalidError): HTTPException {
  return new HTTPException(400, {
    message: err.message,
    cause: { code: err.code, details: err.details },
  });
}

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
