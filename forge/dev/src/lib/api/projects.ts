import type { Project } from "../types";
import { adaptRow, request, resolveProjectId } from "./client";

export async function getProjects(): Promise<Project[]> {
  const rows = await request<Array<Record<string, unknown> & { id: string }>>("/projects");
  return rows.map((r) => adaptRow(r) as unknown as Project);
}

export async function getProject(slug: string): Promise<Project> {
  const projectId = await resolveProjectId(slug);
  const row = await request<Record<string, unknown> & { id: string }>(`/projects/${projectId}`);
  return adaptRow(row) as unknown as Project;
}

export async function updateProject(documentId: string, data: Record<string, unknown>): Promise<Project> {
  const row = await request<Record<string, unknown> & { id: string }>(`/projects/${documentId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return adaptRow(row) as unknown as Project;
}
