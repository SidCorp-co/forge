import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { env } from '../config/env.js';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from './cookie-names.js';
import { USER_JWT_TTL_SECONDS } from './jwt.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './refresh-token.js';

export { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME };

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
