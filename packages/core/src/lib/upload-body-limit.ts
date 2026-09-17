import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { env } from '../config/env.js';

/**
 * The upload body cap, read on the first request rather than at registration.
 *
 * Four routers cap an upload body, and each of them used to call `bodyLimit({ maxSize:
 * env.UPLOADS_MAX_BYTES, … })` while registering its route. That is a module-scope read: importing
 * any of those four files — which importing `index.ts` does — validated the whole environment and
 * threw on a missing variable, which is the side effect ISS-1067 removes. Deferring the limiter to
 * the first request is what makes `env` lazy at every reader rather than at most of them.
 */
// cm:guard the limiter is built ONCE and reused, not rebuilt per request: `bodyLimit` closes over
// its options, so rebuilding it would re-read `env` on every upload and hand each request a fresh
// middleware for no gain.
export function uploadBodyLimit(
  onError: (c: Context) => Response | Promise<Response>,
): MiddlewareHandler {
  let limiter: MiddlewareHandler | undefined;
  return (c, next) => {
    limiter ??= bodyLimit({ maxSize: env.UPLOADS_MAX_BYTES, onError });
    return limiter(c, next);
  };
}
