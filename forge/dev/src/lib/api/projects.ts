import type { Project } from "../types";
import { request } from "./client";

export async function getProjects(): Promise<Project[]> {
  return request("/projects?populate=*");
}

export async function getProject(slug: string): Promise<Project> {
  return request(`/projects?filters[slug][$eq]=${encodeURIComponent(slug)}&populate=*`).then(
    (data: unknown) => (data as Project[])[0],
  );
}

export async function updateProject(documentId: string, data: Record<string, unknown>): Promise<Project> {
  return request(`/projects/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}
