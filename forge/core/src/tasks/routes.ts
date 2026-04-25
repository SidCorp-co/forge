import { zValidator } from '@hono/zod-validator';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  issuePriorities,
  issues,
  projectMembers,
  taskAgentStatuses,
  taskStatuses,
  tasks,
} from '../db/schema.js';
import { loadProjectAccess } from '../lib/project-access.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';

const issueIdParamSchema = z.object({ id: z.uuid() });
const taskIdParamSchema = z.object({ taskId: z.uuid() });

const taskCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(20_000).nullable().optional(),
    status: z.enum(taskStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    assigneeId: z.uuid().nullable().optional(),
    isAgentTask: z.boolean().optional(),
    agentStatus: z.enum(taskAgentStatuses).nullable().optional(),
    agentLog: z.unknown().optional(),
    acceptanceCriteria: z.unknown().optional(),
  })
  .strict();

const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(20_000).nullable().optional(),
    status: z.enum(taskStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    assigneeId: z.uuid().nullable().optional(),
    isAgentTask: z.boolean().optional(),
    agentStatus: z.enum(taskAgentStatuses).nullable().optional(),
    agentLog: z.unknown().optional(),
    acceptanceCriteria: z.unknown().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, assigneeId)))
    .limit(1);
  if (!row) {
    throw new HTTPException(400, {
      message: 'assignee must be a project member',
      cause: { code: 'ASSIGNEE_NOT_MEMBER' },
    });
  }
}

// POST/GET nested under issues — `/api/issues/:id/tasks`
export const taskIssueRoutes = new Hono<{ Variables: AuthVars }>();
taskIssueRoutes.use('*', requireAuth(), assertEmailVerified());

taskIssueRoutes.post(
  '/:id/tasks',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', taskCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    if (input.assigneeId) await assertAssigneeIsMember(issue.projectId, input.assigneeId);

    const [inserted] = await db
      .insert(tasks)
      .values({
        issueId: issue.id,
        projectId: issue.projectId,
        title: input.title,
        description: input.description ?? null,
        status: input.status ?? 'backlog',
        priority: input.priority ?? 'none',
        assigneeId: input.assigneeId ?? null,
        isAgentTask: input.isAgentTask ?? false,
        agentStatus: input.agentStatus ?? null,
        agentLog: (input.agentLog as never) ?? null,
        acceptanceCriteria: (input.acceptanceCriteria as never) ?? null,
      })
      .returning();
    if (!inserted) throw new Error('tasks: insert returned no row');

    await hooks.emit('taskCreated', {
      taskId: inserted.id,
      issueId: issue.id,
      projectId: issue.projectId,
      actor: { type: 'user', id: userId },
    });

    return c.json(inserted, 201);
  },
);

taskIssueRoutes.get(
  '/:id/tasks',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.issueId, issueId))
      .orderBy(asc(tasks.createdAt));

    return c.json(rows);
  },
);

// PATCH/DELETE by task id — `/api/tasks/:taskId`
export const taskRoutes = new Hono<{ Variables: AuthVars }>();
taskRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadTask(taskId: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw notFound('task not found');
  return row;
}

taskRoutes.get(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    return c.json(task);
  },
);

taskRoutes.patch(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', taskPatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    if (!access.role && access.ownerId !== userId) throw forbidden('not a project member');

    if (patch.assigneeId) await assertAssigneeIsMember(task.projectId, patch.assigneeId);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const fields: string[] = [];
    if (patch.title !== undefined) {
      updates.title = patch.title;
      fields.push('title');
    }
    if (patch.description !== undefined) {
      updates.description = patch.description;
      fields.push('description');
    }
    if (patch.status !== undefined) {
      updates.status = patch.status;
      fields.push('status');
    }
    if (patch.priority !== undefined) {
      updates.priority = patch.priority;
      fields.push('priority');
    }
    if (patch.assigneeId !== undefined) {
      updates.assigneeId = patch.assigneeId;
      fields.push('assigneeId');
    }
    if (patch.isAgentTask !== undefined) {
      updates.isAgentTask = patch.isAgentTask;
      fields.push('isAgentTask');
    }
    if (patch.agentStatus !== undefined) {
      updates.agentStatus = patch.agentStatus;
      fields.push('agentStatus');
    }
    if (patch.agentLog !== undefined) {
      updates.agentLog = patch.agentLog;
      fields.push('agentLog');
    }
    if (patch.acceptanceCriteria !== undefined) {
      updates.acceptanceCriteria = patch.acceptanceCriteria;
      fields.push('acceptanceCriteria');
    }

    const [updated] = await db
      .update(tasks)
      .set(updates)
      .where(eq(tasks.id, taskId))
      .returning();
    if (!updated) throw notFound('task not found');

    if (fields.length > 0) {
      await hooks.emit('taskUpdated', {
        taskId: updated.id,
        issueId: task.issueId,
        projectId: task.projectId,
        actor: { type: 'user', id: userId },
        fields,
      });
    }

    return c.json(updated);
  },
);

taskRoutes.delete(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    if (access.ownerId !== userId && access.role !== 'owner') {
      throw forbidden('not a project owner');
    }

    await db.delete(tasks).where(eq(tasks.id, taskId));

    await hooks.emit('taskDeleted', {
      taskId,
      issueId: task.issueId,
      projectId: task.projectId,
      actor: { type: 'user', id: userId },
    });

    return c.body(null, 204);
  },
);
