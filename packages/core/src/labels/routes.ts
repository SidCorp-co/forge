import { zValidator } from '@hono/zod-validator';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, labelKinds, labels } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  assertDemotionIsLegal,
  assertKnowledgeNodeIsForModule,
  assertKnowledgeNodeIsLegal,
  assertParentIsForModule,
  assertParentIsLegal,
  autoModuleColor,
  deriveModuleSlug,
  ModuleHierarchyError,
} from './module-service.js';
import { labelUniqueConflict } from './unique-conflicts.js';

const colorRegex = /^#[0-9a-f]{6}$/i;

// cm:guard `color` is optional ONLY because a module without one is auto-assigned below — the column stays NOT NULL, so a plain label still has to carry its own or the insert fails at the database with a message no caller can act on.
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
  // cm:guard `slug` is absent from BOTH schemas on purpose — it is the module's identity, derived once from the name, and a caller who could send it could also move it, which orphans the knowledge node every later tier resolves through it (ISS-947).
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const projectIdParamSchema = z.object({ id: z.uuid() });
const labelIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

// cm:guard a 23505 is reported by the index that fired, never as the name one — `labels/unique-conflicts.ts` owns that mapping and answers undefined for an index it does not know, which rethrows rather than mislabelling (ISS-947).
const uniqueConflict = (err: unknown): HTTPException | undefined => {
  const named = labelUniqueConflict(err);
  return named && conflict(named.message, named.code);
};

// cm:guard every projection in this file must list the same columns — a route that omits `kind` answers a module as an indistinguishable plain label, and one that omits `knowledgeEntryId` leaves `module-${slugify(name)}` as the only answer available to a caller asking which node a module owns, which is the name-prefix convention ISS-947 exists to replace.
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

const moduleError = (err: unknown) =>
  err instanceof ModuleHierarchyError
    ? new HTTPException(400, { message: err.message, cause: { code: err.code } })
    : err;

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
    assertProjectRole(access, 'admin', 'not a project admin');

    const isModule = (kind ?? 'label') === 'module';
    try {
      if (parentId) {
        assertParentIsForModule(isModule);
        await assertParentIsLegal(projectId, parentId, undefined);
      }
      if (knowledgeEntryId) {
        assertKnowledgeNodeIsForModule(isModule);
        await assertKnowledgeNodeIsLegal(projectId, knowledgeEntryId, undefined);
      }
    } catch (err) {
      throw moduleError(err);
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
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await db.select(labelColumns).from(labels).where(eq(labels.projectId, projectId));

    return c.json(rows);
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
    assertProjectRole(access, 'admin', 'not a project admin');

    // cm:guard judge the RESULTING row, not the patch — `kind` and `parentId` can move in the same request, so checking either alone lets a demotion keep its parent, or a new parent land on a row that is about to stop being a module
    const nextKind = patch.kind ?? label.kind;
    const nextParentId = patch.parentId !== undefined ? patch.parentId : label.parentId;
    const isPromotion = nextKind === 'module' && label.kind === 'label';
    const isDemotion = nextKind === 'label' && label.kind === 'module';
    try {
      if (nextParentId) assertParentIsForModule(nextKind === 'module');
      if (patch.parentId) await assertParentIsLegal(label.projectId, patch.parentId, id);
      if (patch.knowledgeEntryId) {
        assertKnowledgeNodeIsForModule(nextKind === 'module');
        await assertKnowledgeNodeIsLegal(label.projectId, patch.knowledgeEntryId, id);
      }
      if (isDemotion) await assertDemotionIsLegal(id);
    } catch (err) {
      throw moduleError(err);
    }

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;
    if (patch.kind !== undefined) updates.kind = patch.kind;
    if (patch.parentId !== undefined) updates.parentId = patch.parentId;
    if (patch.knowledgeEntryId !== undefined) updates.knowledgeEntryId = patch.knowledgeEntryId;
    if (patch.description !== undefined) updates.description = patch.description;
    // cm:guard the slug moves on exactly two edits and never on a rename — a promotion derives it (the CHECK requires a module to have one) and a demotion clears both module-only fields (the CHECK forbids a plain label from keeping them). A `name` patch deliberately leaves it alone: that is the whole point of storing it (ISS-947).
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
    assertProjectRole(access, 'admin', 'not a project admin');

    const [attached] = await db
      .select({ n: count() })
      .from(issueLabels)
      .where(eq(issueLabels.labelId, id));
    if ((attached?.n ?? 0) > 0) {
      throw conflict('label is attached to issues', 'LABEL_IN_USE');
    }

    await db.delete(labels).where(eq(labels.id, id));
    return c.body(null, 204);
  },
);
