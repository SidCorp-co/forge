import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { userPreferences } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';

export const PREF_THEMES = ['system', 'light', 'dark'] as const;
export const PREF_LANGUAGES = ['en', 'vi'] as const;

const DEFAULTS = {
  theme: 'system' as const,
  language: 'en' as const,
};

const patchBodySchema = z
  .object({
    theme: z.enum(PREF_THEMES).optional(),
    language: z.enum(PREF_LANGUAGES).optional(),
  })
  .strict()
  .refine(
    (v) => v.theme !== undefined || v.language !== undefined,
    { message: 'at least one of theme/language is required' },
  );

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const preferenceRoutes = new Hono<{ Variables: AuthVars }>();

preferenceRoutes.use('/preferences', requireAuth());

preferenceRoutes.get('/preferences', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      userId: userPreferences.userId,
      theme: userPreferences.theme,
      language: userPreferences.language,
      updatedAt: userPreferences.updatedAt,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);

  if (!row) {
    return c.json({
      userId,
      theme: DEFAULTS.theme,
      language: DEFAULTS.language,
      updatedAt: null,
    });
  }
  return c.json(row);
});

preferenceRoutes.patch(
  '/preferences',
  zValidator('json', patchBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { theme, language } = c.req.valid('json');
    const userId = c.get('userId');

    // INSERT … ON CONFLICT DO UPDATE upsert. The defaults from the column
    // definitions kick in when this is the user's first PATCH and they only
    // sent one field — the other column lands at its default.
    const [row] = await db
      .insert(userPreferences)
      .values({
        userId,
        ...(theme !== undefined ? { theme } : {}),
        ...(language !== undefined ? { language } : {}),
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(theme !== undefined ? { theme } : {}),
          ...(language !== undefined ? { language } : {}),
          updatedAt: sql`now()`,
        },
      })
      .returning({
        userId: userPreferences.userId,
        theme: userPreferences.theme,
        language: userPreferences.language,
        updatedAt: userPreferences.updatedAt,
      });

    if (!row) throw new Error('user_preferences: upsert returned no row');

    await hooks.emit('userPreferencesChanged', {
      userId: row.userId,
      theme: row.theme,
      language: row.language,
    });

    return c.json(row);
  },
);
