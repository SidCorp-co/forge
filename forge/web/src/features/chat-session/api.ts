import { apiClient } from '@/lib/api/client';
import type { ChatMessage, ChatSession, ChatSessionListFilters } from './types';

export const chatSessionApi = {
  list: async ({ projectId, page = 1, pageSize = 50 }: ChatSessionListFilters) => {
    const qs = new URLSearchParams({ projectId, page: String(page), pageSize: String(pageSize) });
    const rows = await apiClient<ChatSession[]>(`/chat-sessions?${qs.toString()}`);
    // Core's list returns full session rows including the entire `messages` JSON
    // blob, which can be megabytes per session. Strip it client-side so React
    // Query doesn't keep it in cache; the detail call (`get`) brings it back
    // when a session is opened.
    return rows.map((row) => ({ ...row, messages: [] as ChatMessage[] }));
  },

  get: (id: string) => apiClient<ChatSession>(`/chat-sessions/${id}`),

  create: (input: { projectId: string; title?: string | null; source?: ChatSession['source'] }) =>
    apiClient<ChatSession>('/chat-sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  patch: (id: string, patch: { title?: string | null; summary?: string | null }) =>
    apiClient<ChatSession>(`/chat-sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  delete: (id: string) => apiClient<null>(`/chat-sessions/${id}`, { method: 'DELETE' }),

  sendMessage: (id: string, body: { role?: ChatMessage['role']; content: string }) =>
    apiClient<{ session: ChatSession; message: ChatMessage }>(`/chat-sessions/${id}/message`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
