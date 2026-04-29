import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env.js';
import { consumeVerificationToken } from './verification-token.js';

export const verifyRoutes = new Hono();

type VerifyOutcome = 'ok' | 'invalid' | 'expired';

async function runVerify(token: string | undefined): Promise<VerifyOutcome> {
  if (typeof token !== 'string' || token.length === 0) return 'invalid';
  const result = await consumeVerificationToken(token);
  if (result === null) return 'invalid';
  if (result === 'expired') return 'expired';
  return 'ok';
}

/**
 * Build a redirect to the web `/login` with a typed query flag. Mirrors the
 * `oauthErrorRedirect` shape in auth/oauth/handler.ts so success/error UX is
 * consistent — the web banner translates the code into prose.
 */
function loginRedirect(c: Context, query: string): Response {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(`${base}/login${query}`, 302);
}

// GET is the path users hit from the email — it MUST be a redirect, not JSON,
// because a browser-rendered `{"verified":true}` is bad UX even on success.
verifyRoutes.get('/verify', async (c) => {
  const outcome = await runVerify(c.req.query('token'));
  if (outcome === 'ok') return loginRedirect(c, '?verified=1');
  return loginRedirect(c, `?verify_error=${outcome}`);
});

// POST stays JSON for programmatic callers (CLI, future desktop in-app flow,
// tests). HTTPException → existing core error envelope.
verifyRoutes.post('/verify', async (c) => {
  const queryToken = c.req.query('token');
  let token: string | undefined = queryToken;
  if (!token) {
    try {
      const body = (await c.req.json()) as { token?: unknown };
      if (typeof body?.token === 'string') token = body.token;
    } catch {
      // no body — fall through to invalid
    }
  }
  const outcome = await runVerify(token);
  if (outcome === 'invalid') {
    throw new HTTPException(400, {
      message: 'invalid verification token',
      cause: { code: 'INVALID_TOKEN' },
    });
  }
  if (outcome === 'expired') {
    throw new HTTPException(400, {
      message: 'verification token expired',
      cause: { code: 'TOKEN_EXPIRED' },
    });
  }
  return c.json({ verified: true });
});
