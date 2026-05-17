/**
 * Step-up re-authentication endpoint (ISS-149 Sub 1).
 *
 * `POST /api/auth/reauth { password }` — verifies the current user's password
 * and marks them "fresh" for a short window. Sensitive endpoints (PAT mint,
 * PAT rotate; future: destructive account actions) gate behind
 * `requireFreshAuth(minutes)` in `middleware/require-fresh-auth.ts`.
 *
 * Returns `{ stampedAt }` so the caller can display a countdown if desired.
 * Rate-limited under the same bucket as `/auth/local` to make brute-forcing
 * the password unappealing.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { RULES } from '../config/rate-limits.js';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { markFreshAuth } from '../middleware/require-fresh-auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { getDummyPasswordHash, verifyPassword } from './password.js';

const reauthSchema = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();

export const reauthRoutes = new Hono<{ Variables: AuthVars }>();

reauthRoutes.use('/reauth', rateLimit(RULES.authLocal, { name: 'authReauth' }));

reauthRoutes.post(
  '/reauth',
  requireAuth(),
  zValidator('json', reauthSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const userId = c.get('userId');
    const { password } = c.req.valid('json');

    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const invalid = () =>
      new HTTPException(401, {
        message: 'invalid credentials',
        cause: { code: 'INVALID_CREDENTIALS' },
      });

    if (!user || !user.passwordHash) {
      // OAuth-only users have no local password — they cannot use this gate.
      // Burn a dummy verify for timing parity.
      await verifyPassword(password, await getDummyPasswordHash());
      throw invalid();
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw invalid();

    const stampedAt = Date.now();
    markFreshAuth(userId, stampedAt);
    return c.json({ stampedAt: new Date(stampedAt).toISOString() });
  },
);
