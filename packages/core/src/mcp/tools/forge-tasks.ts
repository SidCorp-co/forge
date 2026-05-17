import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { issuePriorities, issues, taskStatuses, tasks } from '../../db/schema.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  zodToMcpSchema,
} from './lib.js';

/**
 * Action-based parity port of the legacy Strapi MCP `forge_tasks` tool.
 * Supports list/get/create/update/delete. Tasks belong to an issue and inherit
 * its project for access control. See ISS-293.
 */

const filtersSchema = z
  .object({
    issue: z.uuid().optional(),
    status: z.enum(taskStatuses).optional(),
  })
  .strict()
  .optional();

const dataSchema = z
  .object({
    issueId: z.uuid().optional(),
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(50_000).nullable().optional(),
    status: z.enum(taskStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    isAgentTask: z.boolean().optional(),
    acceptanceCriteria: z.array(z.string()).nullable().optional(),
  })
  .strict()
  .optional();

const inputSchema = z
  .object({
    action: z.enum(['list', 'get', 'create', 'update', 'delete']),
    documentId: z.uuid().optional(),
    filters: filtersSchema,
    data: dataSchema,
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();

type TaskRow = {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  isAgentTask: boolean;
  agentStatus: string | null;
  acceptanceCriteria: unknown;
  createdAt: Date;
  updatedAt: Date;
};

function serialize(row: TaskRow): Record<string, unknown> {
  return {
    documentId: row.id,
    issueId: row.issueId,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    isAgentTask: row.isAgentTask,
    agentStatus: row.agentStatus,
    acceptanceCriteria: row.acceptanceCriteria,
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

async function loadTaskForAccess(taskId: string): Promise<TaskRow> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error('NOT_FOUND: task not found');
  return row as TaskRow;
}

export const forgeTasksTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_tasks',
  description:
    'Action-based task CRUD scoped by issue. Actions: list (filters.issue required), get, create (data.issueId + data.title required), update, delete. `documentId` is the task UUID. Tasks inherit project membership from their parent issue.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);

    if (input.action === 'list') {
      const issueId = input.filters?.issue;
      if (!issueId) throw new Error('BAD_REQUEST: filters.issue required for list');
      const projectId = await loadIssueProjectId(issueId);
      await assertPrincipalIsMember(ctx.principal, projectId);

      const where = input.filters?.status
        ? and(eq(tasks.issueId, issueId), eq(tasks.status, input.filters.status))
        : eq(tasks.issueId, issueId);

      const rows = await db
        .select()
        .from(tasks)
        .where(where)
        .orderBy(asc(tasks.createdAt))
        .limit(input.limit ?? 100);

      return { tasks: (rows as TaskRow[]).map(serialize) };
    }

    if (input.action === 'get') {
      if (!input.documentId) throw new Error('BAD_REQUEST: documentId required for get');
      const row = await loadTaskForAccess(input.documentId);
      await assertPrincipalIsMember(ctx.principal, row.projectId);
      return { task: serialize(row) };
    }

    if (input.action === 'create') {
      const data = input.data;
      if (!data?.issueId) throw new Error('BAD_REQUEST: data.issueId required');
      if (!data.title) throw new Error('BAD_REQUEST: data.title required');
      const projectId = await loadIssueProjectId(data.issueId);
      await assertPrincipalIsMember(ctx.principal, projectId);

      const [created] = await db
        .insert(tasks)
        .values({
          issueId: data.issueId,
          projectId,
          title: data.title,
          description: data.description ?? null,
          status: data.status ?? 'backlog',
          priority: data.priority ?? 'none',
          isAgentTask: data.isAgentTask ?? false,
          acceptanceCriteria: data.acceptanceCriteria ?? null,
        })
        .returning();

      return { task: serialize(created as TaskRow) };
    }

    if (input.action === 'update') {
      if (!input.documentId) throw new Error('BAD_REQUEST: documentId required for update');
      const row = await loadTaskForAccess(input.documentId);
      await assertPrincipalIsMember(ctx.principal, row.projectId);

      const data = input.data ?? {};
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.title !== undefined) updates.title = data.title;
      if (data.description !== undefined) updates.description = data.description;
      if (data.status !== undefined) updates.status = data.status;
      if (data.priority !== undefined) updates.priority = data.priority;
      if (data.isAgentTask !== undefined) updates.isAgentTask = data.isAgentTask;
      if (data.acceptanceCriteria !== undefined) updates.acceptanceCriteria = data.acceptanceCriteria;

      const [updated] = await db
        .update(tasks)
        .set(updates)
        .where(eq(tasks.id, input.documentId))
        .returning();

      return { task: serialize(updated as TaskRow) };
    }

    if (input.action === 'delete') {
      if (!input.documentId) throw new Error('BAD_REQUEST: documentId required for delete');
      const row = await loadTaskForAccess(input.documentId);
      await assertPrincipalIsMember(ctx.principal, row.projectId);
      await db.delete(tasks).where(eq(tasks.id, input.documentId));
      return { deleted: true, documentId: input.documentId };
    }

    throw new Error(`BAD_REQUEST: unknown action "${(input as { action: string }).action}"`);
  },
});
