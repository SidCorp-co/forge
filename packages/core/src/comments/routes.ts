import { zValidator } from '@hono/zod-validator';
import { asc, count, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { commentAttachments, commentMentions, comments, issues } from '../db/schema.js';
import type { ActorRef } from '../issues/actor-identity.js';
import { resolveActors } from '../issues/actor-resolution.js';
import { setInertAttachmentHeaders } from '../lib/attachment-headers.js';
import { assertProjectRole, loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import { listResponse, paginationSchema, wholeList } from '../lib/pagination.js';
import { logger } from '../logger.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { requireAnyAuth } from '../middleware/require-any-auth.js';
import { hooks } from '../pipeline/hooks.js';
import { getStorage, isEnoent } from '../storage/index.js';
import { AttachmentError, persistCommentAttachment } from './attachment-service.js';
import {
  commentBodySchema,
  commentCreateSchema,
  prepareCommentBody,
  rethrowBodyInvalid,
} from './body-input.js';
import { pgConstraintName, pgErrorCode } from './error-mapping.js';
import { parseMentions, resolveMentions } from './mentions.js';
import { updateCommentBody } from './service.js';
import {
  attachAuthors,
  buildCommentTree,
  type CommentAttachmentLite,
  type CommentRow,
} from './tree.js';

/** The comment projection every REST response here shares. */
const restCommentColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  isAi: comments.isAi,
  body: comments.body,
  format: comments.format,
  template: comments.template,
  parentId: comments.parentId,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

const idParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

// Distinct 400 shape for the attachment endpoints (moved from upload.ts) —
// preserves their original {message, code} response, separate from the
// {message:'Invalid input', cause:{code:'BAD_REQUEST', details}} shape the
// comment CRUD validators above already return.
const attachmentBadRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new HTTPException(400, { message, cause: { code, details } });

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
      const { body, format, parentId } = c.req.valid('json');
      const userId = c.get('userId');

      const issue = await loadIssue(issueId);
      const access = await loadProjectAccess(issue.projectId, userId);
      assertProjectRole(access, 'member');

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

      const prepared = prepareCommentBody({ raw: body, format });
      let inserted: CommentRow | undefined;
      try {
        const rows = await db
          .insert(comments)
          // cm:guard stamp `isAi` from the caller's AGENCY, and do NOT hardcode it either way: this route serves a person in a browser and an agent holding a job PAT through the same door, so the MCP rule ("every write here is automated") is false here and the default (`false`) is false for the agent. Measured 2026-09-02 with `forge-runner api issues/<id>/comments`: the row landed `is_ai=false, author_device_id=null`, which is exactly the tuple the `comments.is_ai` guard defines as a HUMAN — an agent comment rendering as a person's on the very path ISS-894 is migrating everything onto.
          .values({
            issueId,
            authorId: userId,
            body: prepared.body,
            format: prepared.format,
            template: prepared.template,
            parentId: parentId ?? null,
            isAi: c.get('agency') === 'agent',
          })
          .returning(restCommentColumns);
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
        actor: restActor(c),
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
              actor: restActor(c),
              mentionedUserIds: targets.map((t) => t.userId),
            });
          }
        }
      } catch (err) {
        logger.error({ err, commentId: insertedId }, 'comment mention fan-out failed');
      }

      // cm:guard ISS-898 — surface `prepared.warnings` here, the same as the PATCH half below and both MCP actions: a strip the gate performed and the transport swallowed is a body the caller believes they wrote. AC 6/7 measure this response, not the stored row.
      return c.json(
        prepared.warnings.length > 0 ? { ...inserted, warnings: prepared.warnings } : inserted,
        201,
      );
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
      if (!access.role) throw forbidden('not a project member');

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
        .select(restCommentColumns)
        .from(comments)
        .where(eq(comments.issueId, issueId))
        .orderBy(asc(comments.createdAt))
        .limit(COMMENT_TREE_HARD_CAP);

      // Join each comment's attachments in a single grouped query, keyed by
      // commentId. Guard the empty-ids case so `inArray` never receives an
      // empty list (which would build a malformed/`false` predicate).
      const attachmentsByCommentId = new Map<string, CommentAttachmentLite[]>();
      const commentIds = rows.map((r) => r.id);
      if (commentIds.length > 0) {
        const attachmentRows = await db
          .select({
            id: commentAttachments.id,
            commentId: commentAttachments.commentId,
            name: commentAttachments.name,
            mime: commentAttachments.mime,
            size: commentAttachments.size,
            createdAt: commentAttachments.createdAt,
          })
          .from(commentAttachments)
          .where(inArray(commentAttachments.commentId, commentIds))
          .orderBy(asc(commentAttachments.createdAt));
        for (const a of attachmentRows) {
          const list = attachmentsByCommentId.get(a.commentId) ?? [];
          list.push({
            id: a.id,
            name: a.name,
            mime: a.mime,
            size: a.size,
            createdAt: a.createdAt,
            url: `/api/comments/attachments/${a.id}`,
          });
          attachmentsByCommentId.set(a.commentId, list);
        }
      }

      const tree = buildCommentTree(rows, attachmentsByCommentId);

      // Resolve every comment's author to a display identity (email for a
      // human, device name + agent marker for an agent comment) so the UI never
      // has to guess from the project-members list or render a raw UUID. An
      // authorDeviceId routes to the device actor; otherwise the human author.
      const refs: ActorRef[] = rows.map((r) =>
        r.authorDeviceId
          ? { type: 'device', id: r.authorDeviceId }
          : { type: 'user', id: r.authorId },
      );
      attachAuthors(tree, await resolveActors(refs));

      // cm:guard this list is capped, NOT paginated — there is no limit/offset to page with, so it answers the header form and `total` is the real comment count rather than the capped tree's size. Handing it `listResponse` would state an `offset` and a `hasMore` that no caller can act on.
      return c.json(wholeList(c, tree, Number(total)));
    },
  );
}

