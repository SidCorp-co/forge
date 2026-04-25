import { zValidator } from '@hono/zod-validator';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { chatLogs, projectMembers, projects, qaRatings, users } from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const idParamSchema = z.object({ id: z.uuid() });

const listQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200).optional(),
    intent: z.string().min(1).max(100).optional(),
    source: z.string().min(1).max(100).optional(),
    qaRating: z.enum(qaRatings).optional(),
    dateFrom: z.coerce.date().optional(),
    dateTo: z.coerce.date().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

const recentQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const flaggedQuerySchema = z
  .object({
    projectSlug: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const patchSchema = z
  .object({
    qaRating: z.enum(qaRatings).nullable().optional(),
    qaNotes: z.string().max(10_000).nullable().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function resolveProjectIdBySlug(slug: string): Promise<string | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

async function assertChatLogAccess(
  projectSlug: string,
  userId: string,
  requireOwner = false,
): Promise<void> {
  const projectId = await resolveProjectIdBySlug(projectSlug);
  if (!projectId) throw notFound('project not found');
  const access = await loadProjectAccess(projectId, userId);
  if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');
  if (requireOwner && access.ownerId !== userId && access.role !== 'owner') {
    throw forbidden('only project owner can manage chat logs');
  }
}

export const chatLogRoutes = new Hono<{ Variables: AuthVars }>();
chatLogRoutes.use('*', requireAuth(), assertEmailVerified());

chatLogRoutes.get(
  '/',
  zValidator('query', listQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, intent, source, qaRating, dateFrom, dateTo, page, pageSize } =
      c.req.valid('query');
    const userId = c.get('userId');

    const conditions: SQL[] = [];

    if (projectSlug) {
      await assertChatLogAccess(projectSlug, userId);
      conditions.push(eq(chatLogs.projectSlug, projectSlug));
    } else {
      // Cross-project view: restrict to caller-visible projects.
      // CEO sees all; everyone else sees owned + member projects.
      // Pattern mirrors forge/core/src/projects/health-routes.ts.
      const [me] = await db
        .select({ id: users.id, isCeo: users.isCeo })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const visible = me?.isCeo
        ? await db.select({ slug: projects.slug }).from(projects)
        : await db
            .selectDistinct({ slug: projects.slug })
            .from(projects)
            .leftJoin(projectMembers, eq(projectMembers.projectId, projects.id))
            .where(sql`${projects.ownerId} = ${userId} OR ${projectMembers.userId} = ${userId}`);

      if (visible.length === 0) {
        return c.json({
          data: [],
          meta: { pagination: { page, pageSize, pageCount: 0, total: 0 } },
        });
      }

      conditions.push(inArray(chatLogs.projectSlug, visible.map((v) => v.slug)));
    }

    if (intent) conditions.push(eq(chatLogs.queryIntent, intent));
    if (source) conditions.push(eq(chatLogs.source, source));
    if (qaRating) conditions.push(eq(chatLogs.qaRating, qaRating));
    if (dateFrom) conditions.push(gte(chatLogs.createdAt, dateFrom));
    if (dateTo) conditions.push(lte(chatLogs.createdAt, dateTo));

    const offset = (page - 1) * pageSize;

    const [rows, [totalRow]] = await Promise.all([
      db
        .select()
        .from(chatLogs)
        .where(and(...conditions))
        .orderBy(desc(chatLogs.createdAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ n: count() })
        .from(chatLogs)
        .where(and(...conditions)),
    ]);

    const total = totalRow?.n ?? 0;
    return c.json({
      data: rows,
      meta: {
        pagination: {
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          total,
        },
      },
    });
  },
);

chatLogRoutes.get(
  '/recent',
  zValidator('query', recentQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, limit } = c.req.valid('query');
    const userId = c.get('userId');

    await assertChatLogAccess(projectSlug, userId);

    const rows = await db
      .select()
      .from(chatLogs)
      .where(eq(chatLogs.projectSlug, projectSlug))
      .orderBy(desc(chatLogs.createdAt))
      .limit(limit);

    return c.json(
      rows.map((r) => ({
        ...r,
        reply: r.reply && r.reply.length > 500 ? `${r.reply.slice(0, 500)}…` : r.reply,
      })),
    );
  },
);

chatLogRoutes.get(
  '/flagged',
  zValidator('query', flaggedQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { projectSlug, limit } = c.req.valid('query');
    const userId = c.get('userId');

    await assertChatLogAccess(projectSlug, userId);

    const rows = await db
      .select()
      .from(chatLogs)
      .where(
        and(
          eq(chatLogs.projectSlug, projectSlug),
          inArray(chatLogs.qaRating, ['bad', 'flagged']),
        ),
      )
      .orderBy(desc(chatLogs.createdAt))
      .limit(limit);

    return c.json(rows);
  },
);

chatLogRoutes.get(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db.select().from(chatLogs).where(eq(chatLogs.id, id)).limit(1);
    if (!row) throw notFound('chat log not found');

    await assertChatLogAccess(row.projectSlug, userId);
    return c.json(row);
  },
);

chatLogRoutes.patch(
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

    const [row] = await db
      .select({ id: chatLogs.id, projectSlug: chatLogs.projectSlug })
      .from(chatLogs)
      .where(eq(chatLogs.id, id))
      .limit(1);
    if (!row) throw notFound('chat log not found');

    await assertChatLogAccess(row.projectSlug, userId, /* requireOwner */ true);

    const updates: Record<string, unknown> = {};
    if (patch.qaRating !== undefined) updates.qaRating = patch.qaRating;
    if (patch.qaNotes !== undefined) updates.qaNotes = patch.qaNotes;

    const [updated] = await db
      .update(chatLogs)
      .set(updates)
      .where(eq(chatLogs.id, id))
      .returning();
    if (!updated) throw notFound('chat log not found');

    return c.json(updated);
  },
);

