import { type JWTPayload, jwtVerify, SignJWT } from 'jose';
import { env } from '../config/env.js';

export const USER_JWT_TYPE = 'user' as const;
export const USER_JWT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type UserJwtClaims = JWTPayload & {
  sub: string;
  typ: typeof USER_JWT_TYPE;
};

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

// cm:edge lockstep -> packages/core/src/auth/agent-login-refusal.test.ts — every caller of this function is a login entrance, and each one must refuse `users.kind = 'agent'` through `assertNotAgent` BEFORE reaching it. The refusal is not here because signing a JWT is pure crypto and a DB read in it costs every caller a query; it is enforced instead by that test, which scans the tree for call sites and fails on one that does not refuse (ISS-932).
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
