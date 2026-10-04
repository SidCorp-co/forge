import { count, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { LabelRefusalCode } from '@forge/contracts/labels';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, labelKinds, labels } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type RefusalError, refuser } from '../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { moduleDrift } from './module-drift.js';
import { DEFAULT_ACTIVE_WITHIN_DAYS } from './module-rollup.js';
import {
  assertDemotionIsLegal,
  assertKnowledgeNodeIsForModule,
  assertKnowledgeNodeIsLegal,
  assertParentIsForModule,
  assertParentIsLegal,
  autoModuleColor,
  deriveModuleSlug,
} from './module-service.js';
import { moduleDetailOf, moduleRollupWithStanding } from './module-standing-read.js';
import { labelUniqueConflict } from './unique-conflicts.js';
import { requireHeld } from '../permissions/index.js';

const colorRegex = /^#[0-9a-f]{6}$/i;

const labelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    color: z.string().regex(colorRegex, 'color must be #rrggbb hex').optional(),
    kind: z.enum(labelKinds).optional(),
    parentId: z.uuid().nullable().optional(),
    knowledgeEntryId: z.uuid().nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((o) => o.kind === 'module' || o.color !== undefined, {
    message: 'color is required for a plain label',
    path: ['color'],
  });

const labelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    color: z.string().regex(colorRegex).optional(),
    kind: z.enum(labelKinds).optional(),
    parentId: z.uuid().nullable().optional(),
    knowledgeEntryId: z.uuid().nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const projectIdParamSchema = z.object({ id: z.uuid() });

const rollupQuerySchema = z.object({
  activeWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
});
const labelIdParamSchema = z.object({ id: z.uuid() });
const moduleDetailParamSchema = z.object({
  id: z.uuid(),
  module: z.string().trim().min(1).max(128),
});

function viewerOf(c: Context<{ Variables: AuthVars }>) {
  const agency = c.get('agency');
  if (!agency) throw new Error('modules: a request reached its handler without an auth gate');
  return { userId: c.get('userId'), agency };
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const refuse = refuser<LabelRefusalCode>('LABEL_REFUSED');

const uniqueConflict = (err: unknown): RefusalError | undefined => {
  const named = labelUniqueConflict(err);
  return named && refuse(named.code, named.message);
};

const labelColumns = {
  id: labels.id,
  projectId: labels.projectId,
  name: labels.name,
  color: labels.color,
  kind: labels.kind,
  parentId: labels.parentId,
  slug: labels.slug,
  knowledgeEntryId: labels.knowledgeEntryId,
  description: labels.description,
  createdAt: labels.createdAt,
};

export const labelProjectRoutes = new Hono<{ Variables: AuthVars }>();
labelProjectRoutes.use('*', requireAuth(), assertEmailVerified());

labelProjectRoutes.post(
  '/:id/labels',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', labelCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { name, color, kind, parentId, knowledgeEntryId, description } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.admin');

    const isModule = (kind ?? 'label') === 'module';
    if (parentId) {
      assertParentIsForModule(isModule);
      await assertParentIsLegal(projectId, parentId, undefined);
    }
    if (knowledgeEntryId) {
      assertKnowledgeNodeIsForModule(isModule);
      await assertKnowledgeNodeIsLegal(projectId, knowledgeEntryId, undefined);
    }

    try {
      const [inserted] = await db
        .insert(labels)
        .values({
          projectId,
          name,
          color: color ?? autoModuleColor(name),
          kind: kind ?? 'label',
          parentId: parentId ?? null,
          slug: isModule ? await deriveModuleSlug(projectId, name) : null,
          knowledgeEntryId: knowledgeEntryId ?? null,
          description: description ?? null,
        })
        .returning(labelColumns);
      if (!inserted) throw new Error('labels: insert returned no row');
      return c.json(inserted, 201);
    } catch (err) {
      throw uniqueConflict(err) ?? err;
    }
  },
);

