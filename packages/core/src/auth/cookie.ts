import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { env } from '../config/env.js';
import { USER_JWT_TTL_SECONDS } from './jwt.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './refresh-token.js';

export const AUTH_COOKIE_NAME = 'forge_auth';
/**
 * Refresh cookie scoped narrowly to /api/auth so other routes never see
 * (and therefore never log) the long-lived rotation token. Browsers
 * still send it on the cross-origin POST /auth/refresh path because
 * SameSite=Lax permits same-site cross-origin requests.
 */
export const REFRESH_COOKIE_NAME = 'forge_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';

export function setAuthCookie(c: Context, token: string): void {
  setCookie(c, AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    sameSite: 'Lax',
    path: '/',
    maxAge: USER_JWT_TTL_SECONDS,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  });
}

export function setRefreshCookie(c: Context, token: string): void {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    sameSite: 'Lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_SECONDS,
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  });
}

export function clearAuthCookie(c: Context): void {
  // Always clear the host-scoped variant first — it lingers in browsers from
  // before AUTH_COOKIE_DOMAIN was introduced and would survive a normal
  // domain-scoped logout, leaving stale auth attached to the request host.
  deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
  if (env.AUTH_COOKIE_DOMAIN) {
    deleteCookie(c, AUTH_COOKIE_NAME, { path: '/', domain: env.AUTH_COOKIE_DOMAIN });
  }
}

export function clearRefreshCookie(c: Context): void {
  deleteCookie(c, REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });
  if (env.AUTH_COOKIE_DOMAIN) {
    deleteCookie(c, REFRESH_COOKIE_NAME, {
      path: REFRESH_COOKIE_PATH,
      domain: env.AUTH_COOKIE_DOMAIN,
    });
  }
}
