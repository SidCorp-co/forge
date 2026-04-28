import { zValidator } from '@hono/zod-validator';
import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentApprovalModes, agentSchedules, agents } from '../db/schema.js';
import { setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectId: z.uuid(),
    type: z.string().min(1).max(200).optional(),
    enabled: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === true || v === 'true')),
  })
  .strict();

const createSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(500),
    type: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).nullable().optional(),
    enabled: z.boolean().optional(),
    focusAreas: z.array(z.string().min(1).max(200)).optional(),
    customInstructions: z.string().max(20_000).nullable().optional(),
    schedule: z.enum(agentSchedules).optional(),
    approvalMode: z.enum(agentApprovalModes).optional(),
    maxProposals: z.number().int().min(1).max(1000).optional(),
    excludeCategories: z.array(z.string().min(1).max(200)).optional(),
    promptTemplate: z.string().max(40_000).nullable().optional(),
    reindexPromptTemplate: z.string().max(40_000).nullable().optional(),
    knowledge: z.string().max(40_000).nullable().optional(),
    memory: z.string().max(40_000).nullable().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    type: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).nullable().optional(),
    enabled: z.boolean().optional(),
    focusAreas: z.array(z.string().min(1).max(200)).optional(),
    customInstructions: z.string().max(20_000).nullable().optional(),
    schedule: z.enum(agentSchedules).optional(),
    approvalMode: z.enum(agentApprovalModes).optional(),
    maxProposals: z.number().int().min(1).max(1000).optional(),
    excludeCategories: z.array(z.string().min(1).max(200)).optional(),
    promptTemplate: z.string().max(40_000).nullable().optional(),
    reindexPromptTemplate: z.string().max(40_000).nullable().optional(),
    knowledge: z.string().max(40_000).nullable().optional(),
    memory: z.string().max(40_000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const agentRoutes = new Hono<{ Variables: AuthVars }>();
agentRoutes.use('*', requireAuth(), assertEmailVerified());

agentRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectId, type, enabled } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const conditions = [eq(agents.projectId, projectId)];
    if (type) conditions.push(eq(agents.type, type));
    if (enabled !== undefined) conditions.push(eq(agents.enabled, enabled));

    const where = and(...conditions);

    const [totalRow] = await db.select({ n: count() }).from(agents).where(where);
    setTotalCount(c, totalRow?.n ?? 0);

    const rows = await db.select().from(agents).where(where).orderBy(asc(agents.createdAt));
    return c.json(rows);
  },
);

agentRoutes.post(
  '/',
  zValidator('json', createSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(input.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [inserted] = await db
      .insert(agents)
      .values({
        projectId: input.projectId,
        name: input.name,
        type: input.type,
        description: input.description ?? null,
        enabled: input.enabled ?? false,
        ...(input.focusAreas !== undefined ? { focusAreas: input.focusAreas } : {}),
        customInstructions: input.customInstructions ?? null,
        ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
        ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
        ...(input.maxProposals !== undefined ? { maxProposals: input.maxProposals } : {}),
        ...(input.excludeCategories !== undefined
          ? { excludeCategories: input.excludeCategories }
          : {}),
        promptTemplate: input.promptTemplate ?? null,
        reindexPromptTemplate: input.reindexPromptTemplate ?? null,
        knowledge: input.knowledge ?? null,
        memory: input.memory ?? null,
      })
      .returning();
    if (!inserted) throw new Error('agents: insert returned no row');

    return c.json(inserted, 201);
  },
);

agentRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!row) throw notFound('agent not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(row);
  },
);

agentRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', patchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const [existing] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    if (!existing) throw notFound('agent not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.type !== undefined) updates.type = patch.type;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.enabled !== undefined) updates.enabled = patch.enabled;
    if (patch.focusAreas !== undefined) updates.focusAreas = patch.focusAreas;
    if (patch.customInstructions !== undefined)
      updates.customInstructions = patch.customInstructions;
    if (patch.schedule !== undefined) updates.schedule = patch.schedule;
    if (patch.approvalMode !== undefined) updates.approvalMode = patch.approvalMode;
    if (patch.maxProposals !== undefined) updates.maxProposals = patch.maxProposals;
    if (patch.excludeCategories !== undefined) updates.excludeCategories = patch.excludeCategories;
    if (patch.promptTemplate !== undefined) updates.promptTemplate = patch.promptTemplate;
    if (patch.reindexPromptTemplate !== undefined)
      updates.reindexPromptTemplate = patch.reindexPromptTemplate;
    if (patch.knowledge !== undefined) updates.knowledge = patch.knowledge;
    if (patch.memory !== undefined) updates.memory = patch.memory;

    const [updated] = await db.update(agents).set(updates).where(eq(agents.id, id)).returning();
    if (!updated) throw notFound('agent not found');

    return c.json(updated);
  },
);

agentRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [existing] = await db
      .select({ id: agents.id, projectId: agents.projectId })
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    if (!existing) throw notFound('agent not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner' && access.role !== 'admin') {
      throw forbidden('insufficient permission');
    }

    await db.delete(agents).where(eq(agents.id, id));
    return c.body(null, 204);
  },
);
