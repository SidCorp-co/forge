import { asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { answer } from '../api-reference/declare/describe.js';
import { zValidator } from '../api-reference/declare/validator.js';
import { db } from '../db/client.js';
import { commentMentions, comments, issues } from '../db/schema.js';
import type { ActorRef } from '../issues/actor-identity.js';
import { resolveActors } from '../issues/actor-resolution.js';
import { issueRouteIdParamSchema, resolveIssueRouteRef } from '../issues/issue-route-ref.js';
import { assertRoleFor, loadProjectAccess } from '../lib/authz.js';
import { pgConstraintName, pgErrorCode } from '../lib/db-errors.js';
import { cursorList, listResponse, paginationSchema } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { projectLens } from '../messaging/record-screen.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
  restAuthored,
} from '../middleware/auth.js';
import {
  clientCapabilities,
  declares,
  RECORD_ROUTE_CAPABILITY,
} from '../middleware/client-capabilities.js';
import { hooks } from '../pipeline/hooks.js';
import { commentAttachmentRoutes } from './attachment-routes.js';
import { listCommentAttachmentsForComments } from './attachment-service.js';
import {
  bodyRefusalHttp,
  commentBodySchema,
  commentCreateSchema,
  rethrowBodyInvalid,
} from './body-input.js';
import { CommentCursorInvalidError, decodeCommentCursor } from './cursor.js';
import { parseMentions, resolveMentions } from './mentions.js';
import {
  commentRepliesSchema,
  commentThreadSchema,
  createComment,
  deleteComment,
  listComments,
  listReplies,
  patchComment,
  threadQuerySchema,
  writtenCommentSchema,
} from './routes-reference.js';
import { messageRefusalHttp } from './screen.js';
import {
  assertMayChangeComment,
  CommentChangeForbidden,
  CommentParentRefused,
  commentThreadColumns,
  insertComment,
  listIssueCommentPage,
  deleteComment as removeComment,
  updateCommentBody,
} from './service.js';
import { attachAuthors, buildCommentTree } from './tree.js';

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

function rethrowChangeForbidden(err: unknown): never {
  if (err instanceof CommentChangeForbidden) throw forbidden(err.message);
  throw err;
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

export function registerIssueCommentRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/comments',
    createComment,
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    zValidator('json', commentCreateSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body, format, parentId } = c.req.valid('json');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      assertRoleFor(access, 'member', 'comment on its issues');

      let written: Awaited<ReturnType<typeof insertComment>> | undefined;
      try {
        written = await insertComment({
          issueId,
          authorId: userId,
          authorDeviceId: null,
          body,
          format,
          parentId: parentId ?? null,
          declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
        });
      } catch (err) {
        const refusal = bodyRefusalHttp(err) ?? messageRefusalHttp(err);
        if (refusal) throw refusal;
        if (err instanceof CommentParentRefused) {
          throw err.reason === 'not_found'
            ? notFound(err.message)
            : new HTTPException(400, {
                message: err.message,
                cause: { code: 'PARENT_MISMATCH' },
              });
        }
        const pgCode = pgErrorCode(err);
        if (pgCode === '23514') {
          throw new HTTPException(400, {
            message: 'comment depth exceeds 3',
            cause: { code: 'DEPTH_EXCEEDED' },
          });
        }
        if (pgCode === '23503' && parentId) {
          const constraint = pgConstraintName(err);
          if (constraint === 'comments_parent_id_fk') {
            throw notFound('parent comment not found');
          }
        }
        throw err;
      }
      const inserted = written.row;
      await hooks.emit('commentCreated', {
        issueId,
        projectId: issue.projectId,
        actor: restActor(c),
        authored: restAuthored(c),
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });

      const insertedId = inserted.id;
      try {
        const handles = parseMentions(inserted.body);
        if (handles.length > 0) {
          const resolved = await resolveMentions(handles, issue.projectId);
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
              actor: restActor(c),
              mentionedUserIds: targets.map((t) => t.userId),
            });
          }
        }
      } catch (err) {
        logger.error({ err, commentId: insertedId }, 'comment mention fan-out failed');
      }

      return c.json(
        answer(
          writtenCommentSchema,
          written.warnings.length > 0 ? { ...inserted, warnings: written.warnings } : inserted,
        ),
        201,
      );
    },
  );

  router.get(
    '/:id/comments',
    listComments,
    zValidator('param', issueRouteIdParamSchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    zValidator('query', threadQuerySchema, (r) => {
      if (!r.success) throw badRequest(z.flattenError(r.error));
    }),
    async (c) => {
      const { id: rawId } = c.req.valid('param');
      const { limit, cursor, projectId: projectIdQuery } = c.req.valid('query');
      const userId = c.get('userId');

      const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
      const issueId = issue.id;

      let after: ReturnType<typeof decodeCommentCursor> | undefined;
      if (cursor !== undefined) {
        try {
          after = decodeCommentCursor(cursor);
        } catch (err) {
          if (err instanceof CommentCursorInvalidError) throw badRequest({ cursor: err.message });
          throw err;
        }
      }

      const [{ n: total } = { n: 0 }] = await db
        .select({ n: count() })
        .from(comments)
        .where(eq(comments.issueId, issueId));
      const page = await listIssueCommentPage(issueId, { after, limit });
      const rows = page.rows;

      const attachmentsByCommentId = await listCommentAttachmentsForComments(rows.map((r) => r.id));

      const tree = buildCommentTree(
        rows,
        attachmentsByCommentId,
        await projectLens(issue.projectId),
      );

      const refs: ActorRef[] = rows.map((r) =>
        r.authorDeviceId
          ? { type: 'device', id: r.authorDeviceId }
          : { type: 'user', id: r.authorId },
      );
      attachAuthors(tree, await resolveActors(refs));

      return c.json(
        answer(
          commentThreadSchema,
          cursorList(c, tree, Number(total), { limit, nextCursor: page.nextCursor }),
        ),
      );
    },
  );
}

