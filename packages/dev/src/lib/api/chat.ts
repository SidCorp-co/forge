import type { ChatSession, ChatSessionDetail } from "../types";
import { adaptRow, request, resolveProjectId } from "./client";

export async function getChatSessions(projectSlug: string): Promise<ChatSession[]> {
  const projectId = await resolveProjectId(projectSlug);
  const rows = await request<Array<Record<string, unknown> & { id: string }>>(
    `/chat-sessions?projectId=${projectId}&pageSize=50`,
  );
  return rows.map((r) => adaptRow(r) as unknown as ChatSession);
}

export async function getChatSession(documentId: string): Promise<ChatSessionDetail> {
  const row = await request<Record<string, unknown> & { id: string }>(`/chat-sessions/${documentId}`);
  return adaptRow(row) as unknown as ChatSessionDetail;
}

export async function sendChatMessage(
  projectSlug: string,
  message: string,
  sessionId: string | null,
): Promise<{ sessionId: string; reply: string; toolCalls?: { name: string; input: any; durationMs?: number; isError?: boolean }[] }> {
  return request("/chat", {
    method: "POST",
    body: JSON.stringify({ projectSlug, message, sessionId }),
  });
}
