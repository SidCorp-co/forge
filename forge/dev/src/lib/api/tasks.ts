import type { Task } from "../types";
import { request } from "./client";

// Phase 3.3 (ISS-257): tasks moved from top-level Strapi `/tasks` to core's
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

export async function getTasksByIssue(issueId: string): Promise<Task[]> {
  return request(`/issues/${issueId}/tasks`);
}

export async function updateTask(
  taskId: string,
  data: Partial<Task>,
): Promise<Task> {
  return request(`/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}
