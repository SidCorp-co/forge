import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { env } from '../config/env.js';
import { USER_JWT_TTL_SECONDS } from './jwt.js';

export const AUTH_COOKIE_NAME = 'forge_auth';

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

export function clearAuthCookie(c: Context): void {
  // Always clear the host-scoped variant first — it lingers in browsers from
  // before AUTH_COOKIE_DOMAIN was introduced and would survive a normal
  // domain-scoped logout, leaving stale auth attached to the request host.
  deleteCookie(c, AUTH_COOKIE_NAME, { path: '/' });
  if (env.AUTH_COOKIE_DOMAIN) {
    deleteCookie(c, AUTH_COOKIE_NAME, { path: '/', domain: env.AUTH_COOKIE_DOMAIN });
  }
}
