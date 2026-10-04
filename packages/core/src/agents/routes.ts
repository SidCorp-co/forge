import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { agentApprovalModes } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { wholeList } from '../lib/pagination.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { agentById, listAgents } from './read.js';
import { createAgent, deleteAgent, patchAgent } from './service.js';

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
    requireHeld(access, 'project.read');

    const { rows, total } = await listAgents(projectId, { type, enabled });
    return c.json(wholeList(c, rows, total));
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
    requireHeld(access, 'project.write');

    const inserted = await createAgent({
      projectId: input.projectId,
      name: input.name,
      type: input.type,
      description: input.description ?? null,
      enabled: input.enabled ?? false,
      ...(input.focusAreas !== undefined ? { focusAreas: input.focusAreas } : {}),
      customInstructions: input.customInstructions ?? null,
      ...(input.approvalMode !== undefined ? { approvalMode: input.approvalMode } : {}),
      ...(input.maxProposals !== undefined ? { maxProposals: input.maxProposals } : {}),
      ...(input.excludeCategories !== undefined
        ? { excludeCategories: input.excludeCategories }
        : {}),
      promptTemplate: input.promptTemplate ?? null,
      reindexPromptTemplate: input.reindexPromptTemplate ?? null,
      knowledge: input.knowledge ?? null,
      memory: input.memory ?? null,
    });

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

    const row = await agentById(id);
    if (!row) throw notFound('agent not found');

    const access = await loadProjectAccess(row.projectId, userId);
    requireHeld(access, 'project.read');

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

    const existing = await agentById(id);
    if (!existing) throw notFound('agent not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    requireHeld(access, 'project.write');

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.type !== undefined) updates.type = patch.type;
    if (patch.description !== undefined) updates.description = patch.description;
    if (patch.enabled !== undefined) updates.enabled = patch.enabled;
    if (patch.focusAreas !== undefined) updates.focusAreas = patch.focusAreas;
    if (patch.customInstructions !== undefined)
      updates.customInstructions = patch.customInstructions;
    if (patch.approvalMode !== undefined) updates.approvalMode = patch.approvalMode;
    if (patch.maxProposals !== undefined) updates.maxProposals = patch.maxProposals;
    if (patch.excludeCategories !== undefined) updates.excludeCategories = patch.excludeCategories;
    if (patch.promptTemplate !== undefined) updates.promptTemplate = patch.promptTemplate;
    if (patch.reindexPromptTemplate !== undefined)
      updates.reindexPromptTemplate = patch.reindexPromptTemplate;
    if (patch.knowledge !== undefined) updates.knowledge = patch.knowledge;
    if (patch.memory !== undefined) updates.memory = patch.memory;

    const updated = await patchAgent(id, updates);
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

    const existing = await agentById(id);
    if (!existing) throw notFound('agent not found');

    const access = await loadProjectAccess(existing.projectId, userId);
    requireHeld(access, 'project.admin');

    await deleteAgent(id);
    return c.body(null, 204);
  },
);
