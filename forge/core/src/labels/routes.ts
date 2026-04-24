import { zValidator } from '@hono/zod-validator';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { issueLabels, labels } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const colorRegex = /^#[0-9a-f]{6}$/i;

const labelCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    color: z.string().regex(colorRegex, 'color must be #rrggbb hex'),
  })
  .strict();

const labelPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    color: z.string().regex(colorRegex).optional(),
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
    const { name, color } = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw new HTTPException(403, {
        message: 'not a project owner',
        cause: { code: 'FORBIDDEN' },
      });
    }

    try {
      const [inserted] = await db.insert(labels).values({ projectId, name, color }).returning({
        id: labels.id,
        projectId: labels.projectId,
        name: labels.name,
        color: labels.color,
        createdAt: labels.createdAt,
      });
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
    if (!access.role && access.ownerId !== userId) {
      throw new HTTPException(403, {
        message: 'not a project member',
        cause: { code: 'FORBIDDEN' },
      });
    }

    const rows = await db
      .select({
        id: labels.id,
        projectId: labels.projectId,
        name: labels.name,
        color: labels.color,
        createdAt: labels.createdAt,
      })
      .from(labels)
      .where(eq(labels.projectId, projectId));

    return c.json(rows);
  },
);

export const labelRoutes = new Hono<{ Variables: AuthVars }>();
labelRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadLabel(labelId: string) {
  const [row] = await db
    .select({ id: labels.id, projectId: labels.projectId })
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
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw new HTTPException(403, {
        message: 'not a project owner',
        cause: { code: 'FORBIDDEN' },
      });
    }

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.color !== undefined) updates.color = patch.color;

    try {
      const [updated] = await db.update(labels).set(updates).where(eq(labels.id, id)).returning({
        id: labels.id,
        projectId: labels.projectId,
        name: labels.name,
        color: labels.color,
        createdAt: labels.createdAt,
      });
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
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw new HTTPException(403, {
        message: 'not a project owner',
        cause: { code: 'FORBIDDEN' },
      });
    }

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
