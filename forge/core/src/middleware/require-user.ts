import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { errors as joseErrors } from 'jose';
import { AUTH_COOKIE_NAME } from '../auth/cookie.js';
import { verifyUserToken } from '../auth/jwt.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';

export type AuthedUser = {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
};

export type UserVars = { user: AuthedUser };

type UnauthCode = 'UNAUTHENTICATED' | 'TOKEN_EXPIRED';

const unauth = (code: UnauthCode, message: string) =>
  new HTTPException(401, { message, cause: { code } });

function extractToken(c: Context): string | null {
  // Cookie takes priority over Authorization header (browser-friendly).
  const cookie = getCookie(c, AUTH_COOKIE_NAME);
  if (cookie) return cookie;
  const header = c.req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ? match[1].trim() : null;
}

export const requireUser = (): MiddlewareHandler<{ Variables: UserVars }> => {
  return async (c, next) => {
    const token = extractToken(c);
    if (!token) throw unauth('UNAUTHENTICATED', 'authentication required');

    let claims: Awaited<ReturnType<typeof verifyUserToken>>;
    try {
      claims = await verifyUserToken(token);
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw unauth('TOKEN_EXPIRED', 'token expired');
      }
      throw unauth('UNAUTHENTICATED', 'invalid token');
    }

    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);

    if (!row) throw unauth('UNAUTHENTICATED', 'user not found');

    c.set('user', row);
    await next();
  };
};
