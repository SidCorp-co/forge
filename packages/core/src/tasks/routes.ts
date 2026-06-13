import { zValidator } from '@hono/zod-validator';
import { and, asc, eq, sql } from 'drizzle-orm';
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
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
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
    sortOrder: z.number().int().nonnegative().optional(),
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
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' });

const taskReorderSchema = z
  .object({ taskIds: z.array(z.uuid()).min(1) })
  .strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

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
    assertProjectRole(access, 'member', 'not a project member');

    if (input.assigneeId) await assertAssigneeIsMember(issue.projectId, input.assigneeId);

    let sortOrder = input.sortOrder;
    if (sortOrder === undefined) {
      const [maxRow] = await db
        .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
        .from(tasks)
        .where(eq(tasks.issueId, issue.id))
        .limit(1);
      sortOrder = (maxRow?.max ?? -1) + 1;
    }

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
        sortOrder,
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
    assertProjectRole(access, 'viewer', 'not a project member');

    const rows = await db
      .select()
      .from(tasks)
      .where(eq(tasks.issueId, issueId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));

    return c.json(rows);
  },
);

// Reorder all subtasks of an issue. Body must list every task id of the issue
// exactly once; partial reorders are rejected to keep sortOrder gap-free.
taskIssueRoutes.post(
  '/:id/tasks/reorder',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', taskReorderSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const { taskIds } = c.req.valid('json');
    const userId = c.get('userId');

    const [issue] = await db
      .select({ id: issues.id, projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member', 'not a project member');

    const existing = await db
      .select({ id: tasks.id, sortOrder: tasks.sortOrder })
      .from(tasks)
      .where(eq(tasks.issueId, issueId))
      .orderBy(asc(tasks.sortOrder));

    if (existing.length !== taskIds.length) {
      throw new HTTPException(400, {
        message: 'taskIds must list every subtask of the issue exactly once',
        cause: { code: 'TASKS_MISMATCH' },
      });
    }
    const existingSet = new Set(existing.map((r) => r.id));
    const seen = new Set<string>();
    for (const id of taskIds) {
      if (!existingSet.has(id) || seen.has(id)) {
        throw new HTTPException(400, {
          message: 'taskIds must list every subtask of the issue exactly once',
          cause: { code: 'TASKS_MISMATCH' },
        });
      }
      seen.add(id);
    }

    const previous = new Map(existing.map((r) => [r.id, r.sortOrder]));
    const changed: string[] = [];
    await db.transaction(async (tx) => {
      for (let i = 0; i < taskIds.length; i++) {
        const id = taskIds[i] as string;
        if (previous.get(id) === i) continue;
        await tx
          .update(tasks)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(eq(tasks.id, id));
        changed.push(id);
      }
    });

    await Promise.all(
      changed.map((id) =>
        hooks.emit('taskUpdated', {
          taskId: id,
          issueId: issue.id,
          projectId: issue.projectId,
          actor: { type: 'user', id: userId },
          fields: ['sortOrder'],
        }),
      ),
    );

    return c.body(null, 204);
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
    assertProjectRole(access, 'viewer', 'not a project member');

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
    assertProjectRole(access, 'member', 'not a project member');

    if (patch.assigneeId) await assertAssigneeIsMember(task.projectId, patch.assigneeId);

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const fields: string[] = [];
    const track = (field: string, prev: unknown, next: unknown) => {
      if (prev !== next) fields.push(field);
    };
    if (patch.title !== undefined) {
      updates.title = patch.title;
      track('title', task.title, patch.title);
    }
    if (patch.description !== undefined) {
      updates.description = patch.description;
      track('description', task.description, patch.description);
    }
    if (patch.status !== undefined) {
      updates.status = patch.status;
      track('status', task.status, patch.status);
    }
    if (patch.priority !== undefined) {
      updates.priority = patch.priority;
      track('priority', task.priority, patch.priority);
    }
    if (patch.assigneeId !== undefined) {
      updates.assigneeId = patch.assigneeId;
      track('assigneeId', task.assigneeId, patch.assigneeId);
    }
    if (patch.isAgentTask !== undefined) {
      updates.isAgentTask = patch.isAgentTask;
      track('isAgentTask', task.isAgentTask, patch.isAgentTask);
    }
    if (patch.agentStatus !== undefined) {
      updates.agentStatus = patch.agentStatus;
      track('agentStatus', task.agentStatus, patch.agentStatus);
    }
    if (patch.agentLog !== undefined) {
      updates.agentLog = patch.agentLog;
      // jsonb: object identity differs each load, so any explicit set counts as a change.
      fields.push('agentLog');
    }
    if (patch.acceptanceCriteria !== undefined) {
      updates.acceptanceCriteria = patch.acceptanceCriteria;
      // jsonb: object identity differs each load, so any explicit set counts as a change.
      fields.push('acceptanceCriteria');
    }
    if (patch.sortOrder !== undefined) {
      updates.sortOrder = patch.sortOrder;
      track('sortOrder', task.sortOrder, patch.sortOrder);
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
    assertProjectRole(access, 'member', 'not a project member');

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
