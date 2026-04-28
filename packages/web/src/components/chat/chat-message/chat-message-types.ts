export interface ToolCallData {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  isError?: boolean;
  isStreaming?: boolean;
}

export interface AgentTodo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool: ToolCallData }
  | { type: 'todos'; todos: AgentTodo[] };

export interface ChatMessageData {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  attachments?: { id?: number; url: string; name: string }[];
  toolCalls?: ToolCallData[];
  contentBlocks?: ContentBlock[];
  isStreaming?: boolean;
}
