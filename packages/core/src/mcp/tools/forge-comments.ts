import { z } from 'zod';
import { BodyInvalidError } from '../../body/errors.js';
import { BODY_FORMATS } from '../../body/formats.js';
import { bodySlots, bodyText } from '../../body/prepare.js';
import {
  AttachmentError,
  listCommentAttachmentsForIssue,
  type PersistedCommentAttachment,
  persistCommentAttachment,
} from '../../comments/attachment-service.js';
import { pgConstraintName, pgErrorCode } from '../../comments/error-mapping.js';
import {
  type CommentThreadRow,
  deleteComment,
  insertComment,
  listIssueComments,
  loadCommentForAccess,
  loadIssueProjectId,
  updateCommentBody,
} from '../../comments/service.js';
import type { CommentAttachmentLite } from '../../comments/tree.js';
import { env } from '../../config/env.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import { hooks } from '../../pipeline/hooks.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  assertPrincipalIsWriter,
  type ContextScopedMcpToolFactory,
  principalAuthorDeviceId,
  principalHookActor,
  zodToMcpSchema,
} from './lib.js';
import { buildListEnvelope, overfetch } from './list-envelope.js';

/**
 * Action-based parity port of the legacy Strapi MCP `forge_comments` tool.
 * Supports list/create/delete (the legacy tool only had list/create — delete
 * is additive and matches REST `DELETE /api/comments/:id`). See ISS-293.
 *
 * `documentId` is the comment UUID; `filters.issue` is the issue UUID.
 *
 * Authorship follows the credential: `authorId` is the person whose token it
 * is, and `authorDeviceId` marks the comment as an agent's — resolved from the
 * `job:`/`session:` name a machine token carries, so a person's PAT leaves it
 * null. A comment carries no self-declared "an agent wrote this" marker.
 */

const filtersSchema = z.object({ issue: z.uuid() }).strict().optional();

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

// cm:edge contract -> packages/core/skills — shipped Markdown templates carry `forge_comments → create` examples an agent copies verbatim; this schema is `.strict()`, so a key in an example that is not here is a hard rejection at the agent's first call. `skills/shipped-templates.test.ts` parses every template against this export.
export const commentCreateDataSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    // cm:edge contract -> packages/core/src/body/formats.ts — ISS-898. OPTIONAL on purpose: every shipped template omits it and must keep working, and absent resolves to `markdown` in `prepareBody`. Adding a value here without teaching `prepareBody` a branch accepts a body no reader can render.
    format: z.enum(BODY_FORMATS).optional(),
    issue: z.uuid().optional(),
    parentId: z.uuid().optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
  })
  .strict()
  .optional();

const inputSchema = z
  .object({
    action: z.enum(['list', 'create', 'update', 'delete']),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: commentCreateDataSchema,
    limit: z.number().int().min(1).max(200).optional(),
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
    // cm:guard SECOND HALF IN forge-plugin `plugin/src/flow/earned.mjs` — `answered()` asks whether a PERSON replied after a park, and this field is what it asks with now that `is_ai` is gone: non-null means an agent wrote it. Drop it from this projection and every screen the driver parks on becomes unanswerable, because the agent's own comments would read as a person's. Since ISS-931 the value comes from the caller's `job:`/`session:` token rather than from a device principal, which is why a PAT-authored agent comment is marked at all — it never was before.
    authorDeviceId: row.authorDeviceId ?? null,
    // ISS-532: comment bodies are untrusted (anyone can post) and reach the
    // agent verbatim via this MCP surface — frame as DATA, never instructions.
    body: markUntrusted(row.body, { source: 'comment.body' }),
    format: row.format,
    template: row.template,
    // cm:guard ISS-898 — `slots` and `text` are what let a downstream skill read a field instead of a string prefix, and `text` is the projection the agent should reason over. Both go through markUntrusted for the same reason `body` does: a parsed slot is still text the reporter wrote.
    slots: row.template ? bodySlots(row.body, row.format) : null,
    text:
      row.format === 'html'
        ? markUntrusted(bodyText(row.body, row.format), { source: 'comment.text' })
        : null,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments,
  };
}

// Strict base64 charset check. Buffer.from('xx', 'base64') silently drops
// invalid characters, so we validate the input string first to surface a
// useful BAD_REQUEST instead of writing a truncated blob to disk.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeBase64Strict(input: string): Buffer | null {
  const trimmed = input.trim().replace(/\s+/g, '');
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return null;
  if (!BASE64_RE.test(trimmed)) return null;
  return Buffer.from(trimmed, 'base64');
}

