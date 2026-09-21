/**
 * v1 EPIC 1 (ISS-270) — Chat provider adapter contract. The registry holds factories keyed by short id; `app_config.chat_provider_id` selects one and env supplies its credentials. Keep this file dependency-free — adapter modules import the types, never the reverse. ISS-604 — the contract is the OpenAI Chat Completions wire, so an adapter for any compatible endpoint maps 1:1 and does no translation; tool calling is a live path, where a request carries `tools`, the stream emits `tool_call`, and the caller feeds `role:'tool'` results back for the next round. TWO members of the event union are not events any endpoint's own wire defines, and each says so where it is declared: `tool_result`, which the loop yields after executing the call itself, and `reasoning` (ISS-1079), which both wires carry under different names — `thinking_delta` on the Messages wire, `delta.reasoning_content` on a Completions-compatible one. Neither is a translation: an adapter still maps what its endpoint sent, and what it sends for reasoning simply has no name in the base Completions schema.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** An assistant's request to invoke a tool (OpenAI shape). `arguments` is a JSON string exactly as the model emitted it — the executor parses it, and it is echoed verbatim into the follow-up assistant message. */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A slice of a multimodal user message (OpenAI shape). An `image_url.url` is a self-contained `data:<mime>;base64,<bytes>` URI — never a remote link: the model host would have to fetch it, and every image Forge carries comes from a source (a Rocket.Chat upload) that needs a credential. */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: ChatRole;
  /** `null` on an assistant message that only carries `tool_calls`; a parts array carries a multimodal user turn (text + images). */
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatStreamUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedPromptTokens?: number | undefined;
}

export type ChatStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; id: string; result: unknown; isError?: boolean; durationMs?: number }
  | { type: 'reasoning'; text: string; redacted?: true }
  | { type: 'usage'; usage: ChatStreamUsage }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** OpenAI `response_format`. Plumbing with no caller yet; `runTurnEvents` sends it only on a round that offers no tools. */
export type ChatResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
    };

export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[] | undefined;
  responseFormat?: ChatResponseFormat | undefined;
  /** Passed through to an endpoint that reads it; omitted entirely when unset. */
  reasoningEffort?: string | undefined;
  temperature?: number | undefined;
  /** OpenAI-compat `tool_choice`. `'required'` forces ≥1 tool call this round — agentic callers set it on the FIRST round so a lazy model cannot answer without investigating, and later rounds stay auto so the loop can terminate. */
  toolChoice?: 'required' | 'auto' | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatProvider {
  readonly id: string;
  readonly defaultModel: string;
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}

export type ChatProviderFactory = () => ChatProvider;
