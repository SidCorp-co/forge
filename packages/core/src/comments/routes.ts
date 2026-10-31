import { type CommentIntent, isCommentIntent } from '@forge/contracts/record-events';
import { Hono } from 'hono';
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
import { cursorList, listResponse, paginationSchema } from '../lib/pagination.js';
import { RefusalError } from '../lib/refusal.js';
import { projectLens } from '../messaging/record-screen.js';
import {
  type AuthVars,
  assertEmailVerified,
  requireAuth,
  restActor,
  restAuthored,
} from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import {
  clientCapabilities,
  declares,
  RECORD_ROUTE_CAPABILITY,
} from '../middleware/client-capabilities.js';
import { badRequest, forbidden, idParamSchema, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { commentAttachmentRoutes } from './attachment-routes.js';
import { commentCreateSchema, commentEditSchema } from './body-input.js';
import { type CommentCursor, decodeCommentCursor } from './cursor.js';
import { checkedIntent, correctCommentIntent, unchangedIntentRefusal } from './intent-edit.js';
import { postIssueComment } from './issue-comment.js';
import { attachmentsByComment, countIssueComments, listReplies, locateComment } from './read.js';
import {
  type CommentThreadRow,
  deleteComment,
  intentRefusal,
  updateCommentBody,
} from './service.js';
import { listIssueCommentPage } from './thread-read.js';
import { attachAuthors, buildCommentTree } from './tree.js';

/** The comment projection every REST response here shares. */

const threadQuerySchema = paginationSchema.extend({
  cursor: z.string().min(1).optional(),
  projectId: projectScopeQuerySchema.shape.projectId,
  intent: z.string().max(64).optional(),
});

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

export function registerIssueCommentRoutes(router: Hono<{ Variables: AuthVars }>): void {
  router.post(
    '/:id/comments',
    zValidator('param', idParamSchema),
    zValidator('json', commentCreateSchema),
    holdChatWrite('comment'),
    async (c) => {
      const { id: issueId } = c.req.valid('param');
      const { body, format, parentId, intent, decision, writtenLang } = c.req.valid('json');
      const written = await postIssueComment({
        issueId,
        authorId: c.get('userId'),
        authorDeviceId: c.get('patDeviceId') ?? null,
        body,
        format,
        parentId,
        intent,
        decision,
        writtenLang,
        declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
        announce: { actor: restActor(c), authored: restAuthored(c) },
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
  zValidator('json', commentEditSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { body, format, writtenLang, intent: sentIntent } = c.req.valid('json');
    const userId = c.get('userId');
    const intent = sentIntent === undefined ? undefined : checkedIntent(sentIntent);

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      requireHeld(access, 'project.admin', "changing another person's comment");
    }
    const unchanged = intent === undefined ? null : unchangedIntentRefusal(comment.intent, intent);
    if (unchanged) throw new RefusalError([unchanged], unchanged.code);

    let updated: CommentThreadRow | null = null;
    let warnings: string[] = [];
    if (body !== undefined) {
      const written = await updateCommentBody(id, {
        body,
        format,
        writtenLang,
        declaresRecordRoute: declares(clientCapabilities(c), RECORD_ROUTE_CAPABILITY),
        announce: {
          actor: restActor(c),
          projectId: comment.projectId,
          before: comment.body ?? '',
        },
      });
      if (!written) throw notFound('comment not found');
      updated = written.row;
      warnings = written.warnings;
    }
    if (intent !== undefined) {
      const corrected = await correctCommentIntent(id, intent, {
        actor: restActor(c),
        projectId: comment.projectId,
      });
      if (!corrected) throw notFound('comment not found');
      if ('code' in corrected) throw new RefusalError([corrected], corrected.code);
      updated = corrected;
    }
    if (!updated) throw notFound('comment not found');
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
