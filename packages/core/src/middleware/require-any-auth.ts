/**
 * Combined-auth middleware for endpoints that the web UI and automation
 * scripts both need to call (notably attachment uploads).
 *
 * Accepts a Bearer token that may be:
 *   - a user JWT (web session)
 *   - a Personal Access Token (`forge_pat_*`), fenced exactly as `requireAuth`
 *     fences one — see `beginPatRequest`
 *
 * Falls back to the `forge_auth` cookie when no Bearer header is present so
 * browser uploads continue to work without code changes.
 *
 * Sets `c.set('userId')` regardless of which path matched, so handlers using
 * `c.get('userId')` work unchanged. Does NOT call `assertEmailVerified()` —
 * a PAT is issued after verification, so it is implicit; a user-JWT caller
 * needing strict semantics adds a second middleware.
 */

import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { beginPatRequest, withPatScope } from './pat-rest-surface.js';

export type AnyAuthVars = {
  userId: string;
  agency?: ActorAgency | null;
  principal?: 'user' | 'device' | 'pat';
};

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

export function requireAnyAuth(): MiddlewareHandler<{ Variables: AnyAuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
      c.set('principal', 'pat');
      c.set('agency', principal.agency);
      return withPatScope(scope, () => next());
    }

    let claims: Awaited<ReturnType<typeof verifyUserToken>>;
    try {
      claims = await verifyUserToken(token);
    } catch {
      throw unauth('invalid token');
    }
    c.set('userId', claims.sub);
    c.set('principal', 'user');
    await next();
  };
}
