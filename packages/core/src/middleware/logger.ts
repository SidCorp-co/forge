import type { MiddlewareHandler } from 'hono';
import { currentQueryTiming } from '../db/query-timing.js';
import { getLogger } from '../lib/logger.js';
import type { RequestIdVars } from './request-id.js';

/**
 * A box polls these every few seconds; at info they filled a 1000-line tail in about 30s, so the
 * lines before a crash were gone by the time anyone read them. Answered below 400 they log at
 * debug; a refusal or a failure on them still logs as every other path's does.
 */
const POLLED = '/api/devices/me/';

export const requestLogger = (): MiddlewareHandler<{ Variables: RequestIdVars }> => {
  return async (c, next) => {
    const start = Date.now();
    const log = getLogger(c);
    const method = c.req.method;
    const path = c.req.path;

    const polled = path.startsWith(POLLED);
    if (polled) log.debug({ method, path }, 'request.start');
    else log.info({ method, path }, 'request.start');

    await next();

    const status = c.res.status;
    const durationMs = Date.now() - start;
    const timing = currentQueryTiming();
    const payload = {
      method,
      path,
      status,
      durationMs,
      ...(timing ? { queries: timing.queries, dbMs: Math.round(timing.dbMs) } : {}),
    };

    if (status >= 500) {
      log.error(payload, 'request.end');
    } else if (status >= 400) {
      log.warn(payload, 'request.end');
    } else if (polled) {
      log.debug(payload, 'request.end');
    } else {
      log.info(payload, 'request.end');
    }
  };
};
