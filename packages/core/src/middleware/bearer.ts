/**
 * How every authenticating middleware in this repo finds the caller's token.
 *
 * Five of them exist because five authorisation policies exist, but the way a
 * token is *read* was never one of the differences — the same regex was
 * copy-pasted five times, so a fix to one copy reached the others only if
 * someone remembered. The two real differences are kept, and named: whether a
 * cookie may stand in for the header, and whether "no header" and "bad header"
 * get the same 401.
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME } from '../auth/cookie-names.js';

const BEARER = /^Bearer\s+(.+)$/i;

export type BearerHeader =
  | { kind: 'absent' }
  | { kind: 'malformed' }
  | { kind: 'token'; token: string };

export function parseBearerHeader(c: Context): BearerHeader {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return { kind: 'absent' };
  const token = BEARER.exec(header)?.[1]?.trim();
  return token ? { kind: 'token', token } : { kind: 'malformed' };
}

export function readBearerToken(c: Context): string {
  const parsed = parseBearerHeader(c);
  const token = (parsed.kind === 'token' ? parsed.token : '') || getCookie(c, AUTH_COOKIE_NAME);
  if (!token) {
    throw new HTTPException(401, {
      message: 'authentication required',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  return token;
}
