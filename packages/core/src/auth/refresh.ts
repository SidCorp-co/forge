import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { REFRESH_COOKIE_NAME, setAuthCookie, setRefreshCookie } from '../credentials/cookie.js';
import { signUserToken } from '../credentials/jwt.js';
import { refreshTokenPrefix } from '../credentials/refresh-token.js';
import { assertNotAgentUser } from './agent-login-gate.js';
import { invalidateRefreshTokens, rotateRefreshToken } from './service.js';

export const refreshRoutes = new Hono();

const invalid = () =>
  new HTTPException(401, {
    message: 'invalid refresh token',
    cause: { code: 'INVALID_REFRESH_TOKEN' },
  });

const expired = () =>
  new HTTPException(401, {
    message: 'refresh token expired',
    cause: { code: 'REFRESH_TOKEN_EXPIRED' },
  });

const reused = () =>
  new HTTPException(401, {
    message: 'refresh token reuse detected',
    cause: { code: 'REFRESH_TOKEN_REUSED' },
  });

refreshRoutes.post('/refresh', async (c) => {
  // Refresh token lives ONLY in the httpOnly cookie at this point — the
  // body fallback was removed in ISS-315 cleanup once every client had
  // landed on the cookie path. A missing cookie returns the same
  // INVALID_REFRESH_TOKEN that a forged token would, so a probe can't
  // distinguish "no cookie" from "wrong cookie".
  const raw = getCookie(c, REFRESH_COOKIE_NAME);
  if (!raw) throw invalid();
  const prefix = refreshTokenPrefix(raw);

  const outcome = await rotateRefreshToken(raw, prefix);

  if (outcome.kind === 'invalid') throw invalid();
  if (outcome.kind === 'expired') throw expired();
  if (outcome.kind === 'replay') {
    // Runs as its own auto-committed statement on the pool so the
    // invalidation persists independently of the rotation transaction.
    await invalidateRefreshTokens(outcome.userId);
    throw reused();
  }

  await assertNotAgentUser(outcome.userId);
  const token = await signUserToken(outcome.userId);
  setAuthCookie(c, token);
  setRefreshCookie(c, outcome.refreshToken);
  // refreshToken stays out of the JSON body (cookie-only since ISS-315
  // cleanup) — clients should rely on the cookie roundtrip.
  return c.json({ token });
});
