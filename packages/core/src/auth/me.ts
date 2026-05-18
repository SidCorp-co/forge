import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { oauthAccounts, userPreferences, users } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';

export const meRoutes = new Hono<{ Variables: AuthVars }>();

// Cover the whole /me/* surface — profile + preferences. requireAuth on the
// prefix is fine here because every handler in this router is user-scoped.
meRoutes.use('/me', requireAuth());
meRoutes.use('/me/*', requireAuth());

meRoutes.get('/me', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isCeo: users.isCeo,
      createdAt: users.createdAt,
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
    emailVerifiedAt: row.emailVerifiedAt,
    isCeo: row.isCeo,
    createdAt: row.createdAt,
    hasPassword: row.passwordHash !== null,
    oauthProviders,
  });
});

// `system` follows the OS preference at render time; the value just gets
// echoed back to the client. Languages enumerated narrowly so a typo on the
// client doesn't silently break the i18n loader.
const themes = ['system', 'light', 'dark'] as const;
const languages = ['en', 'vi'] as const;

const preferencesSchema = z
  .object({
    theme: z.enum(themes).optional(),
    language: z.enum(languages).optional(),
  })
  .strict();

const DEFAULT_PREFS = { theme: 'system' as const, language: 'en' as const };

meRoutes.get('/me/preferences', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      theme: userPreferences.theme,
      language: userPreferences.language,
      updatedAt: userPreferences.updatedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row) {
    return c.json({ ...DEFAULT_PREFS, updatedAt: null });
  }
  return c.json(row);
});

meRoutes.patch(
  '/me/preferences',
  zValidator('json', preferencesSchema, (r) => {
    if (!r.success) {
      throw new HTTPException(400, {
        message: 'Invalid input',
        cause: { code: 'BAD_REQUEST', details: z.flattenError(r.error) },
      });
    }
  }),
  async (c) => {
    const userId = c.get('userId');
    const patch = c.req.valid('json');
    if (Object.keys(patch).length === 0) {
      throw new HTTPException(400, {
        message: 'no fields to update',
        cause: { code: 'BAD_REQUEST' },
      });
    }

    // Insert a row if missing, otherwise patch only the keys the caller sent.
    // postgres `INSERT ... ON CONFLICT DO UPDATE` keeps this single round-trip.
    const [row] = await db
      .insert(userPreferences)
      .values({
        userId,
        theme: patch.theme ?? DEFAULT_PREFS.theme,
        language: patch.language ?? DEFAULT_PREFS.language,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({
        theme: userPreferences.theme,
        language: userPreferences.language,
        updatedAt: userPreferences.updatedAt,
      });

    return c.json(row);
  },
);
