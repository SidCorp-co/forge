import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { isPatLike } from '../auth/pat-format.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { readBearerToken } from './bearer.js';
import { beginPatRequest, withPatScope } from './pat-rest-surface.js';

export type AuthVars = {
  userId: string;
  // Set only when the principal is a device (a CLI runner), not a user — see
  // `requireUserOrDevice`. `userId` is left unset in that case, so handlers
  // that authorize via `loadProjectAccess(projectId, userId)` fail closed for
  // a device unless they explicitly honor the device principal.
  deviceId?: string;
  principal?: 'user' | 'device' | 'pat';
  // cm:guard REST must carry this or the whole agency axis stops at the door: `requireAuth` reduces a rich principal to `principal:'pat'`, a string tag, and every route downstream then hardcodes a `user` actor. That is how an agent holding a PAT reached `PATCH /api/issues/batch` — which DOES transition, via transitionIssueStatus — and skipped the ISS-786/812 gates while `/mcp` enforced them, because MCP synthesizes a device for a PAT and REST has none to synthesize.
  agency?: ActorAgency;
  patTokenId?: string;
};

/**
 * The actor for a REST write, carrying the trust axis the routes must not
 * decide for themselves.
 */
// cm:guard build the actor HERE, never as a `{ type: 'user' as const }` literal in a route — three route files each had their own copy and all three were wrong in the same way, which is what a second copy of an auth decision always costs. `id` stays the owning user (a job's write really is its creator's); `agency` is what the lifecycle gates read.
export function restActor(c: Context<{ Variables: AuthVars }>): {
  type: 'user';
  id: string;
  agency: ActorAgency;
} {
  return { type: 'user', id: c.get('userId'), agency: c.get('agency') ?? 'human' };
}

/**
 * The REST data plane's gate: a user JWT (web/desktop) or a Personal Access
 * Token (the `forge-runner api` CLI, and any agent holding one).
 *
 * A PAT resolves to its owner's `userId`, which on its own would widen a
 * project-scoped token into an account-scoped one. {@link beginPatRequest} is
 * what stops that, and `requireAnyAuth` calls the same function.
 */
export function requireAuth(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    if (isPatLike(token)) {
      const { principal, scope } = await beginPatRequest(c, token);
      c.set('userId', principal.userId);
      c.set('principal', 'pat');
      c.set('agency', principal.agency);
      c.set('patTokenId', principal.tokenId);
      return withPatScope(scope, () => next());
    }

    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      c.set('principal', 'user');
    } catch {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }

    await next();
  };
}

// cm:guard FIVE middlewares verify a device token and exactly ONE of them — `requireAnyAuth` — hands the device its owner's account authority by setting `userId = device.ownerId`; `requireAuth` rejects devices outright and `requireUserOrDevice`, `requireDevice` and `requirePatOrDevice` (`/mcp`) all make the device its own principal with `userId` left unset so `loadProjectAccess` fails closed. Measured 2026-09-01: that one exception is the whole disagreement, so choosing a middleware for a new route chooses whether the caller gets ambient owner authority. Pick `requireAnyAuth` only if you mean that, and say so.
/**
 * Accept EITHER a user JWT (web/desktop) OR a device token (a CLI runner).
 *
 * Mirrors the split the `jobs` domain already has (user routes vs device-auth
 * sibling routers): the agent-sessions chat write-back (`PATCH /:id`) is hit by
 * both the desktop (user JWT) and a CLI runner (device token), on the SAME
 * path, so a single dual-auth gate is needed. User token is tried first (the
 * common case); a device token sets `deviceId`/`principal='device'` and leaves
 * `userId` unset — every route that authorizes via `loadProjectAccess(_, userId)`
 * therefore fails closed for a device unless it explicitly honors the device
 * principal (only the chat write-back does, scoped to its own session).
 */
export function requireUserOrDevice(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const token = readBearerToken(c);

    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
      c.set('principal', 'user');
      await next();
      return;
    } catch {
      // Not a user token — fall through to device-token verification.
    }

    const device = await verifyDeviceToken(token);
    if (!device) {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }
    c.set('deviceId', device.id);
    c.set('principal', 'device');
    await next();
  };
}

export function assertEmailVerified(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    // Device principals have no email; the device token itself is the gate.
    if (c.get('principal') === 'device') {
      await next();
      return;
    }
    const userId = c.get('userId');
    const [row] = await db
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || row.emailVerifiedAt === null) {
      throw new HTTPException(403, {
        message: 'verify email',
        cause: { code: 'EMAIL_NOT_VERIFIED' },
      });
    }

    await next();
  };
}
