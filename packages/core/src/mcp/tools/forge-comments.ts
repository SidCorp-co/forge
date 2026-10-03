import { z } from 'zod';
import { BodyInvalidError } from '../../body/errors.js';
import { BODY_FORMATS } from '../../body/formats.js';
import { bodyText } from '../../body/prepare.js';
import {
  listCommentAttachmentsForIssue,
  persistDecodedCommentAttachments,
} from '../../comments/attachment-service.js';
import { commentBodyField } from '../../comments/body-input.js';
import {
  CommentCursorInvalidError,
  decodeCommentCursor,
  encodeCommentCursor,
} from '../../comments/cursor.js';
import { pgConstraintName, pgErrorCode } from '../../comments/error-mapping.js';
import { messageRefused } from '../../comments/screen.js';
import {
  CommentIntentRefused,
  type CommentThreadRow,
  deleteComment,
  insertComment,
  listIssueCommentPage,
  loadCommentForAccess,
  loadIssueProjectId,
  updateCommentBody,
} from '../../comments/service.js';
import type { CommentAttachmentLite } from '../../comments/tree.js';
import { env } from '../../config/env.js';
import { isCommentIntent } from '../../issues/record-events/kinds.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import { egressShown } from '../../lib/data-egress.js';
import { hooks } from '../../pipeline/hooks.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  createEntity,
  entityDataFields,
  entityDeleteRefusal,
  entityTargetFields,
  listDecisions,
  listEntity,
  pickTarget,
  updateEntity,
} from './forge-comments-entity.js';
import {
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  type McpContext,
  principalAuthorDeviceId,
  principalHookActor,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope } from './list-envelope.js';

/**
 * An MCP caller has no channel to declare a capability: `tool.handler(args)`
 * in `mcp/server.ts` hands a tool its arguments and no request context. So a
 * record fence written through this door is warned and never refused — stated
 * here and in the `records-and-comments` guide rather than left to be found.
 */
const MCP_DECLARES_RECORD_ROUTE = false;

/**
 * Action-based parity port of the legacy Strapi MCP `forge_comments` tool.
 * Supports list/create/delete (the legacy tool only had list/create — delete
 * is additive and matches REST `DELETE /api/comments/:id`). See ISS-293.
 *
 * `documentId` is the comment UUID; `filters.issue` is the issue UUID.
 *
 * Authorship follows the credential: `authorId` is the account holding the
 * token, and `authorDeviceId` marks the comment as an agent's — the paired box
 * the token is bound to, so a person's own unbound PAT leaves it null. A
 * comment carries no self-declared "an agent wrote this" marker.
 */

const filtersSchema = z
  .object({
    issue: z.uuid().optional(),
    ...entityTargetFields,
    intent: z.string().max(64).optional(),
    scope: z.string().max(64).optional(),
  })
  .strict()
  .optional();

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

export const commentCreateDataSchema = z
  .object({
    body: commentBodyField.optional(),
    format: z.enum(BODY_FORMATS).optional(),
    issue: z.uuid().optional(),
    parentId: z.uuid().optional(),
    /** question | decision | note — checked by name in `comments/service.ts:resolveIntent`. */
    intent: z.string().max(64).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    ...entityDataFields,
  })
  .strict()
  .optional();