labelProjectRoutes.get(
  '/:id/labels',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    const rows = await db.select(labelColumns).from(labels).where(eq(labels.projectId, projectId));

    return c.json(rows);
  },
);

labelProjectRoutes.get(
  '/:id/modules/rollup',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', rollupQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { activeWithinDays } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(
      await moduleRollupWithStanding(
        projectId,
        activeWithinDays ?? DEFAULT_ACTIVE_WITHIN_DAYS,
        viewerOf(c),
      ),
    );
  },
);

labelProjectRoutes.get(
  '/:id/modules/:module/detail',
  zValidator('param', moduleDetailParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId, module } = c.req.valid('param');
    const access = await loadProjectAccess(projectId, c.get('userId'));
    requireHeld(access, 'project.read');
    return c.json(await moduleDetailOf(projectId, module, viewerOf(c)));
  },
);

const driftQuerySchema = z
  .object({ minCoOccurrence: z.coerce.number().int().min(1).max(1000).default(2) })
  .strict();

labelProjectRoutes.get(
  '/:id/modules/drift',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', driftQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const { minCoOccurrence } = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(await moduleDrift(projectId, { minCoOccurrence }));
  },
);

export const labelRoutes = new Hono<{ Variables: AuthVars }>();
labelRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadLabel(labelId: string) {
  const [row] = await db
    .select({
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      kind: labels.kind,
      parentId: labels.parentId,
    })
    .from(labels)
    .where(eq(labels.id, labelId))
    .limit(1);
  if (!row) throw notFound('label not found');
  return row;
}

labelRoutes.patch(
  '/:id',
  zValidator('param', labelIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', labelPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const label = await loadLabel(id);
    const access = await loadProjectAccess(label.projectId, userId);
    requireHeld(access, 'project.admin');

    const nextKind = patch.kind ?? label.kind;
    const nextParentId = patch.parentId !== undefined ? patch.parentId : label.parentId;
    const isPromotion = nextKind === 'module' && label.kind === 'label';
    const isDemotion = nextKind === 'label' && label.kind === 'module';
    if (nextParentId) assertParentIsForModule(nextKind === 'module');
    if (patch.parentId) await assertParentIsLegal(label.projectId, patch.parentId, id);
    if (patch.knowledgeEntryId) {
      assertKnowledgeNodeIsForModule(nextKind === 'module');
      await assertKnowledgeNodeIsLegal(label.projectId, patch.knowledgeEntryId, id);
    }
    if (isDemotion) await assertDemotionIsLegal(id);

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;
    if (patch.kind !== undefined) updates.kind = patch.kind;
    if (patch.parentId !== undefined) updates.parentId = patch.parentId;
    if (patch.knowledgeEntryId !== undefined) updates.knowledgeEntryId = patch.knowledgeEntryId;
    if (patch.description !== undefined) updates.description = patch.description;
    if (isPromotion)
      updates.slug = await deriveModuleSlug(label.projectId, patch.name ?? label.name);
    if (isDemotion) {
      updates.slug = null;
      updates.knowledgeEntryId = null;
    }

    try {
      const [updated] = await db
        .update(labels)
        .set(updates)
        .where(eq(labels.id, id))
        .returning(labelColumns);
      if (!updated) throw notFound('label not found');
      return c.json(updated);
    } catch (err) {
      throw uniqueConflict(err) ?? err;
    }
  },
);

labelRoutes.delete(
  '/:id',
  zValidator('param', labelIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const label = await loadLabel(id);
    const access = await loadProjectAccess(label.projectId, userId);
    requireHeld(access, 'project.admin');

    const [attached] = await db
      .select({ n: count() })
      .from(issueLabels)
      .where(eq(issueLabels.labelId, id));
    if ((attached?.n ?? 0) > 0) {
      throw refuse(
        'LABEL_IN_USE',
        'this label is attached to issues; detach it from every issue before deleting it',
      );
    }

    await db.delete(labels).where(eq(labels.id, id));
    return c.body(null, 204);
  },
);
