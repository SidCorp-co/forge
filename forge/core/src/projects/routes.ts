import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { labels, projectMembers, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const createProjectSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, or hyphens')
    .min(3)
    .max(64),
  name: z.string().trim().min(1).max(200),
});

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    agentConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    webhookSecret: z.string().min(16).max(128).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const idParamSchema = z.object({
  id: z.uuid(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, {
    message: 'Invalid input',
    cause: { code: 'BAD_REQUEST', details },
  });

const notFound = () =>
  new HTTPException(404, { message: 'project not found', cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function loadMembership(projectId: string, userId: string) {
  const [project] = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw notFound();

  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);

  return { project, role: member?.role ?? null };
}

export const projectRoutes = new Hono<{ Variables: AuthVars }>();

projectRoutes.use('*', requireAuth(), assertEmailVerified());

projectRoutes.post(
  '/',
  zValidator('json', createProjectSchema, (result) => {
    if (!result.success) {
      throw badRequest(z.flattenError(result.error));
    }
  }),
  async (c) => {
    const { slug, name } = c.req.valid('json');
    const userId = c.get('userId');

    try {
      const created = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(projects)
          .values({ slug, name, ownerId: userId })
          .returning({
            id: projects.id,
            slug: projects.slug,
            name: projects.name,
            ownerId: projects.ownerId,
            createdAt: projects.createdAt,
          });
        const project = inserted[0];
        if (!project) {
          throw new Error('projects: insert returned no row');
        }

        await tx.insert(projectMembers).values({
          userId,
          projectId: project.id,
          role: 'owner',
        });

        return project;
      });

      return c.json(created, 201);
    } catch (err: unknown) {
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: 'slug already taken',
          cause: { code: 'SLUG_TAKEN' },
        });
      }
      throw err;
    }
  },
);

projectRoutes.get('/', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      ownerId: projects.ownerId,
      role: projectMembers.role,
      createdAt: projects.createdAt,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId));

  return c.json(rows);
});

projectRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { role } = await loadMembership(id, userId);
    if (!role) throw forbidden('not a project member');

    const [project] = await db
      .select({
        id: projects.id,
        slug: projects.slug,
        name: projects.name,
        ownerId: projects.ownerId,
        agentConfig: projects.agentConfig,
        webhookSecret: projects.webhookSecret,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    if (!project) throw notFound();

    const members = await db
      .select({ userId: projectMembers.userId, role: projectMembers.role })
      .from(projectMembers)
      .where(eq(projectMembers.projectId, id));

    const labelRows = await db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(labels)
      .where(eq(labels.projectId, id));

    return c.json({ ...project, members, labels: labelRows });
  },
);

projectRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  zValidator('json', updateProjectSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner') {
      throw forbidden('not a project owner');
    }

    const updates: Record<string, unknown> = {};
    if (patch.name !== undefined) updates.name = patch.name;
    if (patch.agentConfig !== undefined) updates.agentConfig = patch.agentConfig;
    if (patch.webhookSecret !== undefined) updates.webhookSecret = patch.webhookSecret;

    const [updated] = await db.update(projects).set(updates).where(eq(projects.id, id)).returning({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      ownerId: projects.ownerId,
      agentConfig: projects.agentConfig,
      webhookSecret: projects.webhookSecret,
      createdAt: projects.createdAt,
    });
    if (!updated) throw notFound();

    return c.json(updated);
  },
);

projectRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (result) => {
    if (!result.success) throw badRequest(z.flattenError(result.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const { project, role } = await loadMembership(id, userId);
    if (project.ownerId !== userId && role !== 'owner') {
      throw forbidden('not a project owner');
    }

    await db.delete(projects).where(eq(projects.id, id));
    return c.body(null, 204);
  },
);
