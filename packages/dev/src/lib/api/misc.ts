import type { IssueAttachment, Notification, Agent } from "../types";
import { request } from "./client";
import { updateProject } from "./projects";
import { updateAgent } from "./agents";

// --- Upload ---

/**
 * Upload a file to an existing issue via the core multipart endpoint. Used by
 * the issue-detail panel for drag/drop after the issue is created. For
 * create-with-attachments in one round-trip, send `attachments[]` (base64) on
 * POST /projects/:id/issues instead — see createIssue() in ./issues.
 */
export async function uploadIssueAttachment(
  issueId: string,
  file: File,
): Promise<IssueAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  const baseUrl = getBaseUrl();
  const authToken = getAuthToken();
  const res = await fetch(`${baseUrl}/api/issues/${issueId}/attachments`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: formData,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { message?: string };
      detail = body?.message ?? "";
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(
      `upload failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await res.json()) as IssueAttachment;
}

/**
 * Legacy fail-loud stub kept so the agent-chat callsite still compiles.
 * The old `/api/upload` Strapi endpoint was removed when core took over; chat
 * attachments need their own core endpoint before this can be re-enabled.
 */
export async function uploadFile(_file: File): Promise<never> {
  throw new Error(
    "uploadFile is removed — legacy /api/upload no longer exists. Wire chat attachments to a new core endpoint, or use uploadIssueAttachment for issue-scoped uploads.",
  );
}

// --- Notifications ---
// Backed by `/api/notifications/*` in packages/core (mounted by ISS-258 phase 1).

export async function getNotifications(): Promise<Notification[]> {
  return request<Notification[]>('/notifications');
}

export async function getUnreadCount(): Promise<number> {
  const r = await request<{ count: number }>('/notifications/unread-count');
  return r.count;
}

export async function markNotificationRead(id: string): Promise<Notification | null> {
  return request<Notification>(`/notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ read: true }),
  });
}

export async function markAllNotificationsRead(): Promise<void> {
  await request<{ updated: number }>('/notifications/mark-all-read', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function syncConventionsToCore(
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
