import type { ChatSession, ChatSessionDetail } from "../types";
import { request } from "./client";

export async function getChatSessions(projectSlug: string): Promise<ChatSession[]> {
  return request(
    `/chat-sessions?filters[project][slug][$eq]=${encodeURIComponent(projectSlug)}&sort=updatedAt:desc&pagination[pageSize]=50`,
  );
}

export async function getChatSession(documentId: string): Promise<ChatSessionDetail> {
  return request(`/chat-sessions/${documentId}`);
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
