import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { tasks } from '../db/schema.js';
import { emitEvent, emitEvents } from '../outbox/index.js';
import type { Actor } from '../pipeline/activity.js';

export type TaskRow = typeof tasks.$inferSelect;

export async function findTaskById(taskId: string): Promise<TaskRow | null> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return row ?? null;
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
 * The single task writer behind REST `/api/issues/:id/tasks`. It sets the two
 * things that make a task visible: `sortOrder` (after the human's ordering)
 * and the `task.created` outbox event (the WebSocket frame that reaches the board).
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

  return db.transaction(async (tx) => {
    const [inserted] = await tx
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
    await emitEvent(tx, 'task.created', {
      taskId: inserted.id,
      issueId: input.issueId,
      projectId: input.projectId,
      actor: input.actor,
    });
    return inserted;
  });
}

/**
 * Applies `updates` and emits `task.updated` naming only the columns whose value
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

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(tasks)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(tasks.id, before.id))
      .returning();
    if (!updated) return null;
    if (changed.length > 0) {
      await emitEvent(tx, 'task.updated', {
        taskId: updated.id,
        issueId: before.issueId,
        projectId: before.projectId,
        actor,
        fields: changed,
      });
    }
    return updated;
  });
}

export async function deleteTask(task: TaskRow, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(tasks).where(eq(tasks.id, task.id));
    await emitEvent(tx, 'task.deleted', {
      taskId: task.id,
      issueId: task.issueId,
      projectId: task.projectId,
      actor,
    });
  });
}

/** An issue's tasks take the given order; each task whose position moved emits `task.updated`. */
export async function reorderTasks(
  issue: { id: string; projectId: string },
  taskIds: readonly string[],
  previous: ReadonlyMap<string, number>,
  actor: Actor,
): Promise<void> {
  const changed: string[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < taskIds.length; i++) {
      const id = taskIds[i] as string;
      if (previous.get(id) === i) continue;
      await tx.update(tasks).set({ sortOrder: i, updatedAt: new Date() }).where(eq(tasks.id, id));
      changed.push(id);
    }
    await emitEvents(
      tx,
      changed.map((id) => ({
        type: 'task.updated' as const,
        payload: {
          taskId: id,
          issueId: issue.id,
          projectId: issue.projectId,
          actor,
          fields: ['sortOrder'],
        },
      })),
    );
  });
}
