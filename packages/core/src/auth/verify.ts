import type { Context } from 'hono';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { answer } from '../api-reference/declare/describe.js';
import { declaresInput } from '../api-reference/declare/validator.js';
import { env } from '../config/env.js';
import { consumeVerificationToken } from './verification-token.js';
import {
  verifiedSchema,
  verifyBodySchema,
  verifyFromEmail,
  verifyProgrammatically,
  verifyQuerySchema,
} from './verify-reference.js';

export const verifyRoutes = new Hono();

type VerifyOutcome = 'ok' | 'invalid' | 'expired';

async function runVerify(token: string | undefined): Promise<VerifyOutcome> {
  if (typeof token !== 'string' || token.length === 0) return 'invalid';
  const result = await consumeVerificationToken(token);
  if (result === null) return 'invalid';
  if (result === 'expired') return 'expired';
  return 'ok';
}

function loginRedirect(c: Context, query: string): Response {
  const base = env.APP_BASE_URL.replace(/\/+$/, '');
  return c.redirect(`${base}/login${query}`, 302);
}

// GET is the path users hit from the email — it MUST be a redirect, not JSON,
// because a browser-rendered `{"verified":true}` is bad UX even on success.
verifyRoutes.get(
  '/verify',
  verifyFromEmail,
  declaresInput('query', verifyQuerySchema),
  async (c) => {
    const outcome = await runVerify(verifyQuerySchema.parse(c.req.query()).token);
    if (outcome === 'ok') return loginRedirect(c, '?verified=1');
    return loginRedirect(c, `?verify_error=${outcome}`);
  },
);

// POST stays JSON for programmatic callers (CLI, future desktop in-app flow,
// tests). HTTPException → existing core error envelope.
verifyRoutes.post(
  '/verify',
  verifyProgrammatically,
  declaresInput('query', verifyQuerySchema),
  declaresInput('json', verifyBodySchema),
  async (c) => {
    let token: string | undefined = verifyQuerySchema.parse(c.req.query()).token;
    if (!token) {
      try {
        const body = verifyBodySchema.safeParse(await c.req.json());
        if (body.success) token = body.data.token;
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
    return c.json(answer(verifiedSchema, { verified: true }));
  },
);
