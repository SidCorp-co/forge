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
  deleteCookie(c, AUTH_COOKIE_NAME, {
    path: '/',
    ...(env.AUTH_COOKIE_DOMAIN ? { domain: env.AUTH_COOKIE_DOMAIN } : {}),
  });
}
