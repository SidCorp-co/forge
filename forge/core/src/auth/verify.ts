import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { consumeVerificationToken } from './verification-token.js';

export const verifyRoutes = new Hono();

async function handleVerify(token: string | undefined) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new HTTPException(400, {
      message: 'invalid verification token',
      cause: { code: 'INVALID_TOKEN' },
    });
  }

  const result = await consumeVerificationToken(token);
  if (result === null) {
    throw new HTTPException(400, {
      message: 'invalid verification token',
      cause: { code: 'INVALID_TOKEN' },
    });
  }
  if (result === 'expired') {
    throw new HTTPException(400, {
      message: 'verification token expired',
      cause: { code: 'TOKEN_EXPIRED' },
    });
  }
}

verifyRoutes.get('/verify', async (c) => {
  await handleVerify(c.req.query('token'));
  return c.json({ verified: true });
});

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
  await handleVerify(token);
  return c.json({ verified: true });
});
