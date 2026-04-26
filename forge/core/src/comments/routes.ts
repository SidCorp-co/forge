import { zValidator } from '@hono/zod-validator';
import { asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { commentMentions, comments, issues } from '../db/schema.js';
import { paginationSchema, setTotalCount } from '../lib/pagination.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { pgConstraintName, pgErrorCode } from './error-mapping.js';
import { parseMentions, resolveMentions } from './mentions.js';
import { type CommentRow, buildCommentTree } from './tree.js';

const commentCreateSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000),
    parentId: z.uuid().optional(),
  })
  .strict();

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
      body: comments.body,
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
    zValidator('json', commentCreateSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body, parentId } = c.req.valid('json');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

      if (parentId) {
        const [parent] = await db
          .select({ id: comments.id, issueId: comments.issueId })
          .from(comments)
          .where(eq(comments.id, parentId))
          .limit(1);
        if (!parent) throw notFound('parent comment not found');
        if (parent.issueId !== issueId) {
          throw new HTTPException(400, {
            message: 'parent comment belongs to a different issue',
            cause: { code: 'PARENT_MISMATCH' },
          });
        }
      }

      let inserted: CommentRow | undefined;
      try {
        const rows = await db
          .insert(comments)
          .values({ issueId, authorId: userId, body, parentId: parentId ?? null })
          .returning({
            id: comments.id,
            issueId: comments.issueId,
            authorId: comments.authorId,
            body: comments.body,
            parentId: comments.parentId,
            createdAt: comments.createdAt,
            updatedAt: comments.updatedAt,
          });
        inserted = rows[0];
      } catch (err) {
        const pgCode = pgErrorCode(err);
        // 23514: depth-trigger check_violation (parent chain too deep).
        if (pgCode === '23514') {
          throw new HTTPException(400, {
            message: 'comment depth exceeds 3',
            cause: { code: 'DEPTH_EXCEEDED' },
          });
        }
        // 23503: an FK violated. The comments INSERT touches three FKs
        // (parent_id, issue_id, author_id) — only remap the parent_id case
        // to 404 PARENT_NOT_FOUND (the TOCTOU window between our SELECT and
        // INSERT). issue_id / author_id violations from concurrent deletes
        // bubble up unchanged so callers see the real failure.
        if (pgCode === '23503' && parentId) {
          const constraint = pgConstraintName(err);
          if (constraint === 'comments_parent_id_fk') {
            throw notFound('parent comment not found');
          }
        }
        throw err;
      }
      if (!inserted) throw new Error('comments: insert returned no row');
      await hooks.emit('commentCreated', {
        issueId,
        projectId: issue.projectId,
        actor: { type: 'user', id: userId },
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });

      // Parse + persist mentions outside the insert transaction. A failure
      // here must not roll back the comment — log and continue. The hook
      // fan-out (notification rows + WS) is fire-and-forget the same way.
      const insertedId = inserted.id;
      try {
        const handles = parseMentions(inserted.body);
        if (handles.length > 0) {
          const resolved = await resolveMentions(handles, issue.projectId);
          // Skip self-mention. Unknown handles already dropped by resolver.
          const targets = resolved.filter((r) => r.userId !== userId);
          if (targets.length > 0) {
            await db
              .insert(commentMentions)
              .values(targets.map((t) => ({ commentId: insertedId, userId: t.userId })))
              .onConflictDoNothing();
            await hooks.emit('commentMentioned', {
              issueId,
              projectId: issue.projectId,
              commentId: insertedId,
              actor: { type: 'user', id: userId },
              mentionedUserIds: targets.map((t) => t.userId),
            });
          }
        }
      } catch (err) {
        logger.error({ err, commentId: insertedId }, 'comment mention fan-out failed');
      }

      return c.json(inserted, 201);
    },
  );

  router.get(
    '/:id/comments',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    // Validate (and ignore) legacy ?limit/?offset params. The endpoint now
    // returns a tree, but pre-existing flat-list clients still send them and
    // a contract break would 500-loop them. The HARD_CAP below replaces the
    // old `limit` semantics; pagination on a tree happens via /:id/replies.
    zValidator('query', paginationSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

      // Single fetch of every comment on the issue. Depth is bounded to 3 by
      // the DB trigger; cap breadth defensively so a runaway issue can't OOM
      // the server. Pagination on a tree is awkward — if the cap is hit the
      // client should switch to lazy-loading via /api/comments/:id/replies.
      const COMMENT_TREE_HARD_CAP = 1000;
      const [{ n: total } = { n: 0 }] = await db
        .select({ n: count() })
        .from(comments)
        .where(eq(comments.issueId, issueId));
      const rows = await db
        .select({
          id: comments.id,
          issueId: comments.issueId,
          authorId: comments.authorId,
          body: comments.body,
          parentId: comments.parentId,
          createdAt: comments.createdAt,
          updatedAt: comments.updatedAt,
        })
        .from(comments)
        .where(eq(comments.issueId, issueId))
        .orderBy(asc(comments.createdAt))
        .limit(COMMENT_TREE_HARD_CAP);

      const tree = buildCommentTree(rows);
      // Report the true total so paginating clients see the real comment
      // count even when the response payload was truncated to the cap.
      setTotalCount(c, Number(total));
      return c.json(tree);
    },
  );
}

export const commentRoutes = new Hono<{ Variables: AuthVars }>();
commentRoutes.use('*', requireAuth(), assertEmailVerified());

commentRoutes.get(
  '/:id/replies',
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', paginationSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit, offset } = c.req.valid('query');
    const userId = c.get('userId');

    const parent = await loadComment(id);
    const access = await loadProjectAccess(parent.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(comments)
      .where(eq(comments.parentId, id));

    const rows = await db
      .select({
        id: comments.id,
        issueId: comments.issueId,
        authorId: comments.authorId,
        body: comments.body,
        parentId: comments.parentId,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
      })
      .from(comments)
      .where(eq(comments.parentId, id))
      .orderBy(asc(comments.createdAt))
      .limit(limit)
      .offset(offset);

    setTotalCount(c, Number(n));
    return c.json(rows);
  },
);

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
    await hooks.emit('commentUpdated', {
      issueId: updated.issueId,
      projectId: comment.projectId,
      actor: { type: 'user', id: userId },
      commentId: updated.id,
      before: comment.body ?? '',
      after: updated.body,
    });
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
    await hooks.emit('commentDeleted', {
      issueId: comment.issueId,
      projectId: comment.projectId,
      actor: { type: 'user', id: userId },
      commentId: comment.id,
    });
    return c.body(null, 204);
  },
);
