/**
 * v1 EPIC 1 (ISS-270) — Chat provider adapter contract.
 *
 * The registry holds factories keyed by short id (`'litellm'`, `'gemini'`).
 * `app_config.chat_provider_id` selects which one a project uses; env vars
 * supply credentials. Keep this file dependency-free — adapter modules import
 * the types but the types do not import adapters.
 *
 * `tool_call` / `tool_result` are reserved in the event vocabulary so the SSE
 * contract is stable for the future agent-tools epic; no v1 provider emits
 * them.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatStreamUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'usage'; usage: ChatStreamUsage }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal | undefined;
}

export interface ChatProvider {
  /** Short id used by `app_config.chat_provider_id` and registry keys. */
  readonly id: string;
  /** Default model when the project's `app_config.chat_model` is null. */
  readonly defaultModel: string;
  /**
   * Stream a chat completion as a sequence of `ChatStreamEvent`s. The
   * iterator MUST end with exactly one of `{ type: 'done' }` or
   * `{ type: 'error' }` and MUST NOT emit further events after either.
   */
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}

export interface ChatProviderConfig {
  /** Provider-specific config bag. */
  [key: string]: unknown;
}

export type ChatProviderFactory = () => ChatProvider;
