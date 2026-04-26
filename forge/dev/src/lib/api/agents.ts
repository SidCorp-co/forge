import type { Agent } from "../types";
import { adaptRow, request, resolveProjectId } from "./client";

export async function getAgents(projectSlug: string): Promise<Agent[]> {
  const projectId = await resolveProjectId(projectSlug);
  const rows = await request<Array<Record<string, unknown> & { id: string }>>(
    `/agents?projectId=${projectId}`,
  );
  return rows.map((r) => adaptRow(r) as unknown as Agent);
}

export async function updateAgent(documentId: string, data: Partial<Agent>): Promise<Agent> {
  const row = await request<Record<string, unknown> & { id: string }>(`/agents/${documentId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
  return adaptRow(row) as unknown as Agent;
}
