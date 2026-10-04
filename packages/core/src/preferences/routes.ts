import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { answerStyles, userPreferences } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireOrgCan } from '../permissions/index.js';
import { emitEvent } from '../outbox/index.js';
import {
  ASSISTANT_PREFERENCE_DEFAULTS,
  listPreferenceChanges,
  restorePreferenceChange,
  writeAssistantPreferences,
} from './service.js';

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
preferenceRoutes.use('/me/preferences', requireAuth());

preferenceRoutes.get('/preferences', async (c) => c.json(await readFull(c.get('userId'))));

preferenceRoutes.get('/preferences/changes', async (c) =>
  c.json({ items: await listPreferenceChanges(c.get('userId')) }),
);

preferenceRoutes.post(
  '/preferences/changes/:id/restore',
  zValidator('param', changeParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const userId = c.get('userId');
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
    const row = await db.transaction(async (tx) => {
      const [upserted] = await tx
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
      if (!upserted) throw new Error('user_preferences: upsert returned no row');
      await emitEvent(tx, 'user.preferencesChanged', {
        userId: upserted.userId,
        theme: upserted.theme,
        language: upserted.language,
      });
      return upserted;
    });

    return c.json(row);
  },
);

const preferencesSchema = z
  .object({
    theme: z.enum(PREF_THEMES).optional(),
    language: z.enum(PREF_LANGUAGES).optional(),
    notifyOnMention: z.boolean().optional(),
    // Identity of the newest "What's New" entry the user has seen (changelog
    // version or `unreleased:<hash>`). Opaque to the server (ISS-384).
    lastSeenWhatsNew: z.string().max(200).optional(),
    // The org the user is currently "working in" (ISS-469). `null` clears it
    // back to "no explicit choice" (the client resolves that to the personal
    // org). A non-null value is membership-checked below before it is stored.
    activeOrgId: z.string().uuid().nullable().optional(),
  })
  .strict();

const DEFAULT_PREFS = {
  theme: 'system' as const,
  language: 'en' as const,
  notifyOnMention: true,
  lastSeenWhatsNew: null as string | null,
  activeOrgId: null as string | null,
};

preferenceRoutes.get('/me/preferences', async (c) => {
  const userId = c.get('userId');
  const [row] = await db
    .select({
      theme: userPreferences.theme,
      language: userPreferences.language,
      notifyOnMention: userPreferences.notifyOnMention,
      lastSeenWhatsNew: userPreferences.lastSeenWhatsNew,
      activeOrgId: userPreferences.activeOrgId,
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

preferenceRoutes.patch(
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

    if (patch.activeOrgId != null) {
      await requireOrgCan({ userId }, 'org.read', patch.activeOrgId);
    }

    // Insert a row if missing, otherwise patch only the keys the caller sent.
    // postgres `INSERT ... ON CONFLICT DO UPDATE` keeps this single round-trip.
    const [row] = await db
      .insert(userPreferences)
      .values({
        userId,
        theme: patch.theme ?? DEFAULT_PREFS.theme,
        language: patch.language ?? DEFAULT_PREFS.language,
        notifyOnMention: patch.notifyOnMention ?? DEFAULT_PREFS.notifyOnMention,
        lastSeenWhatsNew: patch.lastSeenWhatsNew ?? DEFAULT_PREFS.lastSeenWhatsNew,
        activeOrgId: patch.activeOrgId ?? DEFAULT_PREFS.activeOrgId,
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.language !== undefined ? { language: patch.language } : {}),
          ...(patch.notifyOnMention !== undefined
            ? { notifyOnMention: patch.notifyOnMention }
            : {}),
          ...(patch.lastSeenWhatsNew !== undefined
            ? { lastSeenWhatsNew: patch.lastSeenWhatsNew }
            : {}),
          ...(patch.activeOrgId !== undefined ? { activeOrgId: patch.activeOrgId } : {}),
          updatedAt: new Date(),
        },
      })
      .returning({
        theme: userPreferences.theme,
        language: userPreferences.language,
        notifyOnMention: userPreferences.notifyOnMention,
        lastSeenWhatsNew: userPreferences.lastSeenWhatsNew,
        activeOrgId: userPreferences.activeOrgId,
        updatedAt: userPreferences.updatedAt,
      });

    return c.json(row);
  },
);
