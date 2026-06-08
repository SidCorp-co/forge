import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyDeviceToken } from '../auth/deviceToken.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export type AuthVars = {
  userId: string;
  // Set only when the principal is a device (a CLI runner), not a user — see
  // `requireUserOrDevice`. `userId` is left unset in that case, so handlers
  // that authorize via `loadProjectAccess(projectId, userId)` fail closed for
  // a device unless they explicitly honor the device principal.
  deviceId?: string;
  principal?: 'user' | 'device';
};

export function requireAuth(): MiddlewareHandler<{ Variables: AuthVars }> {
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
    if (!token) {
      throw new HTTPException(401, {
        message: 'authentication required',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }

    try {
      const claims = await verifyUserToken(token);
      c.set('userId', claims.sub);
    } catch {
      throw new HTTPException(401, {
        message: 'invalid token',
        cause: { code: 'INVALID_TOKEN' },
      });
    }

    await next();
  };
}

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
    let token: string | undefined;
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (header) {
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (match?.[1]) token = match[1].trim();
    }
    if (!token) {
      token = getCookie(c, AUTH_COOKIE_NAME);
    }
    if (!token) {
      throw new HTTPException(401, {
        message: 'authentication required',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }

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
