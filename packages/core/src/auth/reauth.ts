import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { RULES } from '../config/rate-limits.js';
import { getDummyPasswordHash, verifyPassword } from './password.js';

// ISS-158 — Fresh re-auth primitive. Sibling children (PAT creation, device
// revoke, password change) call POST /api/auth/reauth before submitting
// destructive or sensitive requests so the server-side requireFreshAuth()
// gate sees a recent stamp on the users row.
export const reauthRoutes = new Hono<{ Variables: AuthVars }>();

const reauthSchema = z.object({
  password: z.string().min(1).max(1024),
});

// Reuse the authLocal rate-limit bucket: same risk profile (password brute-
// force against a known user), keyed by IP. Five attempts per 15 minutes.
reauthRoutes.use('/reauth', rateLimit(RULES.authLocal, { name: 'authReauth' }));
reauthRoutes.use('/reauth', requireAuth());

reauthRoutes.post(
  '/reauth',
  zValidator('json', reauthSchema, (result) => {
    if (!result.success) {
      throw new HTTPException(400, {
        message: 'Invalid reauth input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(result.error) },
      });
    }
  }),
  async (c) => {
    const userId = c.get('userId');
    const { password } = c.req.valid('json');

    const invalid = () =>
      new HTTPException(401, {
        message: 'invalid credentials',
        cause: { code: 'INVALID_CREDENTIALS' },
      });

    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // OAuth-only users have no local password (passwordHash is NULL since
    // 0037). Equalize timing with the wrong-password path before refusing.
    if (!user || !user.passwordHash) {
      await verifyPassword(password, await getDummyPasswordHash());
      throw invalid();
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw invalid();

    const freshAuthAt = new Date();
    await db
      .update(users)
      .set({ lastFreshAuthAt: freshAuthAt })
      .where(eq(users.id, userId));

    return c.json({ freshAuthAt: freshAuthAt.toISOString() });
  },
);
