import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { profileOf } from './read.js';
import { setOwnDisplayName } from './service.js';

export const meRoutes = new Hono<{ Variables: AuthVars }>();

meRoutes.use('/me', requireAuth());

meRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  const profile = await profileOf(userId);
  if (!profile) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  const { row, oauthProviders } = profile;

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
    const row = await setOwnDisplayName(c.get('userId'), c.req.valid('json').displayName);
    if (!row) {
      throw new HTTPException(401, {
        message: 'user not found',
        cause: { code: 'UNAUTHENTICATED' },
      });
    }
    return c.json(row);
  },
);
