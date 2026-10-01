import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { zValidator } from '../middleware/zod-validator.js';
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

const tokenQuery = z.object({ token: z.string().optional() });
const tokenBody = z.object({ token: z.string().optional() });

const invalidToken = () =>
  new HTTPException(400, {
    message: 'invalid verification token',
    cause: { code: 'INVALID_TOKEN' },
  });

function loginRedirect(c: Context, query: string): Response {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(`${base}/login${query}`, 302);
}

// GET is the path users hit from the email — it MUST be a redirect, not JSON,
// because a browser-rendered `{"verified":true}` is bad UX even on success.
verifyRoutes.get(
  '/verify',
  zValidator('query', tokenQuery, (result, c) => {
    if (!result.success) return loginRedirect(c, '?verify_error=invalid');
  }),
  async (c) => {
    const outcome = await runVerify(c.req.valid('query').token);
    if (outcome === 'ok') return loginRedirect(c, '?verified=1');
    return loginRedirect(c, `?verify_error=${outcome}`);
  },
);

// POST stays JSON for programmatic callers (CLI, future desktop in-app flow,
// tests). HTTPException → existing core error envelope.
verifyRoutes.post(
  '/verify',
  zValidator('query', tokenQuery, (result) => {
    if (!result.success) throw invalidToken();
  }),
  zValidator('json', tokenBody, (result) => {
    if (!result.success) throw invalidToken();
  }),
  async (c) => {
    const outcome = await runVerify(c.req.valid('query').token || c.req.valid('json').token);
    if (outcome === 'invalid') throw invalidToken();
    if (outcome === 'expired') {
      throw new HTTPException(400, {
        message: 'verification token expired',
        cause: { code: 'TOKEN_EXPIRED' },
      });
    }
    return c.json({ verified: true });
  },
);
