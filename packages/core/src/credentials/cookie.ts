import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { env } from '../lib/env.js';
import { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME } from './cookie-names.js';
import { USER_JWT_TTL_SECONDS } from './jwt.js';
import { REFRESH_TOKEN_TTL_SECONDS } from './refresh-token.js';

export { AUTH_COOKIE_NAME, REFRESH_COOKIE_NAME };

const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Every value a `Cookie` header carries under `name`, in the order the browser sent them.
 *
 * A browser keeps one cookie per (name, domain, path), so a request can carry two `forge_auth`:
 * this host's own, and one a sibling instance scoped to the parent domain. Reading only the first
 * let whichever was created earlier decide who the caller is, so a stale one shadowed a fresh login.
 */
export function cookieValues(header: string | undefined | null, name: string): string[] {
  if (!header) return [];
  const values: string[] = [];
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    if (value) values.push(value);
  }
  return values;
}

export function requestCookieValues(c: Context, name: string): string[] {
  return cookieValues(c.req.header('cookie'), name);
}

/**
 * The configured cookie domain when the browser addressed a host under it, else none. The host is
 * the proxy's forwarded one first: Forge's own web previewed from a run (REQ-39) proxies `/api` to
 * core from a preview host outside that domain, where a cookie naming the domain is refused by the
 * browser, so it is written host-only there.
 */
export function sessionCookieDomain(
  domain: string | undefined,
  forwardedHost: string | undefined,
  host: string | undefined,
) {
  if (!domain) return undefined;
  const addressed = (forwardedHost?.split(',')[0] ?? host)
    ?.trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!addressed) return domain;
  const bare = domain.toLowerCase().replace(/^\./, '');
  return addressed === bare || addressed.endsWith(`.${bare}`) ? domain : undefined;
}

/**
 * A cookie of `name` at `path` written under the configured domain, after clearing the host-only
 * variant: that one lingers from before `AUTH_COOKIE_DOMAIN` was set, and with the same path the
 * browser sends whichever is older first. With no domain configured, or a request addressed to a
 * host outside it ({@link sessionCookieDomain}), the write replaces the host-only cookie itself. A
 * parent-domain cookie this server did not set (a sibling instance's) is left alone — clearing it
 * would sign the person out of that instance; it is outlasted by reading every value instead
 * ({@link cookieValues}).
 */
function writeSessionCookie(c: Context, name: string, value: string, path: string, maxAge: number) {
  const domain = sessionCookieDomain(
    env.AUTH_COOKIE_DOMAIN,
    c.req.header('x-forwarded-host'),
    c.req.header('host'),
  );
  if (domain) deleteCookie(c, name, { path });
  setCookie(c, name, value, {
    httpOnly: true,
    secure: env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test',
    sameSite: 'Lax',
    path,
    maxAge,
    ...(domain ? { domain } : {}),
  });
}

export function setAuthCookie(c: Context, token: string): void {
  writeSessionCookie(c, AUTH_COOKIE_NAME, token, '/', USER_JWT_TTL_SECONDS);
}

export function setRefreshCookie(c: Context, token: string): void {
  writeSessionCookie(c, REFRESH_COOKIE_NAME, token, REFRESH_COOKIE_PATH, REFRESH_TOKEN_TTL_SECONDS);
}

/** Both variants this server can name — host-only, and the configured domain when there is one. */
function clearSessionCookie(c: Context, name: string, path: string): void {
  deleteCookie(c, name, { path });
  if (env.AUTH_COOKIE_DOMAIN) deleteCookie(c, name, { path, domain: env.AUTH_COOKIE_DOMAIN });
}

/** The session and refresh cookies cleared: on logout, and on every answer that a session ended. */
export function clearSessionCookies(c: Context): void {
  clearSessionCookie(c, AUTH_COOKIE_NAME, '/');
  clearSessionCookie(c, REFRESH_COOKIE_NAME, REFRESH_COOKIE_PATH);
}
