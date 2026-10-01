import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });

/** Refused: this principal may not do this here. `message` carries the whole refusal. */
export const forbidden = (code: string, message: string, details?: unknown) =>
  new HTTPException(403, {
    message,
    cause: { code, ...(details === undefined ? {} : { details }) },
  });
