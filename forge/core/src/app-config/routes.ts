import { zValidator } from '@hono/zod-validator';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { appConfig } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const projectIdParamSchema = z.object({ projectId: z.uuid() });

const upsertSchema = z
  .object({
    chatProviderId: z.string().trim().min(1).max(200).nullable().optional(),
    chatModel: z.string().trim().min(1).max(200).nullable().optional(),
    retrievalTopK: z.number().int().min(1).max(100).optional(),
    retrievalMinScore: z.number().min(0).max(1).optional(),
    enabledChannels: z.array(z.string().min(1).max(100)).max(100).optional(),
    systemPromptOverride: z.string().max(40_000).nullable().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const appConfigRoutes = new Hono<{ Variables: AuthVars }>();
appConfigRoutes.use('*', requireAuth(), assertEmailVerified());

appConfigRoutes.get(
  '/:projectId',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [row] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.projectId, projectId))
      .limit(1);
    return c.json(row ?? null);
  },
);

appConfigRoutes.put(
  '/:projectId',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', upsertSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner' && access.role !== 'admin') {
      throw forbidden('insufficient permission');
    }

    const updates: Record<string, unknown> = {};
    if (patch.chatProviderId !== undefined) updates.chatProviderId = patch.chatProviderId;
    if (patch.chatModel !== undefined) updates.chatModel = patch.chatModel;
    if (patch.retrievalTopK !== undefined) updates.retrievalTopK = patch.retrievalTopK;
    if (patch.retrievalMinScore !== undefined) updates.retrievalMinScore = patch.retrievalMinScore;
    if (patch.enabledChannels !== undefined) updates.enabledChannels = patch.enabledChannels;
    if (patch.systemPromptOverride !== undefined)
      updates.systemPromptOverride = patch.systemPromptOverride;

    const [row] = await db
      .insert(appConfig)
      .values({ projectId, ...updates })
      .onConflictDoUpdate({
        target: appConfig.projectId,
        set: { ...updates, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error('app_config: upsert returned no row');

    return c.json(row);
  },
);
