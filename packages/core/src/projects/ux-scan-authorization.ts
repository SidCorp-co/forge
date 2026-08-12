import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';

const UX_SCAN_AUTHORIZATION_TYPE = 'ux-scan' as const;
const UX_SCAN_AUTHORIZATION_TTL_SECONDS = 10 * 60;

type UxScanAuthorizationClaims = {
  projectId: string;
  sessionId: string;
  authorizationId: string;
  userId: string;
};

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

export async function signUxScanAuthorization(claims: UxScanAuthorizationClaims): Promise<string> {
  return new SignJWT({
    typ: UX_SCAN_AUTHORIZATION_TYPE,
    projectId: claims.projectId,
    sessionId: claims.sessionId,
    authorizationId: claims.authorizationId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${UX_SCAN_AUTHORIZATION_TTL_SECONDS}s`)
    .sign(secret());
}

export async function verifyUxScanAuthorization(token: string): Promise<UxScanAuthorizationClaims> {
  const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
  if (
    payload.typ !== UX_SCAN_AUTHORIZATION_TYPE ||
    typeof payload.projectId !== 'string' ||
    typeof payload.sessionId !== 'string' ||
    typeof payload.authorizationId !== 'string' ||
    typeof payload.sub !== 'string'
  ) {
    throw new Error('invalid UX scan authorization');
  }
  return {
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    authorizationId: payload.authorizationId,
    userId: payload.sub,
  };
}
