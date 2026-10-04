import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projectMembers, tasks } from '../db/schema.js';
import type { TaskRow } from './task-service.js';

/** The issue a task hangs on, by id: its id and project, or null. */
export async function taskParentIssue(
  issueId: string,
): Promise<{ id: string; projectId: string } | null> {
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issue ?? null;
}

/** Whether the user is a member of the project. */
export async function isProjectMember(projectId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1);
  return row !== undefined;
}

/** An issue's tasks in board order. */
export async function listIssueTasks(issueId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.issueId, issueId))
    .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
}

/** An issue's task ids with their current sort order. */
export async function issueTaskOrder(
  issueId: string,
): Promise<{ id: string; sortOrder: number }[]> {
  return db
    .select({ id: tasks.id, sortOrder: tasks.sortOrder })
    .from(tasks)
    .where(eq(tasks.issueId, issueId))
    .orderBy(asc(tasks.sortOrder));
}
