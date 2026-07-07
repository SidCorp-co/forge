/**
 * v1 EPIC 1 (ISS-270) — Chat provider adapter contract.
 *
 * The registry holds factories keyed by short id (`'litellm'`, `'gemini'`).
 * `app_config.chat_provider_id` selects which one a project uses; env vars
 * supply credentials. Keep this file dependency-free — adapter modules import
 * the types but the types do not import adapters.
 *
 * ISS-604 — the contract mirrors the OpenAI Chat Completions wire so LiteLLM
 * (and any OpenAI-compatible proxy) maps 1:1. Tool/function calling is a live
 * path: a request carries `tools`, the stream emits `tool_call` events, and
 * the caller feeds `role:'tool'` results back for the next round.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * An assistant's request to invoke a tool (OpenAI shape). `arguments` is a
 * JSON string exactly as the model emitted it — the executor parses it, and
 * it is echoed verbatim into the follow-up assistant message.
 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  /** `null` on an assistant message that only carries `tool_calls`. */
  content: string | null;
  /** Assistant-only: tool invocations requested this turn. */
  tool_calls?: ChatToolCall[];
  /** `tool`-role only: the id of the `ChatToolCall` this result answers. */
  tool_call_id?: string;
}

/** A tool offered to the model (OpenAI `tools[]` entry). */
export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema for the arguments object. */
    parameters: Record<string, unknown>;
  };
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
  /** Tools offered to the model this round; omit for a plain completion. */
  tools?: ChatTool[] | undefined;
  /** Sampling temperature; omit for the provider default. Agentic callers
   *  (RC bot) pass a low value for deterministic tool use. */
  temperature?: number | undefined;
  /** OpenAI-compat `tool_choice`. `'required'` forces ≥1 tool call this
   *  round — agentic callers set it on the FIRST round so a lazy model
   *  cannot answer without investigating (later rounds stay auto). */
  toolChoice?: 'required' | 'auto' | undefined;
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
   *
   * When the model requests tools, emit one `tool_call` per requested call
   * (arguments reassembled from streamed fragments) BEFORE the terminal
   * `done`; the caller executes them and re-invokes with the results.
   */
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}

export interface ChatProviderConfig {
  /** Provider-specific config bag. */
  [key: string]: unknown;
}

export type ChatProviderFactory = () => ChatProvider;