export const forgeCommentsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_comments',
  description:
    'List, create, update or delete issue comments. List requires filters.issue (issue UUID). ' +
    'EVERY list response carries `returned`, `limit` and `hasMore` — read `hasMore` before reporting a count as complete, because a list bound by your own limit is otherwise indistinguishable from a complete one. `truncated`/`truncatedBy` say which cap bit. ' +
    'Create requires data.issue + data.body. Update requires documentId + data.body (use it to ' +
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

    // cm:guard a refused body must reach the agent as BAD_REQUEST with the ELEMENT, ATTRIBUTE and legal set still in the message. That named message is the whole reason this gate produces compliance where a guide produced 14-28%: an agent told only "invalid body" has nothing to change on its next call.
    try {
      return await run(principal, input);
    } catch (err) {
      if (err instanceof BodyInvalidError) {
        throw new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
      }
      throw err;
    }
  },
});

async function run(principal: Principal, input: ToolInput): Promise<unknown> {
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

      // Pre-decode + size-validate attachments BEFORE writing the comment row.
      // A size-cap rejection here returns PAYLOAD_TOO_LARGE without leaving an
      // empty comment behind.
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

      // cm:guard ISS-519 — `authorId` stays the human owner; `authorDeviceId` is the AGENT marker and is resolved from the caller's OWN TOKEN (`job:`/`session:` → the job's or session's `device_id`), never from a principal. A PAT's synthetic device id used to be the hazard here (ISS-638); since ISS-931 there is no synthetic device, and the hazard inverted — a null on an agent's comment makes it read as a person's to `answered()` in forge-plugin.
      const authorDeviceId = await principalAuthorDeviceId(principal);
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
        });
        inserted = written.row;
        bodyWarnings = written.warnings;
      } catch (err) {
        // 23503: FK violated. The branch above should make an author_device_id
        // violation unreachable, but guard defensively (e.g. a stale device
        // row) rather than surfacing a raw DB error to the caller.
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
        commentId: inserted.id,
        body: inserted.body,
        parentId: inserted.parentId,
      });

      const persistedAttachments: PersistedCommentAttachment[] = [];
      const attachmentErrors: Array<{
        index: number;
        name: string;
        code: string;
        message: string;
      }> = [];
      for (const [i, d] of decoded.entries()) {
        try {
          const row = await persistCommentAttachment({
            commentId: inserted.id,
            name: d.name,
            mime: d.mime,
            bytes: d.bytes,
            uploaderId: principal.userId,
            uploaderDeviceId: authorDeviceId,
          });
          persistedAttachments.push(row);
        } catch (err) {
          if (err instanceof AttachmentError) {
            attachmentErrors.push({
              index: i,
              name: d.name,
              code: err.code,
              message: err.message,
            });
          } else {
            attachmentErrors.push({
              index: i,
              name: d.name,
              code: 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

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

      // cm:guard the membership check is deliberately STRICTER than REST `DELETE /api/comments/:id`, which lets an author who has since left the project delete anyway: an agent's token outlives its owner's membership, so a comment written by an ex-member's credential must not still mutate. Dropping this to match REST is a widening, not a de-duplication.
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
  await assertPrincipalIsWriter(principal, await loadIssueProjectId(issueId));

  const commentsLimit = input.limit ?? 50;
  const rows = await listIssueComments(issueId, overfetch(commentsLimit));
  const attachmentsByCommentId = await listCommentAttachmentsForIssue(issueId);

  return buildListEnvelope({
    key: 'comments',
    items: rows.map((r) => serialize(r as CommentRow, attachmentsByCommentId.get(r.id) ?? [])),
    limit: commentsLimit,
    hint: 'read the full thread in the UI',
    order: 'asc',
  });
}

// cm:why `update` exists so an agent can place a `<forge-artifact id>` at all (ISS-898 UC5): an attachment needs a comment id to target, so the id the body must reference does not exist until after the create. It writes through the comments service rather than REST `PATCH /api/comments/:id`, which is `requireAuth()` and is not on the MCP plane.
async function updateAction(principal: Principal, input: ToolInput): Promise<unknown> {
  if (!input.documentId) throw new Error('BAD_REQUEST: documentId is required for update');
  const body = input.data?.body;
  if (!body) throw new Error('BAD_REQUEST: data.body is required for update');

  const comment = await loadCommentForAccess(input.documentId);
  await assertPrincipalIsWriter(principal, comment.projectId);

  const written = await updateCommentBody(input.documentId, { body, format: input.data?.format });
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
