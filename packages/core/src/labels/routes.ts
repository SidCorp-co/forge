import { zValidator } from '@hono/zod-validator';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, labelKinds, labels } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import {
  assertDemotionIsLegal,
  assertParentIsForModule,
  assertParentIsLegal,
  autoModuleColor,
  ModuleHierarchyError,
} from './module-service.js';

const colorRegex = /^#[0-9a-f]{6}$/i;

// cm:guard `color` is optional ONLY because a module without one is auto-assigned below — the column stays NOT NULL, so a plain label still has to carry its own or the insert fails at the database with a message no caller can act on.
const labelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    color: z.string().regex(colorRegex, 'color must be #rrggbb hex').optional(),
    kind: z.enum(labelKinds).optional(),
    parentId: z.uuid().nullable().optional(),
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
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const projectIdParamSchema = z.object({ id: z.uuid() });
const labelIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const conflict = (message: string, code: string) =>
  new HTTPException(409, { message, cause: { code } });

// cm:guard every projection in this file must list the same columns — a route that omits `kind` answers a module as an indistinguishable plain label, and the client has no second call to tell them apart with.
const labelColumns = {
  id: labels.id,
  projectId: labels.projectId,
  name: labels.name,
  color: labels.color,
  kind: labels.kind,
  parentId: labels.parentId,
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
    const { name, color, kind, parentId, description } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    try {
      if (parentId) {
        assertParentIsForModule((kind ?? 'label') === 'module');
        await assertParentIsLegal(projectId, parentId, undefined);
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
          description: description ?? null,
        })
        .returning(labelColumns);
      if (!inserted) throw new Error('labels: insert returned no row');
      return c.json(inserted, 201);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('label name already taken in this project', 'LABEL_NAME_TAKEN');
      }
      throw err;
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
    try {
      if (nextParentId) assertParentIsForModule(nextKind === 'module');
      if (patch.parentId) await assertParentIsLegal(label.projectId, patch.parentId, id);
      if (nextKind === 'label' && label.kind === 'module') await assertDemotionIsLegal(id);
    } catch (err) {
      throw moduleError(err);
    }

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;
    if (patch.kind !== undefined) updates.kind = patch.kind;
    if (patch.parentId !== undefined) updates.parentId = patch.parentId;
    if (patch.description !== undefined) updates.description = patch.description;

    try {
      const [updated] = await db
        .update(labels)
        .set(updates)
        .where(eq(labels.id, id))
        .returning(labelColumns);
      if (!updated) throw notFound('label not found');
      return c.json(updated);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict('label name already taken in this project', 'LABEL_NAME_TAKEN');
      }
      throw err;
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
