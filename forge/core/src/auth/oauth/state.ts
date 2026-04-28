/**
 * OAuth state cookie — defends the callback against CSRF + replay.
 *
 * The flow:
 *   1. /:provider/start signs a payload {p, n, v, r, exp} into a JWT and
 *      stores it in `forge_oauth_state` (httpOnly, SameSite=Lax, 5 min).
 *      The `state` query param sent to the provider is just `n` (a 32-byte
 *      random nonce).
 *   2. /:provider/callback reads the cookie, JWT-verifies it, and asserts
 *      that `n` from the cookie equals the `state` query param + that `p`
 *      matches the URL's :provider segment. Anything off → 400.
 *   3. The cookie is deleted on the response (single-use).
 *
 * The PKCE `code_verifier` lives inside the cookie so it never leaves the
 * server, and the post-callback redirect target lives in `r` so a
 * compromised provider can't rewrite where we land.
 *
 * SameSite=Lax is correct for OAuth: top-level GET navigations from the
 * provider's host back to ours DO send Lax cookies; that's the entire
 * reason Lax (rather than Strict) exists.
 */

import { setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../../config/env.js';
import type { ProviderId } from './providers.js';

const COOKIE_NAME = 'forge_oauth_state';
const COOKIE_TTL_SECONDS = 300; // 5 min — generous for slow auth screens
const ALG = 'HS256';
const ISSUER = 'forge.oauth.state';

export interface StatePayload {
  /** Provider id this state belongs to. */
  p: ProviderId;
  /** Nonce — what's sent to the provider in the `state` query param. */
  n: string;
  /** PKCE code_verifier (43-128 char URL-safe random string). */
  v: string;
  /** Post-callback redirect path; always relative — never absolute URLs. */
  r: string;
}

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  if (!cachedKey) cachedKey = new TextEncoder().encode(env.JWT_SECRET);
  return cachedKey;
}

function randomUrlSafe(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  // Base64url without padding — RFC 7636 PKCE format.
  return Buffer.from(buf).toString('base64url');
}

export function generateNonce(): string {
  return randomUrlSafe(32);
}

export function generatePkceVerifier(): string {
  // 64 bytes → 86 base64url chars, well within RFC 7636's 43-128 range.
  return randomUrlSafe(64);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Buffer.from(digest).toString('base64url');
}

export async function signState(payload: StatePayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyState(token: string): Promise<StatePayload> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER });
  if (
    typeof payload.p !== 'string' ||
    typeof payload.n !== 'string' ||
    typeof payload.v !== 'string' ||
    typeof payload.r !== 'string'
  ) {
    throw new Error('state: malformed payload');
  }
  return { p: payload.p as ProviderId, n: payload.n, v: payload.v, r: payload.r };
}

export function setStateCookie(c: Context, jwt: string): void {
  setCookie(c, COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_TTL_SECONDS,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  });
}

export function clearStateCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: '/' });
  if (env.AUTH_COOKIE_DOMAIN) {
    deleteCookie(c, COOKIE_NAME, { path: '/', domain: env.AUTH_COOKIE_DOMAIN });
  }
}

export const STATE_COOKIE_NAME = COOKIE_NAME;
