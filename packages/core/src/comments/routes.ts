import type { CommentRefusalCode, DecisionFields } from '@forge/contracts/comments';
import { type CommentIntent, isCommentIntent } from '@forge/contracts/record-events';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ActorRef } from '../issues/index.js';
import {
  issueRouteIdParamSchema,
  mirroredEventsFor,
  projectScopeQuerySchema,
  resolveActors,
  resolveIssueRouteRef,
} from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { pgConstraintName, pgErrorCode } from '../lib/db-errors.js';
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
import { badRequest, forbidden, idParamSchema, notFound } from '../middleware/route-errors.js';
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
  decisionBody,
  deleteComment,
  insertComment,
  intentRefusal,
  updateCommentBody,
} from './service.js';
import { listIssueCommentPage } from './thread-read.js';
import { attachAuthors, buildCommentTree } from './tree.js';

const refuse = refuser<CommentRefusalCode>('COMMENT_REFUSED');

/** The comment projection every REST response here shares. */

const threadQuerySchema = paginationSchema.extend({
  cursor: z.string().min(1).optional(),
  projectId: projectScopeQuerySchema.shape.projectId,
  intent: z.string().max(64).optional(),
});

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

async function assertParentOnIssue(parentId: string, issueId: string): Promise<void> {
  const parent = await parentCommentOf(parentId);
  if (!parent) throw notFound('parent comment not found');
  if (parent.issueId !== issueId) {
    throw new HTTPException(400, {
      message: 'parent comment belongs to a different issue',
      cause: { code: 'PARENT_MISMATCH' },
    });
  }
}

/** A failed comment insert as the answer it owes: a body or message refusal, a reply nested too
 *  deep, a parent gone under it, or the error itself. */
function commentWriteRefusal(err: unknown, parentId: string | undefined): unknown {
  const refusal = bodyRefusalHttp(err) ?? messageRefusalHttp(err);
  if (refusal) return refusal;
  const pgCode = pgErrorCode(err);
  if (pgCode === '23514') {
    return refuse(
      'COMMENT_DEPTH_EXCEEDED',
      'a reply sits at most 3 deep; reply to a comment higher in the thread',
      '/parentId',
    );
  }
  if (pgCode === '23503' && parentId && pgConstraintName(err) === 'comments_parent_id_fk') {
    return notFound('parent comment not found');
  }
  return err;
}

/** One page of an issue's thread, shaped for its reader: egress, attachments, lens, authors. */
async function issueThreadPage(
  c: Parameters<typeof restActor>[0],
  issue: { id: string; projectId: string },
  rawId: string,
  page: { after: CommentCursor | undefined; limit: number; intent: CommentIntent | undefined },
) {
  const total = await countIssueComments(issue.id, page.intent);
  const read = await listIssueCommentPage(issue.id, page);
  const rows = await commentsShown(c, issue.projectId, read.rows, `the comments on ${rawId}`);
  const commentIds = rows.map((r) => r.id);
  const tree = buildCommentTree(
    rows,
    await attachmentsByComment(commentIds),
    await projectLens(issue.projectId),
    await mirroredEventsFor(issue.id, commentIds),
  );
  const refs: ActorRef[] = rows.map((r) =>
    r.authorDeviceId ? { type: 'device', id: r.authorDeviceId } : { type: 'user', id: r.authorId },
  );
  attachAuthors(tree, await resolveActors(refs));
  return { tree, total: Number(total), nextCursor: read.nextCursor };
}

/**
 * The body an issue comment is stored with: the one sent, or for a decision sent as fields only,
 * the fields written out, so every reader of the body (the thread, MCP, the CLI) reads the ruling.
 */
function issueCommentBody(
  sent: string | undefined,
  intent: string | undefined,
  decision: DecisionFields | undefined,
): string {
  if (decision && intent !== 'decision') {
    throw refuse(
      'COMMENT_DECISION_INTENT_MISMATCH',
      `decision fields belong to intent decision; this comment is ${intent ? `a ${intent}` : 'sent with no intent'}. Send intent: decision, or drop the decision fields`,
      '/decision',
    );
  }
  if (sent !== undefined) return sent;
  if (!decision) {
    throw refuse(
      'COMMENT_BODY_REQUIRED',
      'a comment carries a body: the sentence somebody is meant to read (a decision may send decision: { decision, reason } instead)',
      '/body',
    );
  }
  return decisionBody(decision);
}

export function registerIssueCommentRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/comments',
    zValidator('param', idParamSchema),
    zValidator('json', commentCreateSchema),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body: sent, format, parentId, intent, decision, writtenLang } = c.req.valid('json');
      const userId = c.get('userId');
      const body = issueCommentBody(sent, intent, decision);

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      requireHeld(access, 'project.write');

      if (parentId) await assertParentOnIssue(parentId, issueId);
      const written = await insertComment({
        issueId,
        authorId: userId,
        authorDeviceId: c.get('patDeviceId') ?? null,
        body,
        format,
        parentId: parentId ?? null,
        declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
        intent,
        decision: decision ?? null,
        writtenLang,
        announce: { actor: restActor(c), authored: restAuthored(c) },
      }).catch((err: unknown) => {
        throw commentWriteRefusal(err, parentId);
      });
      const inserted = written.row;

      return c.json(
        written.warnings.length > 0 ? { ...inserted, warnings: written.warnings } : inserted,
        201,
      );
    },
  );

  router.get(
    '/:id/comments',
    zValidator('param', issueRouteIdParamSchema),
    zValidator('query', threadQuerySchema),
    async (c) => {
      const { id: rawId } = c.req.valid('param');
      const { limit, cursor, projectId: projectIdQuery, intent } = c.req.valid('query');
      const userId = c.get('userId');
      if (intent !== undefined && !isCommentIntent(intent)) {
        throw intentRefusal(intent);
      }

      const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);

      let after: CommentCursor | undefined;
      if (cursor !== undefined) {
        const decoded = decodeCommentCursor(cursor);
        if ('invalid' in decoded) throw badRequest({ cursor: decoded.invalid });
        after = decoded;
      }

      const page = await issueThreadPage(c, issue, rawId, { after, limit, intent });
      return c.json(cursorList(c, page.tree, page.total, { limit, nextCursor: page.nextCursor }));
    },
  );
}

export const commentRoutes = new Hono<{ Variables: AuthVars }>();

commentRoutes.get(
  '/:id/replies',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema),
  zValidator('query', paginationSchema),
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
  zValidator('param', idParamSchema),
  zValidator('json', commentBodySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body, format, writtenLang } = c.req.valid('json');
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
        writtenLang,
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
  zValidator('param', idParamSchema),
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