function attachmentErrorToHttp(err: AttachmentError): HTTPException {
  switch (err.code) {
    case 'FILE_TOO_LARGE':
      return new HTTPException(400, {
        message: 'file too large',
        cause: { code: 'FILE_TOO_LARGE' },
      });
    case 'MIME_NOT_ALLOWED':
      return new HTTPException(400, {
        message: err.message,
        cause: { code: 'MIME_NOT_ALLOWED' },
      });
    case 'EMPTY_FILE':
      return new HTTPException(400, { message: 'empty file', cause: { code: 'BAD_REQUEST' } });
    case 'INVALID_NAME':
      return new HTTPException(400, { message: err.message, cause: { code: 'BAD_REQUEST' } });
  }
}

const commentIdParamSchema = z.object({ commentId: z.uuid() });

// NOTE: no `commentRoutes.use('*', ...)` wildcard here — ISS-706. A router-wide
// wildcard on this Hono instance would also run for every path Hono merges in
// from a second router mounted at the same `/api/comments` prefix (Hono
// flattens use('*') from BOTH routers into one linear chain at that prefix),
// so a strict JWT-only wildcard here would shadow a sibling router's more
// permissive per-route auth before it ever runs. Each route below carries its
// own auth middleware instead.
export const commentRoutes = new Hono<{ Variables: AuthVars }>();

commentRoutes.get(
  '/:id/replies',
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
      .select(restCommentColumns)
      .from(comments)
      .where(eq(comments.parentId, id))
      .orderBy(asc(comments.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json(listResponse(c, rows, Number(n), { limit, offset }));
  },
);

commentRoutes.patch(
  '/:id',
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
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      if (!projectRoleAtLeast(access.role, 'admin')) {
        throw forbidden('not comment author or project admin');
      }
    }

    let written: Awaited<ReturnType<typeof updateCommentBody>>;
    try {
      written = await updateCommentBody(id, { body, format });
    } catch (err) {
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
    return c.json(warnings.length > 0 ? { ...updated, warnings } : updated);
  },
);

