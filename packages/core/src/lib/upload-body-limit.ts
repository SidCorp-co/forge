import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { env } from '../config/env.js';

export function uploadBodyLimit(
  onError: (c: Context) => Response | Promise<Response>,
): MiddlewareHandler {
  let limiter: MiddlewareHandler | undefined;
  return (c, next) => {
    limiter ??= bodyLimit({ maxSize: env.UPLOADS_MAX_BYTES, onError });
    return limiter(c, next);
  };
}
