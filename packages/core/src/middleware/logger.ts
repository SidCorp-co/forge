import type { MiddlewareHandler } from 'hono';
import { getLogger } from '../logger.js';
import type { RequestIdVars } from './request-id.js';

export const requestLogger = (): MiddlewareHandler<{ Variables: RequestIdVars }> => {
  return async (c, next) => {
    const start = Date.now();
    const log = getLogger(c);
    const method = c.req.method;
    const path = c.req.path;

    log.info({ method, path }, 'request.start');

    await next();

    const status = c.res.status;
    const durationMs = Date.now() - start;
    const payload = { method, path, status, durationMs };

    if (status >= 500) {
      log.error(payload, 'request.end');
    } else if (status >= 400) {
      log.warn(payload, 'request.end');
    } else {
      log.info(payload, 'request.end');
    }
  };
};
