import { zValidator } from '@hono/zod-validator';
import { count, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';

const commentBodySchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
  })
  .strict();

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export async function loadIssue(issueId: string) {
  const [row] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw notFound('issue not found');
  return row;
}

async function loadComment(commentId: string) {
  const [row] = await db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      projectId: issues.projectId,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) throw notFound('comment not found');
  return row;
}

// Mounted on issueRoutes under /issues/:id/comments
export function registerIssueCommentRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/comments',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    zValidator('json', commentBodySchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body } = c.req.valid('json');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

      const [inserted] = await db
        .insert(comments)
        .values({ issueId, authorId: userId, body })
        .returning({
          id: comments.id,
          issueId: comments.issueId,
          authorId: comments.authorId,
          body: comments.body,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
        });
      if (!inserted) throw new Error('comments: insert returned no row');
      return c.json(inserted, 201);
    },
  );

  router.get(
    '/:id/comments',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    zValidator('query', paginationSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { limit, offset } = c.req.valid('query');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

      const [{ n } = { n: 0 }] = await db
        .select({ n: count() })
        .from(comments)
        .where(eq(comments.issueId, issueId));

      const rows = await db
        .select({
          id: comments.id,
          issueId: comments.issueId,
          authorId: comments.authorId,
          body: comments.body,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
        })
        .from(comments)
        .where(eq(comments.issueId, issueId))
        .orderBy(desc(comments.createdAt))
        .limit(limit)
        .offset(offset);

      setTotalCount(c, Number(n));
      return c.json(rows);
    },
  );
}

export const commentRoutes = new Hono<{ Variables: AuthVars }>();
commentRoutes.use('*', requireAuth(), assertEmailVerified());

commentRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', commentBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body } = c.req.valid('json');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      if (access.ownerId !== userId && access.role !== 'owner') {
        throw forbidden('not comment author or project owner');
      }
    }

    const [updated] = await db
      .update(comments)
      .set({ body, updatedAt: new Date() })
      .where(eq(comments.id, id))
      .returning({
        id: comments.id,
        issueId: comments.issueId,
        authorId: comments.authorId,
        body: comments.body,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
      });
    if (!updated) throw notFound('comment not found');
    return c.json(updated);
  },
);

commentRoutes.delete(
  '/:id',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      if (access.ownerId !== userId && access.role !== 'owner') {
        throw forbidden('not comment author or project owner');
      }
    }

    await db.delete(comments).where(eq(comments.id, id));
    return c.body(null, 204);
  },
);
