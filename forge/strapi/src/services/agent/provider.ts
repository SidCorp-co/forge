export type Role = 'user' | 'assistant' | 'system' | 'tool';

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface Message {
  role: Role;
  content: string | MessageContent[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_end' }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  | { type: 'tool_use_end'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_end'; usage: TokenUsage; stopReason: string }
  | { type: 'error'; error: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StreamParams {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface AIProvider {
  id: string;
  stream(params: StreamParams): AsyncIterable<StreamEvent>;
}

export async function createProvider(
  apiKey: string,
  baseURL?: string,
): Promise<AIProvider> {
  const { OpenAIProvider } = await import('./openai');
  return new OpenAIProvider(apiKey, { baseURL, id: 'litellm' });
}
