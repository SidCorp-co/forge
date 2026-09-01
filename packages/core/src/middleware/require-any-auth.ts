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

import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { isSentryEnabled, Sentry } from '../observability/sentry.js';
import { readBearerToken } from './bearer.js';
import { beginPatRequest, withPatScope } from './pat-rest-surface.js';

// cm:guard `agency` belongs on THIS shape too, not just `AuthVars` — until 2026-09-01 this middleware took a principal that already carried agency and kept only `userId`, so every write behind it (attachment upload, comment post) recorded a job token's work as its owner acting by hand. A second auth entrypoint that drops a field is how one gets fixed and the other stays wrong.
export type AnyAuthVars = { userId: string; agency?: ActorAgency };

const unauth = (message: string) =>
  new HTTPException(401, { message, cause: { code: 'UNAUTHENTICATED' } });

// cm:guard FIVE middlewares verify a device token and exactly ONE of them — `requireAnyAuth` — hands the device its owner's account authority by setting `userId = device.ownerId`; `requireAuth` rejects devices outright and `requireUserOrDevice`, `requireDevice` and `requirePatOrDevice` (`/mcp`) all make the device its own principal with `userId` left unset so `loadProjectAccess` fails closed. Measured 2026-09-01: that one exception is the whole disagreement, so choosing a middleware for a new route chooses whether the caller gets ambient owner authority. Pick `requireAnyAuth` only if you mean that, and say so.
// cm:guard this probe is the EVIDENCE that lets the branch below be deleted, so do not remove it before the branch it measures. Reading the runner in Rust found no caller — it downloads only session attachments, which go to `requireUserOrDevice` — but a negative established by grepping one repo is not a fact: the agent's MCP config carries a device token in plaintext, so a skill, an operator script or the desktop app can be a caller that no Rust grep can see. Delete the branch when this has been silent across real jobs and chat turns, never on the strength of the source read alone.
function reportDeviceOnDataPlane(c: Context, deviceId: string): void {
  if (!isSentryEnabled()) return;
  Sentry.captureMessage('auth.device_token_on_data_plane', {
    level: 'warning',
    tags: { route: c.req.routePath, method: c.req.method },
    extra: { deviceId, path: c.req.path },
  });
}

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

    // User JWT path — try first since web uploads are the most common case
    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      await next();
      return;
    } catch {
      // fall through to device-token path
    }

    const device = await verifyDeviceToken(token);
    if (!device) throw unauth('invalid token');
    reportDeviceOnDataPlane(c, device.id);
    c.set('userId', device.ownerId);
    c.set('agency', 'agent');
    await next();
  };
}
