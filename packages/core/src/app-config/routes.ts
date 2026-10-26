import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { chatTurnKinds, listProviders } from '../assistant/providers/registry.js';
import { db } from '../db/client.js';
import { appConfig } from '../db/schema.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { configRowSchema, putAppConfig, readAppConfig } from './routes-reference.js';

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

/**
 * A provider id nothing registered names was stored and then passed over for the fallback on every
 * turn, so the setting read as taken and did nothing (ISS-1421 r18). It is refused by name.
 */
function refuseUnknownChatProvider(id: string): void {
  const providers = listProviders();
  if (providers.includes(id)) return;
  throw new HTTPException(400, {
    message:
      providers.length === 0
        ? `No chat provider is named "${id}": this deployment has none, so chatProviderId takes only null.`
        : `No chat provider is named "${id}". This deployment has ${providers.join(', ')}.`,
    cause: { code: 'CHAT_PROVIDER_UNKNOWN', details: { chatProviderId: id, providers } },
  });
}

export const appConfigRoutes = new Hono<{ Variables: AuthVars }>();
appConfigRoutes.use('*', requireAuth(), assertEmailVerified());

appConfigRoutes.get(
  '/:projectId',
  readAppConfig,
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertRoleFor(access, 'viewer', 'read its app settings');

    const [row] = await db
      .select()
      .from(appConfig)
      .where(eq(appConfig.projectId, projectId))
      .limit(1);
    return c.json(answer(configRowSchema.nullable(), row ?? null));
  },
);

appConfigRoutes.put(
  '/:projectId',
  putAppConfig,
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
    assertRoleFor(access, 'admin', 'change its app settings');
    if (patch.chatProviderId) refuseUnknownChatProvider(patch.chatProviderId);

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

    const [row] = await db
      .insert(appConfig)
      .values({ projectId, ...updates })
      .onConflictDoUpdate({
        target: appConfig.projectId,
        set: { ...updates, updatedAt: sql`now()` },
      })
      .returning();
    if (!row) throw new Error('app_config: upsert returned no row');

    return c.json(answer(configRowSchema, row));
  },
);
