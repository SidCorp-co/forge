import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { comments, issues, projectMembers, projects } from '../../db/schema.js';
import { hooks } from '../../pipeline/hooks.js';
import {
  type ContextScopedMcpToolFactory,
  assertDeviceOwnerIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * Action-based parity port of the legacy Strapi MCP `forge_comments` tool.
 * Supports list/create/delete (the legacy tool only had list/create — delete
 * is additive and matches REST `DELETE /api/comments/:id`). See ISS-293.
 *
 * `documentId` is the comment UUID; `filters.issue` is the issue UUID.
 */

const filtersSchema = z.object({ issue: z.uuid() }).strict().optional();

const dataSchema = z
  .object({
    body: z.string().trim().min(1).max(10_000).optional(),
    issue: z.uuid().optional(),
    parentId: z.uuid().optional(),
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

function serialize(row: CommentRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    authorId: row.authorId,
    body: row.body,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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

export const forgeCommentsTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_comments',
  description:
    'List, create, or delete issue comments. List requires filters.issue (issue UUID). ' +
    'Create requires data.issue + data.body. Delete requires documentId. All actions ' +
    'enforce project membership via the device principal.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { device } = ctx;

    switch (input.action) {
      case 'list': {
        const issueId = input.filters?.issue;
        if (!issueId) throw new Error('BAD_REQUEST: filters.issue is required for list');
        const projectId = await loadIssueProjectId(issueId);
        await assertDeviceOwnerIsMember(device, projectId);

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

        return { comments: rows.map((r) => serialize(r as CommentRow)) };
      }

      case 'create': {
        const issueId = input.data?.issue;
        const body = input.data?.body;
        if (!issueId) throw new Error('BAD_REQUEST: data.issue is required for create');
        if (!body) throw new Error('BAD_REQUEST: data.body is required for create');

        const projectId = await loadIssueProjectId(issueId);
        await assertDeviceOwnerIsMember(device, projectId);

        // The device principal posts comments on behalf of its owner — there
        // is no separate device authorId column, so we attribute to ownerId
        // the same way the REST flow attributes to the authenticated user.
        const [inserted] = await db
          .insert(comments)
          .values({
            issueId,
            authorId: device.ownerId,
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

        return serialize(inserted as CommentRow);
      }

      case 'delete': {
        if (!input.documentId) {
          throw new Error('BAD_REQUEST: documentId is required for delete');
        }
        const comment = await loadCommentForAccess(input.documentId);

        // Author can always delete their own comment; otherwise require
        // project owner. Mirrors REST `DELETE /api/comments/:id` semantics.
        if (comment.authorId !== device.ownerId) {
          await assertCommentDeletePermission(device.ownerId, comment.projectId);
        } else {
          await assertDeviceOwnerIsMember(device, comment.projectId);
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

async function assertCommentDeletePermission(
  userId: string,
  projectId: string,
): Promise<void> {
  const [project] = await db
    .select({ ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) throw new Error('FORBIDDEN: project not found or not accessible');
  if (project.ownerId === userId) return;
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  if (!member || member.role !== 'owner') {
    throw new Error('FORBIDDEN: only the comment author or project owner can delete');
  }
}