const inputSchema = z
  .object({
    action: z.enum(['list', 'create', 'update', 'delete', 'decisions']),
    projectId: z.uuid().optional(),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: commentCreateDataSchema,
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

type CommentRow = CommentThreadRow;

function serialize(
  row: CommentRow,
  attachments: CommentAttachmentLite[] = [],
): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    authorDeviceId: row.authorDeviceId ?? null,
    body: markUntrusted(row.body, { source: 'comment.body' }),
    format: row.format,
    text:
      row.format === 'html'
        ? markUntrusted(bodyText(row.body, row.format), { source: 'comment.text' })
        : null,
    parentId: row.parentId,
    intent: row.intent,
    scope: 'issue',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments,
  };
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeBase64Strict(input: string): Buffer | null {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
  if (!BASE64_RE.test(trimmed)) return null;
  return Buffer.from(trimmed, 'base64');
}

export const forgeCommentsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_comments',
  reach: 'project',
  grant: {
    byAction: {
      list: 'issues:read',
      decisions: 'issues:read',
      create: 'issues:write',
      update: 'issues:write',
      delete: 'issues:write',
    },
  },
  description:
    'List, create, update or delete comments. A comment sits on exactly one target: an issue (filters.issue / data.issue, a UUID), or a requirement (REQ-n), a workflow design (flow name or UUID) or a feedback item (FB-n) through filters.requirement | workflow | feedback and data.requirement | workflow | feedback, with projectId or the bound project; naming none or two is refused COMMENT_SCOPE_INVALID. ' +
    "On a requirement, workflow or feedback item: data.intent is required (question | decision | note), and a decision carries data.decision { decision, reason, options?, authority?, reversedWhen? } (COMMENT_DECISION_REQUIRED when missing), with data.body optional; such a comment is edited with update and never deleted (COMMENT_RECORD_KEPT). A decision there by an agent is a record, not an approval. Action decisions lists the project's decisions across every target, newest first (filters.scope, limit). On a no_egress project a feedback item's comments come back as metadata only. " +
    'EVERY list response carries `returned`, `limit`, `hasMore` and `nextCursor` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'To read a whole thread: call list, then pass the `nextCursor` you got back as `cursor`, and repeat until `nextCursor` is null. Each page carries the next top-level comments with their replies, so no comment is returned twice and none is skipped. The cursor is the SAME token the REST route `GET /api/issues/:id/comments` mints and accepts. ' +
    "Create requires data.issue + data.body, and takes data.intent: question (owed a reply), decision (pinned) or note; omitted, a person's comment is stored as question and an agent's as note, with a COMMENT_INTENT_DEFAULTED warning. List takes filters.intent. A structured record goes to forge_issue_events, not into a comment. Update requires documentId + data.body (use it to " +
    'place a <forge-artifact id="…"> once the attachment exists, or to correct a refused body). ' +
    'Delete requires documentId. All actions ' +
    'enforce project membership via the calling principal. Body shape — see guide writing-an-issue: outcome first, trace underneath; mermaid fences render, and an attached .html renders inline. ' +
    'Attachments: for anything bigger than a tiny snippet use the forge_uploads tool ' +
    '(presigned-URL pattern) instead of base64 — base64 in data.attachments[] is slow ' +
    'and burns context tokens. Workflow: (1) create the comment to get its id; (2) call ' +
    'forge_uploads {action:"request", data:{target:"comment", targetId:<id>, name:"<file>"}} ' +
    '→ get an uploadUrl; (3) `curl -X PUT -T <localPath> "<uploadUrl>"` (no auth header). ' +
    'The PUT returns {id,name,mime,size,url}. data.attachments[] (base64-inline; up to 10, ' +
    'total ≤ UPLOADS_MAX_BYTES) still works for tiny inline files and on partial-failure ' +
    'returns `attachments` (succeeded) + `attachmentErrors` (failed entries with code/message).',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    try {
      return await run(ctx, principal, input);
    } catch (err) {
      const refusal =
        err instanceof BodyInvalidError || err instanceof CommentIntentRefused
          ? err
          : messageRefused(err);
      if (refusal) {
        throw new Error(`BAD_REQUEST: ${refusal.code}: ${refusal.message}`);
      }
      throw err;
    }
  },
});

