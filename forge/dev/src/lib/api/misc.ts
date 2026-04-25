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
// TODO(notifications-port): /api/notifications is not yet mounted in
// forge/core (audit Table A). Short-circuit until the endpoint lands so
// the desktop app stops 404-ing on every poll.

export async function getNotifications(): Promise<Notification[]> {
  return [];
}

export async function getUnreadCount(): Promise<number> {
  return 0;
}

export async function markNotificationRead(_id: string): Promise<Notification | null> {
  return null;
}

export async function markAllNotificationsRead(): Promise<void> {
  /* no-op until /api/notifications/mark-all-read lands in core */
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
