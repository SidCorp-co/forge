import type { Task } from "../types";
import { request } from "./client";

export async function getAllTasks(): Promise<Task[]> {
  return request("/tasks?populate=*&sort=createdAt:desc&pagination[pageSize]=200");
}

export async function getTasks(projectSlug: string): Promise<Task[]> {
  return request(
    `/tasks?filters[issue][project][slug][$eq]=${encodeURIComponent(projectSlug)}&populate=*&sort=createdAt:asc`,
  );
}

export async function updateTask(
  documentId: string,
  data: Partial<Task>,
): Promise<Task> {
  return request(`/tasks/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}
