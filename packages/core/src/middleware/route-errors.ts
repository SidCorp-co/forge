import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.uuid(),
});

/**
 * A request-shape refusal (400): `details` is a zod error, a field map or a sentence, each answered
 * as refusal rows (`lib/refusal.ts:requestRefusals`).
 */
export const badRequest = (details: unknown, code = 'BAD_REQUEST') =>
  new HTTPException(400, { message: 'Invalid input', cause: { code, details } });

export const notFound = (message = 'project not found') =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });
