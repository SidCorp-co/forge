export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatMessageRole;
  content: string | unknown[];
  ts?: string;
}

export interface ChatSession {
  id: string;
  projectId: string;
  userId: string | null;
  title: string | null;
  source: 'web' | 'cli' | 'mcp' | 'widget' | 'api';
  userKey: string | null;
  widgetUserId: string | null;
  metadata: Record<string, unknown> | null;
  summary: string | null;
  summarizedAt: string | null;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionListFilters {
  projectId: string;
  page?: number;
  pageSize?: number;
}
