import type { CommentRefusalCode } from '@forge/contracts/comments';
import { isCommentIntent } from '@forge/contracts/record-events';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ActorRef } from '../issues/actor-identity.js';
import { resolveActors } from '../issues/actor-resolution.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from '../issues/issue-route-ref.js';
import { mirroredEventsFor } from '../issues/record-events/store.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { cursorList, listResponse, paginationSchema } from '../lib/pagination.js';
import { refuser } from '../lib/refusal.js';
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
import { forbidden } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { commentAttachmentRoutes } from './attachment-routes.js';
import {
  bodyRefusalHttp,
  commentBodySchema,
  commentCreateSchema,
  rethrowBodyInvalid,
} from './body-input.js';
import { type CommentCursor, decodeCommentCursor } from './cursor.js';
import { pgConstraintName, pgErrorCode } from './error-mapping.js';
import {
  attachmentsByComment,
  countIssueComments,
  issueProjectOf,
  listReplies,
  locateComment,
  parentCommentOf,
} from './read.js';
import { messageRefusalHttp } from './screen.js';
import {
  deleteComment,
  insertComment,
  intentRefusal,
  listIssueCommentPage,
  updateCommentBody,
} from './service.js';
import { attachAuthors, buildCommentTree } from './tree.js';

const refuse = refuser<CommentRefusalCode>('COMMENT_REFUSED');

/** The comment projection every REST response here shares. */
const idParamSchema = z.object({ id: z.uuid() });

const threadQuerySchema = paginationSchema.extend({
  cursor: z.string().min(1).optional(),
  projectId: projectScopeQuerySchema.shape.projectId,
  intent: z.string().max(64).optional(),
});

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export async function loadIssue(issueId: string) {
  const row = await issueProjectOf(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

async function loadComment(commentId: string) {
  const located = await locateComment(commentId);
  if (!located) throw notFound('comment not found');
  if (located.onIssue) return located.onIssue;
  const place = located.elsewhere;
  const segment = { requirement: 'requirements', workflow: 'workflows', feedback: 'feedback' }[
    place.scope
  ];
  throw notFound(
    `comment ${commentId} sits on a ${place.scope}, not an issue: read and edit it at /api/projects/${place.projectId}/${segment}/${place.targetId}/comments`,
  );
}

const commentsShown = <T>(
  c: Parameters<typeof restActor>[0],
  projectId: string,
  rows: T,
  what: string,
) => egressForRequest(restActor(c).agency, projectId, 'issue.comments', rows, what);

export function registerIssueCommentRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/comments',
    zValidator('param', idParamSchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    zValidator('json', commentCreateSchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body, format, parentId, intent } = c.req.valid('json');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      requireHeld(access, 'project.write');

      if (parentId) {
        const parent = await parentCommentOf(parentId);
        if (!parent) throw notFound('parent comment not found');
        if (parent.issueId !== issueId) {
          throw new HTTPException(400, {
            message: 'parent comment belongs to a different issue',
            cause: { code: 'PARENT_MISMATCH' },
          });
        }
      }

      let written: Awaited<ReturnType<typeof insertComment>> | undefined;
      try {
        written = await insertComment({
          issueId,
          authorId: userId,
          authorDeviceId: c.get('patDeviceId') ?? null,
          body,
          format,
          parentId: parentId ?? null,
          declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
          intent,
          announce: { actor: restActor(c), authored: restAuthored(c) },
        });
      } catch (err) {
        const refusal = bodyRefusalHttp(err) ?? messageRefusalHttp(err);
        if (refusal) throw refusal;
        const pgCode = pgErrorCode(err);
        if (pgCode === '23514') {
          throw refuse(
            'COMMENT_DEPTH_EXCEEDED',
            'a reply sits at most 3 deep; reply to a comment higher in the thread',
            '/parentId',
          );
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

      return c.json(
        written.warnings.length > 0 ? { ...inserted, warnings: written.warnings } : inserted,
        201,
      );
    },
  );

  router.get(
    '/:id/comments',
    zValidator('param', issueRouteIdParamSchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    zValidator('query', threadQuerySchema, (r) => {
      if (!r.success) throw badRequest(r.error);
    }),
    async (c) => {
      const { id: rawId } = c.req.valid('param');
      const { limit, cursor, projectId: projectIdQuery, intent } = c.req.valid('query');
      const userId = c.get('userId');
      if (intent !== undefined && !isCommentIntent(intent)) {
        throw intentRefusal(intent);
      }

      const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
      const issueId = issue.id;

      let after: CommentCursor | undefined;
      if (cursor !== undefined) {
        const decoded = decodeCommentCursor(cursor);
        if ('invalid' in decoded) throw badRequest({ cursor: decoded.invalid });
        after = decoded;
      }

      const total = await countIssueComments(issueId, intent);
      const page = await listIssueCommentPage(issueId, { after, limit, intent });
      const rows = await commentsShown(c, issue.projectId, page.rows, `the comments on ${rawId}`);

      const commentIds = rows.map((r) => r.id);
      const attachmentsByCommentId = await attachmentsByComment(commentIds);

      const tree = buildCommentTree(
        rows,
        attachmentsByCommentId,
        await projectLens(issue.projectId),
        await mirroredEventsFor(issueId, commentIds),
      );

      const refs: ActorRef[] = rows.map((r) =>
        r.authorDeviceId
          ? { type: 'device', id: r.authorDeviceId }
          : { type: 'user', id: r.authorId },
      );
      attachAuthors(tree, await resolveActors(refs));

      return c.json(cursorList(c, tree, Number(total), { limit, nextCursor: page.nextCursor }));
    },
  );
}

export const commentRoutes = new Hono<{ Variables: AuthVars }>();

commentRoutes.get(
  '/:id/replies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', paginationSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { limit, offset } = c.req.valid('query');
    const userId = c.get('userId');

    const parent = await loadComment(id);
    const access = await loadProjectAccess(parent.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const page = await listReplies(id, limit, offset);
    const rows = await commentsShown(
      c,
      parent.projectId,
      page.rows,
      `the replies to comment ${id}`,
    );

    return c.json(listResponse(c, rows, page.total, { limit, offset }));
  },
);

commentRoutes.patch(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', commentBodySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body, format } = c.req.valid('json');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      requireHeld(access, 'project.admin', "changing another person's comment");
    }

    let written: Awaited<ReturnType<typeof updateCommentBody>>;
    try {
      written = await updateCommentBody(id, {
        body,
        format,
        declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
        announce: { actor: restActor(c), projectId: comment.projectId, before: comment.body ?? '' },
      });
    } catch (err) {
      const refusal = messageRefusalHttp(err);
      if (refusal) throw refusal;
      rethrowBodyInvalid(err);
    }
    if (!written) throw notFound('comment not found');
    const updated = written.row;
    const { warnings } = written;
    return c.json(warnings.length > 0 ? { ...updated, warnings } : updated);
  },
);

commentRoutes.delete(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      requireHeld(access, 'project.admin', "deleting another person's comment");
    }

    await deleteComment(id, {
      actor: restActor(c),
      issueId: comment.issueId,
      projectId: comment.projectId,
    });
    return c.body(null, 204);
  },
);

commentRoutes.route('/', commentAttachmentRoutes);

export { entityCommentRoutes } from './entity-routes.js';