async function run(ctx: McpContext, principal: Principal, input: ToolInput): Promise<unknown> {
  if (input.action === 'decisions') {
    return listDecisions(ctx, principal, {
      projectId: input.projectId,
      scope: input.filters?.scope,
      limit: input.limit,
    });
  }
  if (input.action === 'list' || input.action === 'create') {
    const named = input.action === 'list' ? input.filters : input.data;
    const pick = pickTarget(named, input.action === 'list' ? '/filters' : '/data');
    if (pick.kind === 'refused') return pick.answer;
    if (pick.kind === 'entity' && input.action === 'list') {
      return listEntity(ctx, principal, pick, {
        projectId: input.projectId,
        intent: input.filters?.intent,
      });
    }
    if (pick.kind === 'entity') {
      return createEntity(ctx, principal, pick, {
        projectId: input.projectId,
        data: input.data ?? {},
      });
    }
  }
  if (input.action === 'update' && input.documentId) {
    const entity = await updateEntity(ctx, principal, input.documentId, input.data ?? {});
    if (entity) return entity;
  }
  if (input.action === 'delete' && input.documentId) {
    const kept = await entityDeleteRefusal(input.documentId);
    if (kept) return kept;
  }
  switch (input.action) {
    case 'list':
      return listAction(principal, input);

    case 'update':
      return updateAction(principal, input);

    case 'create': {
      const issueId = input.data?.issue;
      const body = input.data?.body;
      if (!issueId) throw new Error('BAD_REQUEST: data.issue is required for create');
      if (!body) throw new Error('BAD_REQUEST: data.body is required for create');

      const projectId = await loadIssueProjectId(issueId);
      await assertPrincipalIsWriter(principal, projectId);

      const rawAttachments = input.data?.attachments ?? [];
      const decoded: Array<{ name: string; mime: string; bytes: Buffer }> = [];
      if (rawAttachments.length > 0) {
        for (const [i, a] of rawAttachments.entries()) {
          const buf = decodeBase64Strict(a.dataBase64);
          if (!buf) {
            throw new Error(`BAD_REQUEST: data.attachments[${i}].dataBase64 is not valid base64`);
          }
          decoded.push({ name: a.name, mime: a.mime, bytes: buf });
        }
        const limit = env.UPLOADS_MAX_BYTES;
        const sizes = decoded.map((d) => d.bytes.byteLength);
        const total = sizes.reduce((s, n) => s + n, 0);
        const perFileBreakdown = sizes.map((n, i) => `${i}:${n}`).join(',');
        const oversizePer = sizes.some((n) => n > limit);
        if (total > limit || oversizePer) {
          throw new Error(
            `PAYLOAD_TOO_LARGE: total=${total} per=[${perFileBreakdown}] limit=${limit}`,
          );
        }
      }

      const authorDeviceId = principalAuthorDeviceId(principal);
      let inserted: CommentRow | undefined;
      let bodyWarnings: string[] = [];
      try {
        const written = await insertComment({
          issueId,
          authorId: principal.userId,
          authorDeviceId,
          body,
          format: input.data?.format,
          parentId: input.data?.parentId ?? null,
          declaresRecordRoute: MCP_DECLARES_RECORD_ROUTE,
          intent: input.data?.intent,
        });
        inserted = written.row;
        bodyWarnings = written.warnings;
      } catch (err) {
        if (
          pgErrorCode(err) === '23503' &&
          pgConstraintName(err) === 'comments_author_device_id_devices_id_fk'
        ) {
          throw new Error('BAD_REQUEST: no device bound to this principal');
        }
        throw err;
      }
      if (!inserted) throw new Error('comments: insert returned no row');

      await hooks.emit('commentCreated', {
        issueId,
        projectId,
        actor: principalHookActor(principal),
        authored: 'agent',
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });

      const { persisted: persistedAttachments, errors: attachmentErrors } =
        await persistDecodedCommentAttachments(
          inserted.id,
          decoded,
          principal.userId,
          authorDeviceId,
        );

      const result: Record<string, unknown> = serialize(inserted as CommentRow);
      result.attachments = persistedAttachments;
      if (bodyWarnings.length > 0) result.warnings = bodyWarnings;
      if (attachmentErrors.length > 0) {
        result.attachmentErrors = attachmentErrors;
      }
      return result;
    }

    case 'delete': {
      if (!input.documentId) {
        throw new Error('BAD_REQUEST: documentId is required for delete');
      }
      const comment = await loadCommentForAccess(input.documentId);

      await assertPrincipalIsWriter(principal, comment.projectId);
      if (comment.authorId !== principal.userId) {
        await assertCommentDeletePermission(principal.userId, comment.projectId);
      }

      await deleteComment(input.documentId);
      await hooks.emit('commentDeleted', {
        issueId: comment.issueId,
        projectId: comment.projectId,
        actor: principalHookActor(principal),
        commentId: comment.id,
      });

      return { documentId: input.documentId, status: 'deleted' };
    }
  }
}

