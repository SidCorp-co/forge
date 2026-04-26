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

// forge/core's updateProjectSchema is .strict() — only the fields below pass
// validation. Other fields (knowledgeIndex, conventions, repos, repoPath,
// baseBranch, productionBranch, sentryProject, …) currently have no core home;
// drop them with a console.warn so callers can spot the silent failure.
const PROJECT_PATCH_FIELDS = new Set(["name", "agentConfig", "webhookSecret"]);

export async function updateProject(documentId: string, data: Record<string, unknown>): Promise<Project> {
  const body: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (PROJECT_PATCH_FIELDS.has(key)) body[key] = value;
    else dropped.push(key);
  }
  if (dropped.length > 0) {
    console.warn(
      `[projects] updateProject: dropping unsupported field(s) ${dropped.join(", ")} — forge/core's PATCH /projects/:id only accepts ${[...PROJECT_PATCH_FIELDS].join(", ")} (TODO(iss-275)).`,
    );
  }
  if (Object.keys(body).length === 0) {
    // Nothing to send; refetch to honor the Promise<Project> contract without
    // hitting core's "no fields to update" 400.
    const row = await request<Record<string, unknown> & { id: string }>(`/projects/${documentId}`);
    return adaptRow(row) as unknown as Project;
  }
  const row = await request<Record<string, unknown> & { id: string }>(`/projects/${documentId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return adaptRow(row) as unknown as Project;
}
