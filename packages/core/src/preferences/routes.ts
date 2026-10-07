import {
  PRODUCT_STATE_KEY_SHAPE,
  type ProductStateKey,
  productStateKeySchema,
  putProductStateRequestSchema,
} from '@forge/contracts/product-state';
import { TOUR_EVENT_SHAPE, tourEventRequestSchema } from '@forge/contracts/tours';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answerStyles } from '../db/schema.js';
import { refused } from '../lib/refusal.js';
import { type AuthVars, requireAuth } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, orgResource, requireOrgCan } from '../permissions/index.js';
import { listProductState, readMePreferences, readPreferences, readProductState } from './read.js';
import {
  listPreferenceChanges,
  recordTourEvent,
  restorePreferenceChange,
  writeAssistantPreferences,
  writeMePreferences,
  writeProductState,
} from './service.js';

const PREF_THEMES = ['system', 'light', 'dark'] as const;
const PREF_LANGUAGES = ['en', 'vi'] as const;

const patchBodySchema = z
  .object({
    answerStyle: z.enum(answerStyles).optional(),
    assistantInstructions: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.answerStyle !== undefined || v.assistantInstructions !== undefined, {
    message:
      'at least one of answerStyle/assistantInstructions is required; theme and language are set with PATCH /api/auth/me/preferences',
  });

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

const productStateKeyParam = zValidator(
  'param',
  z.object({ key: productStateKeySchema }),
  invalid(
    `invalid path: a product state key is ${PRODUCT_STATE_KEY_SHAPE}`,
    'PRODUCT_STATE_KEY_UNKNOWN',
  ),
);

/** A person's product state: What's new's seen mark and each tour's outcome, per key. */
export const productStateRoutes = new Hono<{ Variables: AuthVars }>();

productStateRoutes.use('/product-state', requireAuth());
productStateRoutes.use('/product-state/*', requireAuth());

productStateRoutes.get('/product-state', async (c) =>
  c.json({ items: await listProductState(c.get('userId')) }),
);

productStateRoutes.get('/product-state/:key', productStateKeyParam, async (c) =>
  c.json(await readProductState(c.get('userId'), c.req.valid('param').key as ProductStateKey)),
);

productStateRoutes.put(
  '/product-state/:key',
  productStateKeyParam,
  strictBody(putProductStateRequestSchema, '{ value: the value the key holds }'),
  async (c) => {
    const outcome = await writeProductState({
      userId: c.get('userId'),
      key: c.req.valid('param').key as ProductStateKey,
      value: c.req.valid('json').value,
    });
    if (!outcome.ok) return refused(c, outcome.refusals, 'PRODUCT_STATE_REFUSED');
    return c.json(outcome.state);
  },
);

productStateRoutes.use('/tour-events', requireAuth());

/** One event of the person's tour run: started, completed, dismissed at a step, or a step skipped. */
productStateRoutes.post(
  '/tour-events',
  strictBody(tourEventRequestSchema, TOUR_EVENT_SHAPE),
  async (c) =>
    c.json(
      { act: 'recorded', ...(await recordTourEvent(c.get('userId'), c.req.valid('json'))) },
      201,
    ),
);
