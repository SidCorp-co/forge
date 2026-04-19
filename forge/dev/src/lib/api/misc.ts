import type { Notification, Agent } from "../types";
import { request, getBaseUrl, getAuthToken } from "./client";
import { updateProject } from "./projects";
import { updateAgent } from "./agents";

// --- Upload ---

export async function uploadFile(file: File): Promise<{ id: number; url: string; name: string } | null> {
  const formData = new FormData();
  formData.append("files", file);
  const baseUrl = getBaseUrl();
  const authToken = getAuthToken();
  const res = await fetch(`${baseUrl}/api/upload`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: formData,
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data[0]?.id) return { id: data[0].id, url: data[0].url, name: file.name };
  return null;
}

// --- Notifications ---

export async function getNotifications(): Promise<Notification[]> {
  return request("/notifications?sort=createdAt:desc&pagination[pageSize]=50&populate[project][fields][0]=slug");
}

export async function getUnreadCount(): Promise<number> {
  const result = await request<{ count: number }>("/notifications/unread-count");
  return result.count;
}

export async function markNotificationRead(id: string): Promise<Notification> {
  return request(`/notifications/${id}`, {
    method: "PUT",
    body: JSON.stringify({ data: { read: true } }),
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await request("/notifications/mark-all-read", { method: "POST" });
}

// --- Knowledge ---

export async function syncKnowledgeToStrapi(
  projectApiKey: string,
  knowledge: Record<string, unknown>,
  projectDocumentId?: string,
): Promise<{ ok: boolean; processed: number }> {
  // 1. Save structured knowledge to project.knowledgeIndex field
  if (projectDocumentId) {
    await updateProject(projectDocumentId, { knowledgeIndex: knowledge });
  }

  // 2. Ingest into Qdrant embeddings for semantic search
  const documents = Object.entries(knowledge)
    .filter(([, v]) => v != null)
    .map(([key, value]) => ({
      id: `knowledge-${key}`,
      title: key,
      content: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      category: "codebase",
    }));

  if (documents.length === 0) return { ok: true, processed: 0 };

  const baseUrl = getBaseUrl();
  const res = await fetch(`${baseUrl}/api/knowledge/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-API-Key": projectApiKey,
    },
    body: JSON.stringify({ documents }),
  });
  if (!res.ok) throw new Error(`Knowledge sync failed: ${res.status}`);
  return res.json();
}

export async function syncConventionsToStrapi(
  projectDocumentId: string,
  conventions: string,
): Promise<void> {
  await updateProject(projectDocumentId, { conventions });
}

export async function syncAgentFiles(
  agentDocumentId: string,
  files: { knowledge?: string | null; memory?: string | null },
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (files.knowledge !== undefined) data.knowledge = files.knowledge;
  if (files.memory !== undefined) data.memory = files.memory;
  await updateAgent(agentDocumentId, data as Partial<Agent>);
}
