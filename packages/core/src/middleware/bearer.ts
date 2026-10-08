import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME, requestCookieValues } from '../credentials/cookie.js';

const BEARER = /^Bearer\s+(.+)$/i;

type BearerHeader = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'token'; token: string };

export function parseBearerHeader(c: Context): BearerHeader {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return { kind: 'absent' };
  const token = BEARER.exec(header)?.[1]?.trim();
  return token ? { kind: 'token', token } : { kind: 'malformed' };
}

/**
 * What the caller presented: a token in the `Authorization` header, or else every `forge_auth`
 * session cookie the browser sent. A header token is a credential its holder typed or minted; a
 * cookie only ever carries a session this server (or a sibling instance) wrote.
 */
export type PresentedCredential =
  | { kind: 'header'; token: string }
  | { kind: 'cookie'; sessions: string[] };

export function readPresentedCredential(c: Context): PresentedCredential {
  const parsed = parseBearerHeader(c);
  if (parsed.kind === 'token') return { kind: 'header', token: parsed.token };
  const sessions = requestCookieValues(c, AUTH_COOKIE_NAME);
  if (sessions.length === 0) {
    throw new HTTPException(401, {
      message: 'authentication required',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  return { kind: 'cookie', sessions };
}
