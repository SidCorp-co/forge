import type { Task } from "../types";
import { request } from "./client";

// ISS-257: tasks moved from the legacy top-level `/tasks` endpoint to core's
// nested `/api/issues/:id/tasks` + `/api/tasks/:taskId`. Aggregate list-by-
// project is no longer a single endpoint — callers should fetch per-issue.
// `getTasks` / `getAllTasks` short-circuit to [] until the dev UI is rewired.

export async function getAllTasks(): Promise<Task[]> {
  // TODO(iss-257): cross-project task feed not yet exposed in core.
  return [];
}

export async function getTasks(_projectSlug: string): Promise<Task[]> {
  // TODO(iss-257): need /projects/:id/tasks aggregator in core (out of scope
  // for Tier B1 — caller should switch to per-issue task fetches).
  return [];
}

// TODO(iss-257): core returns flat `{ id, assigneeId, ... }` shape; the dev-side
// `Task` type still mirrors the legacy Strapi shape (`documentId`, `assignee`).
// Existing dev consumers (use-agent-stream.ts, project-board-view.tsx) will see
// `t.documentId === undefined` at runtime until the dev type is aligned in a
// follow-up. The casts below make the lie explicit so the next session can grep.
export async function getTasksByIssue(issueId: string): Promise<Task[]> {
  const rows = await request<unknown[]>(`/issues/${issueId}/tasks`);
  return rows as unknown as Task[];
}

export async function updateTask(
  taskId: string,
  data: Partial<Task>,
): Promise<Task> {
  const row = await request<unknown>(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return row as unknown as Task;
}
