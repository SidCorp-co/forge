/**
 * Combined-auth middleware for endpoints that the web UI, MCP runners, and
 * automation scripts all need to call (notably attachment uploads).
 *
 * Accepts a Bearer token that may be:
 *   - a user JWT (web session)
 *   - a Personal Access Token (`forge_pat_*`)
 *   - a legacy device token
 *
 * Falls back to the `forge_auth` cookie when no Bearer header is present so
 * browser uploads continue to work without code changes.
 *
 * Sets `c.set('userId')` to the resolved user ID regardless of which auth
 * path matched, so existing handlers that use `c.get('userId')` continue to
 * work unchanged.
 *
 * NOTE: this does NOT call `assertEmailVerified()` — PAT and device tokens
 * are issued AFTER email verification, so the check is implicit. For user
 * JWT path, callers that need strict email-verified semantics should add a
 * second middleware or migrate to PAT.
 */

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { verifyPat } from '../auth/pat.js';

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

    // PAT path — recognized by `forge_pat_*` prefix
    if (isPatLike(token)) {
      const verified = await verifyPat(token);
      if (!verified) throw unauth('invalid personal access token');
      c.set('userId', verified.row.userId);
      await next();
      return;
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
