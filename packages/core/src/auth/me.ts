import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { oauthAccounts, users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';

export const meRoutes = new Hono<{ Variables: AuthVars }>();

meRoutes.use('/me', requireAuth());

meRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
      lastFreshAuthAt: users.lastFreshAuthAt,
      // Selected only to derive `hasPassword` — the hash itself is never
      // serialized below.
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }

  const oauthRows = await db
    .select({ provider: oauthAccounts.provider })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.userId, userId));
  const oauthProviders = Array.from(new Set(oauthRows.map((r) => r.provider)));

  return c.json({
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    lastFreshAuthAt: row.lastFreshAuthAt,
    hasPassword: row.passwordHash !== null,
    oauthProviders,
  });
});

/**
 * The name a person is shown as, in their own words (ISS-1003).
 *
 * Trimmed and bounded, and otherwise anything they type — accents included.
 * `null` clears it, which puts them back to being rendered by address.
 */
const profileSchema = z
  .object({ displayName: z.string().trim().min(1).max(200).nullable() })
  .strict();

meRoutes.patch(
  '/me',
  zValidator('json', profileSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const [row] = await db
      .update(users)
      .set({ displayName: c.req.valid('json').displayName })
      .where(eq(users.id, c.get('userId')))
      .returning({ id: users.id, email: users.email, displayName: users.displayName });
    if (!row) {
      throw new HTTPException(401, {
        message: 'user not found',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }
    return c.json(row);
  },
);