export const commentRoutes = new Hono<{ Variables: AuthVars }>();

commentRoutes.get(
  '/:id/replies',
  listReplies,
  requireAuth(),
  assertEmailVerified(),
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
    if (!access.role) throw forbidden('not a project member');

    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(comments)
      .where(eq(comments.parentId, id));

    const rows = await db
      .select(commentThreadColumns)
      .from(comments)
      .where(eq(comments.parentId, id))
      .orderBy(asc(comments.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json(
      answer(commentRepliesSchema, listResponse(c, rows, Number(n), { limit, offset })),
    );
  },
);

commentRoutes.patch(
  '/:id',
  patchComment,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', commentBodySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body, format } = c.req.valid('json');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    await assertMayChangeComment(userId, comment, 'edit this comment').catch(
      rethrowChangeForbidden,
    );

    let written: Awaited<ReturnType<typeof updateCommentBody>>;
    try {
      written = await updateCommentBody(id, {
        body,
        format,
        declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
      });
    } catch (err) {
      const refusal = messageRefusalHttp(err);
      if (refusal) throw refusal;
      rethrowBodyInvalid(err);
    }
    if (!written) throw notFound('comment not found');
    const updated = written.row;
    await hooks.emit('commentUpdated', {
      issueId: updated.issueId,
      projectId: comment.projectId,
      actor: restActor(c),
      commentId: updated.id,
      before: comment.body ?? '',
      after: updated.body,
    });
    const { warnings } = written;
    return c.json(
      answer(writtenCommentSchema, warnings.length > 0 ? { ...updated, warnings } : updated),
    );
  },
);

commentRoutes.delete(
  '/:id',
  deleteComment,
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    await assertMayChangeComment(userId, comment, 'delete this comment').catch(
      rethrowChangeForbidden,
    );

    await removeComment(id);
    await hooks.emit('commentDeleted', {
      issueId: comment.issueId,
      projectId: comment.projectId,
      actor: restActor(c),
      commentId: comment.id,
    });
    return c.body(null, 204);
  },
);

commentRoutes.route('/', commentAttachmentRoutes);
