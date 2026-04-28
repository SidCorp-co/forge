import { type JWTPayload, SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

export const USER_JWT_TYPE = 'user' as const;
export const USER_JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type UserJwtClaims = JWTPayload & {
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
  return payload as UserJwtClaims;
}
