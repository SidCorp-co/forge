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

// cm:guard `agency` belongs on THIS shape too, not just `AuthVars` — until 2026-09-01 this middleware took a principal that already carried agency and kept only `userId`, so every write behind it (attachment upload, comment post) recorded a job token's work as its owner acting by hand. A second auth entrypoint that drops a field is how one gets fixed and the other stays wrong.
export type AnyAuthVars = { userId: string; agency?: ActorAgency };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

// cm:guard FOUR middlewares verify a device token, and NONE of them hands the device its owner's account authority. Until ISS-927 this one did — `c.set('userId', device.ownerId)` — and it was the single place in the codebase where a credential silently became a person. `requireAuth` rejects devices outright and `requireUserOrDevice` and `requireDevice` make the device its own principal with `userId` left unset so `loadProjectAccess` fails closed; `/mcp` refuses a device outright since ISS-931. There is no longer a middleware to pick when you "mean" ambient owner authority, because the answer is now to give the caller a token: a job gets `job:<id>` at claim, an unattended session gets `session:<id>` at `agent:start`. If a new caller class appears with neither, mint it one — do not restore this branch.
// cm:why what retired the device branch was NOT the silence of the Sentry probe that used to sit here. That probe asked "is anyone still calling this?", and its own guard warned that a negative from grepping one repo is not a fact — the MCP config carries a device token in plaintext, so a skill or an operator script could always have been the caller it could not see. The branch is gone because the caller class it served now holds a real, scoped, revocable token, which makes the question the probe was asking moot rather than answered. A caller that still presents a device token here now gets 401, which is a loud break naming itself, and that is the intended outcome (ISS-927).
export function requireAnyAuth(): MiddlewareHandler<{ Variables: AnyAuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    // cm:guard the PAT branch goes through `beginPatRequest`, the SAME call `requireAuth` makes, and setting `userId` from the token row is not on its own enough. Until 2026-09-01 it was exactly that and nothing else: no allowlist, no project scope — so a token bound to one project listed and downloaded attachments, and posted comments, on every project its owner could reach. The handlers behind here call `loadProjectAccess` and looked right; the fence they consult is established up here or not at all.
    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
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
    await next();
  };
}
