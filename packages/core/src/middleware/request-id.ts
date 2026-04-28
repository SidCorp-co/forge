import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

export type RequestIdVars = { requestId: string };

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestId = (): MiddlewareHandler<{ Variables: RequestIdVars }> => {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
    c.set('requestId', id);
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
};
