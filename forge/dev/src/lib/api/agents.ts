import type { Agent } from "../types";
import { request } from "./client";

export async function getAgents(projectSlug: string): Promise<Agent[]> {
  return request(`/agents?filters[project][slug][$eq]=${encodeURIComponent(projectSlug)}`);
}

export async function updateAgent(documentId: string, data: Partial<Agent>): Promise<Agent> {
  return request(`/agents/${documentId}`, {
    method: "PUT",
    body: JSON.stringify({ data }),
  });
}
