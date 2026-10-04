import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { chatTurnKinds } from '../integrations/llm/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { appConfigOf } from './read.js';
import { saveAppConfig } from './service.js';

const projectIdParamSchema = z.object({ projectId: z.uuid() });

const upsertSchema = z
  .object({
    chatProviderId: z.string().trim().min(1).max(200).nullable().optional(),
    chatModel: z.string().trim().min(1).max(200).nullable().optional(),
    /** Replaces the whole map (PUT semantics) — GET first. */
    chatModelByKind: z
      .partialRecord(z.enum(chatTurnKinds), z.string().trim().min(1).max(200))
      .optional(),
    retrievalTopK: z.number().int().min(1).max(100).optional(),
    retrievalMinScore: z.number().min(0).max(1).optional(),
    enabledChannels: z.array(z.string().min(1).max(100)).max(100).optional(),
    systemPromptOverride: z.string().max(40_000).nullable().optional(),
    retrievalRerank: z.boolean().optional(),
    retrievalExpandRelations: z.boolean().optional(),
  })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const appConfigRoutes = new Hono<{ Variables: AuthVars }>();
appConfigRoutes.use('*', requireAuth(), assertEmailVerified());

appConfigRoutes.get(
  '/:projectId',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const row = await appConfigOf(projectId);
    return c.json(row ?? null);
  },
);

appConfigRoutes.put(
  '/:projectId',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', upsertSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const updates: Record<string, unknown> = {};
    if (patch.chatProviderId !== undefined) updates.chatProviderId = patch.chatProviderId;
    if (patch.chatModel !== undefined) updates.chatModel = patch.chatModel;
    if (patch.chatModelByKind !== undefined) updates.chatModelByKind = patch.chatModelByKind;
    if (patch.retrievalTopK !== undefined) updates.retrievalTopK = patch.retrievalTopK;
    if (patch.retrievalMinScore !== undefined) updates.retrievalMinScore = patch.retrievalMinScore;
    if (patch.enabledChannels !== undefined) updates.enabledChannels = patch.enabledChannels;
    if (patch.systemPromptOverride !== undefined)
      updates.systemPromptOverride = patch.systemPromptOverride;
    if (patch.retrievalRerank !== undefined) updates.retrievalRerank = patch.retrievalRerank;
    if (patch.retrievalExpandRelations !== undefined)
      updates.retrievalExpandRelations = patch.retrievalExpandRelations;

    const row = await saveAppConfig(projectId, updates);

    return c.json(row);
  },
);

