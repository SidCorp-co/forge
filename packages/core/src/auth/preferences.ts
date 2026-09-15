import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { answerStyles, userPreferences } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import {
  ASSISTANT_PREFERENCE_DEFAULTS,
  listPreferenceChanges,
  PreferenceRestoreConflict,
  restorePreferenceChange,
  writeAssistantPreferences,
} from './preference-changes.js';

export const PREF_THEMES = ['system', 'light', 'dark'] as const;
export const PREF_LANGUAGES = ['en', 'vi'] as const;

const DEFAULTS = {
  theme: 'system' as const,
  language: 'en' as const,
};

// cm:guard `answerStyle` is a closed enum and `assistantInstructions` bounded free text, and the assistant fields go through `preference-changes.ts` rather than the theme/language upsert below: every write to them leaves a row the person can restore from, and a write that skipped the trail would be the one change they could not undo (ISS-1034).
const patchBodySchema = z
  .object({
    theme: z.enum(PREF_THEMES).optional(),
    language: z.enum(PREF_LANGUAGES).optional(),
    answerStyle: z.enum(answerStyles).optional(),
    assistantInstructions: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.theme !== undefined ||
      v.language !== undefined ||
      v.answerStyle !== undefined ||
      v.assistantInstructions !== undefined,
    {
      message: 'at least one of theme/language/answerStyle/assistantInstructions is required',
    },
  );

const changeParamSchema = z.object({ id: z.uuid() });

const FULL = {
  userId: userPreferences.userId,
  theme: userPreferences.theme,
  language: userPreferences.language,
  answerStyle: userPreferences.answerStyle,
  assistantInstructions: userPreferences.assistantInstructions,
  updatedAt: userPreferences.updatedAt,
};

async function readFull(userId: string) {
  const [row] = await db
    .select(FULL)
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return (
    row ?? {
      userId,
      theme: DEFAULTS.theme,
      language: DEFAULTS.language,
      answerStyle: ASSISTANT_PREFERENCE_DEFAULTS.answerStyle,
      assistantInstructions: ASSISTANT_PREFERENCE_DEFAULTS.assistantInstructions,
      updatedAt: null,
    }
  );
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const preferenceRoutes = new Hono<{ Variables: AuthVars }>();

preferenceRoutes.use('/preferences', requireAuth());
preferenceRoutes.use('/preferences/*', requireAuth());

preferenceRoutes.get('/preferences', async (c) => c.json(await readFull(c.get('userId'))));

preferenceRoutes.get('/preferences/changes', async (c) =>
  c.json({ items: await listPreferenceChanges(c.get('userId')) }),
);

// cm:guard 409 and never a silent overwrite: a restore applies only while the field still holds what that change set, and the refusal names the later change so the person can restore THAT one instead (ISS-1034 criterion 61).
preferenceRoutes.post(
  '/preferences/changes/:id/restore',
  zValidator('param', changeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
    try {
      const restored = await restorePreferenceChange({
        userId,
        changeId: c.req.valid('param').id,
        actor: { kind: 'person', userId },
      });
      if (!restored) {
        throw new HTTPException(404, {
          message: 'no such preference change of yours',
          cause: { code: 'NOT_FOUND' },
        });
      }
      return c.json(await readFull(userId));
    } catch (err) {
      if (err instanceof PreferenceRestoreConflict) {
        throw new HTTPException(409, {
          message: err.message,
          cause: { code: 'PREFERENCE_CHANGE_SUPERSEDED', laterChangeId: err.later?.id ?? null },
        });
      }
      throw err;
    }
  },
);

preferenceRoutes.patch(
  '/preferences',
  zValidator('json', patchBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { theme, language, answerStyle, assistantInstructions } = c.req.valid('json');
    const userId = c.get('userId');

    if (answerStyle !== undefined || assistantInstructions !== undefined) {
      await writeAssistantPreferences({
        userId,
        patch: { answerStyle, assistantInstructions },
        actor: { kind: 'person', userId },
      });
    }
    if (theme === undefined && language === undefined) return c.json(await readFull(userId));

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
      .returning(FULL);

    if (!row) throw new Error('user_preferences: upsert returned no row');

    await hooks.emit('userPreferencesChanged', {
      userId: row.userId,
      theme: row.theme,
      language: row.language,
    });

    return c.json(row);
  },
);