type ToolInput = z.infer<typeof inputSchema>;
type Principal = Parameters<typeof assertPrincipalIsWriter>[0];

async function listAction(principal: Principal, input: ToolInput): Promise<unknown> {
  const issueId = input.filters?.issue;
  if (!issueId) throw new Error('BAD_REQUEST: filters.issue is required for list');
  const projectId = await loadIssueProjectId(issueId);
  await assertPrincipalIsWriter(principal, projectId);

  let after: ReturnType<typeof decodeCommentCursor> | undefined;
  if (input.cursor !== undefined) {
    try {
      after = decodeCommentCursor(input.cursor);
    } catch (err) {
      if (err instanceof CommentCursorInvalidError) {
        throw new Error(`BAD_REQUEST: cursor: ${err.message}`);
      }
      throw err;
    }
  }

  const intent = input.filters?.intent;
  if (intent !== undefined && !isCommentIntent(intent)) throw new CommentIntentRefused(intent);
  const commentsLimit = input.limit ?? 50;
  const read = await listIssueCommentPage(issueId, { after, limit: commentsLimit, intent });
  const page = {
    ...read,
    ...(await egressShown(
      projectId,
      'issue.comments',
      { rows: read.rows, roots: read.roots },
      `the comments on ${issueId}`,
    )),
  };
  const attachmentsByCommentId = await listCommentAttachmentsForIssue(issueId);

  const subtrees = groupBySubtree(page.rows, page.roots).map((rows) => ({
    rootId: (rows[0] as CommentThreadRow).id,
    rows: rows.map((r) => serialize(r as CommentRow, attachmentsByCommentId.get(r.id) ?? [])),
  }));

  const envelope = buildListEnvelope({
    key: 'comments',
    items: subtrees,
    limit: commentsLimit,
    hint: 'pass `nextCursor` back as `cursor`',
    order: 'asc',
    sizeTrimSheds: 'newest',
    cursor: {
      more: page.nextCursor !== null,
      of: (item) =>
        encodeCommentCursor({
          createdAtKey: page.cursorKeyById.get(item.rootId) as string,
          id: item.rootId,
        }),
    },
  });
  const flat = (envelope.comments as typeof subtrees).flatMap((s) => s.rows);
  envelope.comments = flat;
  envelope.returned = flat.length;
  return envelope;
}

/**
 * A page's rows split into one group per root, each group being the root
 * followed by its descendants in `createdAt` order.
 */
function groupBySubtree(rows: CommentThreadRow[], roots: CommentThreadRow[]): CommentThreadRow[][] {
  const groupOf = new Map<string, string>();
  for (const r of roots) groupOf.set(r.id, r.id);
  const groups = new Map<string, CommentThreadRow[]>(roots.map((r) => [r.id, [r]]));
  for (const r of rows) {
    if (r.parentId === null) continue;
    const owner = groupOf.get(r.parentId);
    if (owner === undefined) continue;
    groupOf.set(r.id, owner);
    groups.get(owner)?.push(r);
  }
  return roots.map((r) => groups.get(r.id) ?? [r]);
}

async function updateAction(principal: Principal, input: ToolInput): Promise<unknown> {
  if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
  const body = input.data?.body;
  if (!body) throw new Error('BAD_REQUEST: data.body is required for update');

  const comment = await loadCommentForAccess(input.documentId);
  await assertPrincipalIsWriter(principal, comment.projectId);

  const written = await updateCommentBody(input.documentId, {
    body,
    format: input.data?.format,
    declaresRecordRoute: MCP_DECLARES_RECORD_ROUTE,
  });
  if (!written) throw new Error('NOT_FOUND: comment not found');

  const result: Record<string, unknown> = serialize(written.row);
  if (written.warnings.length > 0) result.warnings = written.warnings;
  return result;
}

async function assertCommentDeletePermission(userId: string, projectId: string): Promise<void> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!projectRoleAtLeast(access.role, 'admin')) {
    throw new Error('FORBIDDEN: only the comment author or a project admin can delete');
  }
}
