import { eq } from 'drizzle-orm';
import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../lib/env.js';

const USER_JWT_TYPE = 'user' as const;
export const USER_JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

type UserJwtClaims = JWTPayload & {
  sub: string;
  typ: typeof USER_JWT_TYPE;
};

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

export async function signUserToken(userId: string): Promise<string> {
  return new SignJWT({ typ: USER_JWT_TYPE })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${USER_JWT_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifyUserToken(token: string): Promise<UserJwtClaims> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  if (payload.typ !== USER_JWT_TYPE || typeof payload.sub !== 'string') {
    throw new Error('invalid token type');
  }
  const [user] = await db
    .select({ tokensValidAfter: users.tokensValidAfter })
    .from(users)
    .where(eq(users.id, payload.sub))
    .limit(1);
  const after = user?.tokensValidAfter;
  if (after && (payload.iat ?? 0) * 1000 < after.getTime()) {
    throw new Error('token issued before the holder logged out');
  }
  return payload as UserJwtClaims;
}
