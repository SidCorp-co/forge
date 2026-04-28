import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export type AuthVars = { userId: string };

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

export function assertEmailVerified(): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
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
