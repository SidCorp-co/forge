/**
 * The refusals and the one path param every device route family shares, so a module split
 * out of `pool-routes.ts` cannot drift from the parent it was split from.
 */

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });
