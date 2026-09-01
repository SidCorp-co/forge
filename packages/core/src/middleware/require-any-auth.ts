/**
 * Combined-auth middleware for endpoints that the web UI, MCP runners, and
 * automation scripts all need to call (notably attachment uploads).
 *
 * Accepts a Bearer token that may be:
 *   - a user JWT (web session)
 *   - a Personal Access Token (`forge_pat_*`), fenced exactly as `requireAuth`
 *     fences one — see `beginPatRequest`
 *   - a legacy device token
 *
 * Falls back to the `forge_auth` cookie when no Bearer header is present so
 * browser uploads continue to work without code changes.
 *
 * Sets `c.set('userId')` regardless of which path matched, so handlers using
 * `c.get('userId')` work unchanged. Does NOT call `assertEmailVerified()` —
 * PAT and device tokens are issued after verification, so it is implicit; a
 * user-JWT caller needing strict semantics adds a second middleware.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { beginPatRequest, withPatScope } from './pat-rest-surface.js';

export type AnyAuthVars = { userId: string };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

export function requireAnyAuth(): MiddlewareHandler<{ Variables: AnyAuthVars }> {
  return async (c, next) => {
    let token: string | undefined;

    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match?.[1]) token = match[1].trim();
    }

    if (!token) {
      token = getCookie(c, AUTH_COOKIE_NAME);
    }

    if (!token) throw unauth('authentication required');

    // cm:guard the PAT branch goes through `beginPatRequest`, the SAME call `requireAuth` makes, and setting `userId` from the token row is not on its own enough. Until 2026-09-01 it was exactly that and nothing else: no allowlist, no project scope — so a token bound to one project listed and downloaded attachments, and posted comments, on every project its owner could reach. The handlers behind here call `loadProjectAccess` and looked right; the fence they consult is established up here or not at all.
    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
      return withPatScope(scope, () => next());
    }

    // User JWT path — try first since web uploads are the most common case
    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      await next();
      return;
    } catch {
      // fall through to device-token path
    }

    // Device-token path (legacy desktop runners)
    const device = await verifyDeviceToken(token);
    if (!device) throw unauth('invalid token');
    c.set('userId', device.ownerId);
    await next();
  };
}
