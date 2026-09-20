import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

/**
 * A write refused because the world already holds what it asked for.
 *
 * `cause.code` is the machine-readable name and `message` carries the whole
 * refusal, holders and all: a box logs the body verbatim, so a refusal that
 * says only "conflict" sends an operator to the database.
 */
export const conflict = (code: string, message: string, details?: unknown) =>
  new HTTPException(409, {
    message,
    cause: { code, ...(details === undefined ? {} : { details }) },
  });
