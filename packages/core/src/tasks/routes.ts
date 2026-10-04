import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { issuePriorities, taskAgentStatuses, taskStatuses } from '../db/schema.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireHeld } from '../permissions/index.js';
import { isProjectMember, issueTaskOrder, listIssueTasks, taskParentIssue } from './read.js';
import { createTask, deleteTask, findTaskById, reorderTasks, updateTask } from './task-service.js';

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

const TASK_PATCH_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'assigneeId',
  'isAgentTask',
  'agentStatus',
  'agentLog',
  'acceptanceCriteria',
  'sortOrder',
] as const satisfies readonly (keyof z.infer<typeof taskPatchSchema>)[];

const TASK_JSONB_FIELDS = ['agentLog', 'acceptanceCriteria'] as const;

const taskReorderSchema = z.object({ taskIds: z.array(z.uuid()).min(1) }).strict();

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  if (!(await isProjectMember(projectId, assigneeId))) {
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
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', taskCreateSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await taskParentIssue(issueId);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    if (input.assigneeId) await assertAssigneeIsMember(issue.projectId, input.assigneeId);

    const inserted = await createTask({
      issueId: issue.id,
      projectId: issue.projectId,
      title: input.title,
      description: input.description ?? null,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      isAgentTask: input.isAgentTask,
      agentStatus: input.agentStatus,
      agentLog: (input.agentLog as never) ?? null,
      acceptanceCriteria: (input.acceptanceCriteria as never) ?? null,
      sortOrder: input.sortOrder,
      actor: restActor(c),
    });

    return c.json(inserted, 201);
  },
);

taskIssueRoutes.get(
  '/:id/tasks',
  zValidator('param', issueRouteIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('query', projectScopeQuerySchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await resolveIssueRouteRef(rawId, projectIdQuery, userId);

    const rows = await listIssueTasks(issue.id);

    return c.json(rows);
  },
);

// Reorder all subtasks of an issue. Body must list every task id of the issue
// exactly once; partial reorders are rejected to keep sortOrder gap-free.
taskIssueRoutes.post(
  '/:id/tasks/reorder',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', taskReorderSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { id: issueId } = c.req.valid('param');
    const { taskIds } = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await taskParentIssue(issueId);
    if (!issue) throw notFound('issue not found');

    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    const existing = await issueTaskOrder(issueId);

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
    await reorderTasks(issue, taskIds, previous, restActor(c));

    return c.body(null, 204);
  },
);

// PATCH/DELETE by task id — `/api/tasks/:taskId`
export const taskRoutes = new Hono<{ Variables: AuthVars }>();
taskRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadTask(taskId: string) {
  const row = await findTaskById(taskId);
  if (!row) throw notFound('task not found');
  return row;
}

taskRoutes.get(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    requireHeld(access, 'project.read');

    return c.json(task);
  },
);

taskRoutes.patch(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  zValidator('json', taskPatchSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    requireHeld(access, 'project.write');

    if (patch.assigneeId) await assertAssigneeIsMember(task.projectId, patch.assigneeId);

    const updates: Record<string, unknown> = {};
    for (const field of TASK_PATCH_FIELDS) {
      const next = (patch as Record<string, unknown>)[field];
      if (next !== undefined) updates[field] = next;
    }

    const updated = await updateTask(task, updates, restActor(c), TASK_JSONB_FIELDS);
    if (!updated) throw notFound('task not found');

    return c.json(updated);
  },
);

taskRoutes.delete(
  '/:taskId',
  zValidator('param', taskIdParamSchema, (r) => {
    if (!r.success) throw badRequest(r.error);
  }),
  async (c) => {
    const { taskId } = c.req.valid('param');
    const userId = c.get('userId');

    const task = await loadTask(taskId);
    const access = await loadProjectAccess(task.projectId, userId);
    requireHeld(access, 'project.write');

    await deleteTask(task, restActor(c));

    return c.body(null, 204);
  },
);
