import { isFeedbackServerKeyLike } from '@forge/contracts/feedback-server-keys';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AUTH_COOKIE_NAME, requestCookieValues } from '../credentials/cookie.js';

const BEARER = /^Bearer\s+(.+)$/i;

type BearerHeader = { kind: 'absent' } | { kind: 'malformed' } | { kind: 'token'; token: string };

function rawBearerHeader(c: Context): BearerHeader {
  const header = c.req.header('authorization') ?? c.req.header('Authorization');
  if (!header) return { kind: 'absent' };
  const token = BEARER.exec(header)?.[1]?.trim();
  return token ? { kind: 'token', token } : { kind: 'malformed' };
}

/** A server key presented where it admits nothing: its one route on its one project is the only door (ISS-922). */
export function serverKeyScopeRefusal(detail: string): HTTPException {
  return new HTTPException(403, { message: detail, cause: { code: 'FEEDBACK_SERVER_KEY_SCOPE' } });
}

/**
 * The bearer token, for every gate that reads one. A product server's feedback key
 * (`feedback/server-key-door.ts`) is answered before these gates on the one route it admits, so one
 * reaching a gate is on a route it does not admit, and is refused by name here rather than read as
 * a session or a token.
 */
export function parseBearerHeader(c: Context): BearerHeader {
  const parsed = rawBearerHeader(c);
  if (parsed.kind === 'token' && isFeedbackServerKeyLike(parsed.token)) {
    throw serverKeyScopeRefusal(
      `a server key admits only POST /api/projects/<its project>/feedback; ${c.req.method} ${c.req.path} is not that route`,
    );
  }
  return parsed;
}

/** The server key presented as the bearer, or null where the bearer is anything else. */
export function readServerKeyBearer(c: Context): string | null {
  const parsed = rawBearerHeader(c);
  return parsed.kind === 'token' && isFeedbackServerKeyLike(parsed.token) ? parsed.token : null;
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
