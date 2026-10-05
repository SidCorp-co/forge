import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../lib/rate-limits.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { getDummyPasswordHash, verifyPassword } from './password.js';
import { passwordHashOf } from './read.js';
import { markFreshAuth } from './service.js';

export const reauthRoutes = new Hono<{ Variables: AuthVars }>();

const reauthSchema = z.object({
  password: z.string().min(1).max(1024),
});

// Reuse the authLocal rate-limit bucket: same risk profile (password brute-
// force against a known user), keyed by IP. Five attempts per 15 minutes.
reauthRoutes.use(
  '/reauth',
  rateLimit(() => RULES.authLocal, { name: 'authReauth' }),
);
reauthRoutes.use('/reauth', requireAuth());

reauthRoutes.post(
  '/reauth',
  zValidator('json', reauthSchema, invalid('Invalid reauth input')),
  async (c) => {
    const userId = c.get('userId');
    const { password } = c.req.valid('json');

    const invalid = () =>
      new HTTPException(401, {
        message: 'invalid credentials',
        cause: { code: 'INVALID_CREDENTIALS' },
      });

    const user = await passwordHashOf(userId);

    // OAuth-only users have no local password (passwordHash is NULL since
    // 0037). Equalize timing with the wrong-password path before refusing.
    if (!user?.passwordHash) {
      await verifyPassword(password, await getDummyPasswordHash());
      throw invalid();
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw invalid();

    const freshAuthAt = new Date();
    await markFreshAuth(userId, freshAuthAt);

    return c.json({ freshAuthAt: freshAuthAt.toISOString() });
  },
);
