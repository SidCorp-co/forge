import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  clearSessionCookies,
  REFRESH_COOKIE_NAME,
  requestCookieValues,
  setAuthCookie,
  setRefreshCookie,
} from '../credentials/cookie.js';
import { signUserToken } from '../credentials/jwt.js';
import { refreshTokenPrefix } from '../credentials/refresh-token.js';
import { assertNotAgentUser } from './agent-login-gate.js';
import { invalidateRefreshTokens, rotateRefreshToken } from './service.js';

export const refreshRoutes = new Hono();

type Refused = 'INVALID_REFRESH_TOKEN' | 'REFRESH_TOKEN_EXPIRED' | 'REFRESH_TOKEN_REUSED';

const REFUSAL_MESSAGES: Record<Refused, string> = {
  INVALID_REFRESH_TOKEN: 'invalid refresh token',
  REFRESH_TOKEN_EXPIRED: 'refresh token expired',
  REFRESH_TOKEN_REUSED: 'refresh token reuse detected',
};

/**
 * A refresh that opens no session ends the one the browser holds: both session cookies are
 * cleared with the refusal, so the next load starts signed out instead of replaying them.
 */
function refuse(c: Context, code: Refused): HTTPException {
  clearSessionCookies(c);
  return new HTTPException(401, { message: REFUSAL_MESSAGES[code], cause: { code } });
}

refreshRoutes.post('/refresh', async (c) => {
  // The refresh token lives only in the httpOnly cookie. A missing cookie answers the same
  // INVALID_REFRESH_TOKEN a forged one does, so a probe cannot tell the two apart. Every value the
  // browser sent is tried in order: a sibling instance's parent-domain cookie can sit beside this
  // host's own and be sent first.
  let refused: Refused = 'INVALID_REFRESH_TOKEN';
  for (const raw of requestCookieValues(c, REFRESH_COOKIE_NAME)) {
    const outcome = await rotateRefreshToken(raw, refreshTokenPrefix(raw));
    if (outcome.kind === 'invalid') continue;
    if (outcome.kind === 'expired') {
      refused = 'REFRESH_TOKEN_EXPIRED';
      continue;
    }
    if (outcome.kind === 'replay') {
      // Runs as its own auto-committed statement on the pool so the
      // invalidation persists independently of the rotation transaction.
      await invalidateRefreshTokens(outcome.userId);
      throw refuse(c, 'REFRESH_TOKEN_REUSED');
    }

    await assertNotAgentUser(outcome.userId);
    const token = await signUserToken(outcome.userId);
    setAuthCookie(c, token);
    setRefreshCookie(c, outcome.refreshToken);
    // refreshToken stays out of the JSON body (cookie-only since ISS-315 cleanup).
    return c.json({ token });
  }
  throw refuse(c, refused);
});