commentRoutes.delete(
  '/:id',
  requireAuth(),
  assertEmailVerified(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const comment = await loadComment(id);
    if (comment.authorId !== userId) {
      const access = await loadProjectAccess(comment.projectId, userId);
      if (!projectRoleAtLeast(access.role, 'admin')) {
        throw forbidden('not comment author or project admin');
      }
    }

    await db.delete(comments).where(eq(comments.id, id));
    await hooks.emit('commentDeleted', {
      issueId: comment.issueId,
      projectId: comment.projectId,
      actor: restActor(c),
      commentId: comment.id,
    });
    return c.body(null, 204);
  },
);

/**
 * Comment attachment endpoints. Accept user JWT (web upload), PAT, or device
 * token (MCP runners post screenshots from forge-clarify / forge-test /
 * forge-review) via `requireAnyAuth()` — deliberately per-route, NOT a
 * router-wide wildcard (see the comment above `commentRoutes`).
 */
commentRoutes.post(
  '/:commentId/attachments',
  requireAnyAuth(),
  // Reject the request before parseBody buffers the entire payload — this
  // caps memory regardless of file size.
  bodyLimit({
    maxSize: env.UPLOADS_MAX_BYTES,
    onError: () => {
      throw attachmentBadRequest('file too large', 'FILE_TOO_LARGE');
    },
  }),
  zValidator('param', commentIdParamSchema, (r) => {
    if (!r.success)
      throw attachmentBadRequest('invalid commentId', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { commentId } = c.req.valid('param');
    const userId = c.get('userId');

    const [comment] = await db
      .select({ id: comments.id, issueId: comments.issueId, projectId: issues.projectId })
      .from(comments)
      .innerJoin(issues, eq(issues.id, comments.issueId))
      .where(eq(comments.id, commentId))
      .limit(1);
    if (!comment) throw notFound('comment not found');

    const access = await loadProjectAccess(comment.projectId, userId);
    assertProjectRole(access, 'member');

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw attachmentBadRequest('missing "file" field');
    const mime = file.type || 'application/octet-stream';
    const buffer = Buffer.from(await file.arrayBuffer());

    let persisted: Awaited<ReturnType<typeof persistCommentAttachment>>;
    try {
      persisted = await persistCommentAttachment({
        commentId: comment.id,
        name: file.name || 'file',
        mime,
        bytes: buffer,
        uploaderId: userId,
        uploaderDeviceId: null,
      });
    } catch (err) {
      if (err instanceof AttachmentError) throw attachmentErrorToHttp(err);
      throw err;
    }

    return c.json(persisted, 201);
  },
);

commentRoutes.get(
  '/attachments/:id',
  requireAnyAuth(),
  zValidator('param', idParamSchema, (r) => {
    if (!r.success)
      throw attachmentBadRequest('invalid id', 'BAD_REQUEST', z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const [row] = await db
      .select({
        id: commentAttachments.id,
        path: commentAttachments.path,
        mime: commentAttachments.mime,
        name: commentAttachments.name,
        projectId: issues.projectId,
      })
      .from(commentAttachments)
      .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
      .innerJoin(issues, eq(issues.id, comments.issueId))
      .where(eq(commentAttachments.id, id))
      .limit(1);
    if (!row) throw notFound('attachment not found');

    const access = await loadProjectAccess(row.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    let buffer: Buffer;
    try {
      buffer = await getStorage().get(row.path);
    } catch (err) {
      if (isEnoent(err)) {
        throw new HTTPException(410, {
          message: 'attachment file missing on disk',
          cause: { code: 'ATTACHMENT_FILE_MISSING' },
        });
      }
      throw err;
    }
    setInertAttachmentHeaders(c, row.mime, row.name);
    return c.body(new Uint8Array(buffer));
  },
);
