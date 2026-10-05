import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answerStyles } from '../db/schema.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { readMePreferences, readPreferences } from './read.js';
import {
  listPreferenceChanges,
  restorePreferenceChange,
  writeAssistantPreferences,
  writeMePreferences,
} from './service.js';

const PREF_THEMES = ['system', 'light', 'dark'] as const;
const PREF_LANGUAGES = ['en', 'vi'] as const;

const patchBodySchema = z
  .object({
    answerStyle: z.enum(answerStyles).optional(),
    assistantInstructions: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.answerStyle !== undefined || v.assistantInstructions !== undefined,
    {
      message:
        'at least one of answerStyle/assistantInstructions is required; theme and language are set with PATCH /api/auth/me/preferences',
    },
  );

const changeParamSchema = z.object({ id: z.uuid() });

export const preferenceRoutes = new Hono<{ Variables: AuthVars }>();

preferenceRoutes.use('/preferences', requireAuth());
preferenceRoutes.use('/preferences/*', requireAuth());
preferenceRoutes.use('/me/preferences', requireAuth());

preferenceRoutes.get('/preferences', async (c) => c.json(await readPreferences(c.get('userId'))));

preferenceRoutes.get('/preferences/changes', async (c) =>
  c.json({ items: await listPreferenceChanges(c.get('userId')) }),
);

preferenceRoutes.post(
  '/preferences/changes/:id/restore',
  zValidator('param', changeParamSchema),
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
    return c.json(await readPreferences(userId));
  },
);

preferenceRoutes.patch('/preferences', zValidator('json', patchBodySchema), async (c) => {
  const { answerStyle, assistantInstructions } = c.req.valid('json');
  const userId = c.get('userId');
  await writeAssistantPreferences({
    userId,
    patch: { answerStyle, assistantInstructions },
    actor: { kind: 'person', userId },
  });
  return c.json(await readPreferences(userId));
});

const preferencesSchema = z
  .object({
    theme: z.enum(PREF_THEMES).optional(),
    language: z.enum(PREF_LANGUAGES).optional(),
    notifyOnMention: z.boolean().optional(),
    // The org the user is currently "working in" (ISS-469). `null` clears it
    // back to "no explicit choice" (the client resolves that to the personal
    // org). A non-null value is membership-checked below before it is stored.
    activeOrgId: z.string().uuid().nullable().optional(),
  })
  .strict();

preferenceRoutes.get('/me/preferences', async (c) => {
  const userId = c.get('userId');
  return c.json(await readMePreferences(userId));
});

preferenceRoutes.patch('/me/preferences', zValidator('json', preferencesSchema), async (c) => {
  const userId = c.get('userId');
  const patch = c.req.valid('json');
  if (Object.keys(patch).length === 0) {
    throw new HTTPException(400, {
      message: 'no fields to update',
      cause: { code: 'BAD_REQUEST' },
    });
  }

  if (patch.activeOrgId != null) {
    await requireOrgCan(actorFor(userId), 'org.read', orgResource(patch.activeOrgId));
  }

  return c.json(await writeMePreferences(userId, patch));
});
