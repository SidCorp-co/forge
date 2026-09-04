/**
 * v1 EPIC 1 (ISS-270) — Chat provider adapter contract. The registry holds factories keyed by short id; `app_config.chat_provider_id` selects one and env supplies its credentials. Keep this file dependency-free — adapter modules import the types, never the reverse. ISS-604 — the contract IS the OpenAI Chat Completions wire, so an adapter for any compatible endpoint maps 1:1 and does no translation; tool calling is a live path, where a request carries `tools`, the stream emits `tool_call`, and the caller feeds `role:'tool'` results back for the next round.
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
  // cm:guard an adapter that does NOT pass `messages` straight through MUST handle the parts-array form of `content`, not just the string — the deleted Gemini adapter built its own body and dropped every image on `m.content ?? ''`, and a dropped image is indistinguishable from a model that looked and had nothing to say
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
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'usage'; usage: ChatStreamUsage }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ChatStreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[] | undefined;
  temperature?: number | undefined;
  /** OpenAI-compat `tool_choice`. `'required'` forces ≥1 tool call this round — agentic callers set it on the FIRST round so a lazy model cannot answer without investigating, and later rounds stay auto so the loop can terminate. */
  toolChoice?: 'required' | 'auto' | undefined;
  signal?: AbortSignal | undefined;
}

export interface ChatProvider {
  readonly id: string;
  readonly defaultModel: string;
  // cm:guard the iterator MUST end with exactly one `done` or `error` and emit nothing after it, and every tool call the model requested (arguments reassembled from the streamed fragments) MUST be yielded BEFORE that terminal event — runTurnEvents swallows the per-round `done` and re-invokes on what it collected, so a call yielded late is a tool the caller never runs and never feeds back
  stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}

export type ChatProviderFactory = () => ChatProvider;
