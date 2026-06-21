import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AttachmentError,
  type PersistedCommentAttachment,
  listCommentAttachmentsForIssue,
  persistCommentAttachment,
} from '../../comments/attachment-service.js';
import type { CommentAttachmentLite } from '../../comments/tree.js';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import { comments, issues, projectMembers, projects } from '../../db/schema.js';
import { hooks } from '../../pipeline/hooks.js';
import { markUntrusted } from '../../prompt/sanitize.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  zodToMcpSchema,
  assertPrincipalIsWriter,
} from './lib.js';

/**
 * Action-based parity port of the legacy Strapi MCP `forge_comments` tool.
 * Supports list/create/delete (the legacy tool only had list/create — delete
 * is additive and matches REST `DELETE /api/comments/:id`). See ISS-293.
 *
 * `documentId` is the comment UUID; `filters.issue` is the issue UUID.
 */

const filtersSchema = z.object({ issue: z.uuid() }).strict().optional();

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

const dataSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    issue: z.uuid().optional(),
    parentId: z.uuid().optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
  })
  .strict()
  .optional();

const inputSchema = z
  .object({
    action: z.enum(['list', 'create', 'delete']),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: dataSchema,
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

type CommentRow = {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serialize(
  row: CommentRow,
  attachments: CommentAttachmentLite[] = [],
): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    // ISS-532: comment bodies are untrusted (anyone can post) and reach the
    // agent verbatim via this MCP surface — frame as DATA, never instructions.
    body: markUntrusted(row.body, { source: 'comment.body' }),
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attachments,
  };
}

async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

async function loadCommentForAccess(
  commentId: string,
): Promise<{ id: string; issueId: string; authorId: string; projectId: string }> {
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
  if (!row) throw new Error('NOT_FOUND: comment not found');
  return row;
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
    'List, create, or delete issue comments. List requires filters.issue (issue UUID). ' +
    'Create requires data.issue + data.body. Delete requires documentId. All actions ' +
    'enforce project membership via the device principal. ' +
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
    const { device, principal } = ctx;

    switch (input.action) {
      case 'list': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue is required for list');
        const projectId = await loadIssueProjectId(issueId);
        await assertPrincipalIsWriter(principal, projectId);

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
          .limit(input.limit ?? 50);

        const attachmentsByCommentId = await listCommentAttachmentsForIssue(issueId);
        return {
          comments: rows.map((r) =>
            serialize(r as CommentRow, attachmentsByCommentId.get(r.id) ?? []),
          ),
        };
      }

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
          for (let i = 0; i < rawAttachments.length; i++) {
            const a = rawAttachments[i]!;
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

        // The device principal posts comments on behalf of its owner: authorId
        // stays the human owner (NOT-NULL FK to users), but we also stamp
        // authorDeviceId so the comment is identifiable as an AGENT action and
        // not mistaken for one the owner wrote by hand (ISS-519).
        const [inserted] = await db
          .insert(comments)
          .values({
            issueId,
            authorId: device.ownerId,
            authorDeviceId: device.id,
            body,
            parentId: input.data?.parentId ?? null,
          })
          .returning({
            id: comments.id,
            issueId: comments.issueId,
            authorId: comments.authorId,
            body: comments.body,
            parentId: comments.parentId,
            createdAt: comments.createdAt,
            updatedAt: comments.updatedAt,
          });
        if (!inserted) throw new Error('comments: insert returned no row');

        await hooks.emit('commentCreated', {
          issueId,
          projectId,
          actor: { type: 'device', id: device.id },
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
        for (let i = 0; i < decoded.length; i++) {
          const d = decoded[i]!;
          try {
            const row = await persistCommentAttachment({
              commentId: inserted.id,
              name: d.name,
              mime: d.mime,
              bytes: d.bytes,
              uploaderId: device.ownerId,
              uploaderDeviceId: device.id,
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

        // Author can always delete their own comment; otherwise require
        // project owner. Mirrors REST `DELETE /api/comments/:id` semantics
        // with one tightening: an author who has since left the project can
        // still delete on REST, but here we also require current membership
        // — MCP traffic comes from device principals, so a stale device on
        // an ex-member should not be able to mutate the project.
        await assertPrincipalIsWriter(principal, comment.projectId);
        if (comment.authorId !== device.ownerId) {
          await assertCommentDeletePermission(device.ownerId, comment.projectId);
        }

        await db.delete(comments).where(eq(comments.id, input.documentId));
        await hooks.emit('commentDeleted', {
          issueId: comment.issueId,
          projectId: comment.projectId,
          actor: { type: 'device', id: device.id },
          commentId: comment.id,
        });

        return { documentId: input.documentId, status: 'deleted' };
      }
    }
  },
});

async function assertCommentDeletePermission(userId: string, projectId: string): Promise<void> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) throw new Error('FORBIDDEN: project not found or not accessible');
  if (!projectRoleAtLeast(access.role, 'admin')) {
    throw new Error('FORBIDDEN: only the comment author or a project admin can delete');
  }
}
