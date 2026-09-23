import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

/** Refused: the world already holds it. `message` carries the whole refusal. */
export const conflict = (code: string, message: string, details?: unknown) =>
  new HTTPException(409, {
    message,
    cause: { code, ...(details === undefined ? {} : { details }) },
  });
