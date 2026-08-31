import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks } from '../db/schema.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';

export type TaskRow = typeof tasks.$inferSelect;

/** Light projection for browse surfaces — omits `description` (up to 50KB each). */
export type TaskListRow = Omit<TaskRow, 'description' | 'agentLog' | 'sortOrder'>;

export async function findTaskById(taskId: string): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
}

export async function listTasksForIssue(
  issueId: string,
  opts: { status?: TaskRow['status'] | undefined; limit?: number | undefined } = {},
): Promise<TaskListRow[]> {
  const where = opts.status
    ? sql`${tasks.issueId} = ${issueId} and ${tasks.status} = ${opts.status}`
    : eq(tasks.issueId, issueId);

  const q = db
    .select({
      id: tasks.id,
      issueId: tasks.issueId,
      projectId: tasks.projectId,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assigneeId: tasks.assigneeId,
      isAgentTask: tasks.isAgentTask,
      agentStatus: tasks.agentStatus,
      acceptanceCriteria: tasks.acceptanceCriteria,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(where)
    // cm:edge contract -> packages/core/src/tasks/routes.ts — the board's own order is (sortOrder, createdAt); a browse that sorts by createdAt alone hands an agent a different sequence than the human is looking at
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));

  return opts.limit === undefined ? q : q.limit(opts.limit);
}

export type TaskCreateInput = {
  issueId: string;
  projectId: string;
  title: string;
  description?: string | null | undefined;
  status?: TaskRow['status'] | undefined;
  priority?: TaskRow['priority'] | undefined;
  assigneeId?: string | null | undefined;
  isAgentTask?: boolean | undefined;
  agentStatus?: TaskRow['agentStatus'] | undefined;
  agentLog?: TaskRow['agentLog'] | undefined;
  acceptanceCriteria?: TaskRow['acceptanceCriteria'] | undefined;
  sortOrder?: number | undefined;
  actor: Actor;
};

/**
 * The single task writer behind REST `/api/issues/:id/tasks` and MCP
 * `forge_issues.createTask`. The MCP copy this replaces set neither of the two
 * things that make a task visible: `sortOrder` (so every agent-created task
 * landed at the column default 0, ahead of the human's ordering) and the
 * `taskCreated` hook (so no WebSocket frame reached the board and the task
 * appeared only on the next full reload).
 */
export async function createTask(input: TaskCreateInput): Promise<TaskRow> {
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const [maxRow] = await db
      .select({ max: sql<number | null>`max(${tasks.sortOrder})` })
      .from(tasks)
      .where(eq(tasks.issueId, input.issueId))
      .limit(1);
    sortOrder = (maxRow?.max ?? -1) + 1;
  }

  const [inserted] = await db
    .insert(tasks)
    .values({
      issueId: input.issueId,
      projectId: input.projectId,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? 'backlog',
      priority: input.priority ?? 'none',
      assigneeId: input.assigneeId ?? null,
      isAgentTask: input.isAgentTask ?? false,
      agentStatus: input.agentStatus ?? null,
      agentLog: input.agentLog ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      sortOrder,
    })
    .returning();
  if (!inserted) throw new Error('tasks: insert returned no row');

  await hooks.emit('taskCreated', {
    taskId: inserted.id,
    issueId: input.issueId,
    projectId: input.projectId,
    actor: input.actor,
  });

  return inserted;
}

/**
 * Applies `updates` and emits `taskUpdated` naming only the columns whose value
 * actually changed. `jsonbFields` are reported changed on any explicit set:
 * their object identity differs on every load, so a value comparison would
 * report every write as a change and never report one as unchanged.
 */
export async function updateTask(
  before: TaskRow,
  updates: Record<string, unknown>,
  actor: Actor,
  jsonbFields: readonly string[] = [],
): Promise<TaskRow | null> {
  const changed = Object.keys(updates).filter((f) =>
    jsonbFields.includes(f) ? true : (before as Record<string, unknown>)[f] !== updates[f],
  );

  const [updated] = await db
    .update(tasks)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(tasks.id, before.id))
    .returning();
  if (!updated) return null;

  if (changed.length > 0) {
    await hooks.emit('taskUpdated', {
      taskId: updated.id,
      issueId: before.issueId,
      projectId: before.projectId,
      actor,
      fields: changed,
    });
  }

  return updated;
}

export async function deleteTask(task: TaskRow, actor: Actor): Promise<void> {
  await db.delete(tasks).where(eq(tasks.id, task.id));
  await hooks.emit('taskDeleted', {
    taskId: task.id,
    issueId: task.issueId,
    projectId: task.projectId,
    actor,
  });
}
