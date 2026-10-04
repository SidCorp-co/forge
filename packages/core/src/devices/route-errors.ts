import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found`, cause: { code: 'NOT_FOUND' } });
