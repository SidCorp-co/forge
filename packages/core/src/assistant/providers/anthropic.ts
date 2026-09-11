/**
 * Anthropic Messages adapter (`/v1/messages`) behind the same OpenAI-shaped `ChatProvider` contract:
 * the request is translated on the way out (system → `system`, `tool_calls` → `tool_use`, `role:'tool'`
 * → `tool_result` blocks in the next user turn, data-URI images → base64 `image` blocks) and the event
 * stream on the way in, so `runTurnEvents` and every toolset stay wire-agnostic. The second adapter
 * after `openai.ts`: the Messages wire carries what the Completions wire hides — explicit `cache_control`,
 * cache-read token counts, `thinking` blocks — and an Anthropic-format proxy is a URL an operator may have.
 */

import { openAiCompatUrl } from '../../lib/openai-compat-url.js';
import { DEFAULT_RETRY_DELAYS_MS, errorMessage, openStream, parseSseStream } from './sse.js';
import type {
  ChatContentPart,
  ChatMessage,
  ChatProvider,
  ChatResponseFormat,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatStreamUsage,
} from './types.js';

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** `max_tokens` is REQUIRED by the Messages API on every request. */
  maxTokens?: number | undefined;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
}

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 8192;

type Block = { type: string } & Record<string, unknown>;
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

const DATA_URI = /^data:([^;,]+);base64,([\s\S]+)$/;

function textBlock(text: string): Block {
  return { type: 'text', text };
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function userBlocks(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string') return content ? [textBlock(content)] : [];
  if (!content) return [];
  const out: Block[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push(textBlock(part.text));
      continue;
    }
    const m = DATA_URI.exec(part.image_url.url);
    out.push(
      m
        ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
        : textBlock('[image omitted: not a data: URI]'),
    );
  }
  return out;
}

function toolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function assistantBlocks(m: ChatMessage): Block[] {
  const text = flattenText(m.content);
  const out: Block[] = text ? [textBlock(text)] : [];
  for (const tc of m.tool_calls ?? []) {
    out.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: toolInput(tc.function.arguments),
    });
  }
  return out;
}

// cm:guard consecutive same-role turns are merged, a `role:'tool'` reply becomes a `tool_result` block in the user turn that follows its `tool_use`, and leading assistant turns are dropped — the Messages API takes strictly alternating turns starting with `user`, and a `tool_use` whose result is not in the very next user turn is a 400, not a degraded answer; the OpenAI wire accepts all three shapes, which is why the budget module may hand this adapter a history that starts mid-exchange
export function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    if (out.length === 0 && role === 'assistant') return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      const text = flattenText(m.content);
      if (text) system.push(text);
    } else if (m.role === 'user') push('user', userBlocks(m.content));
    else if (m.role === 'assistant') push('assistant', assistantBlocks(m));
    else {
      push('user', [
        { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: flattenText(m.content) },
      ]);
    }
  }
  return { system: system.join('\n\n'), messages: out };
}

// cm:why the Messages API has no `response_format`; the instruction is a separate, uncached system block so the cached prefix stays byte-identical whether or not a round asks for JSON
function jsonInstruction(format: ChatResponseFormat): string {
  return format.type === 'json_schema'
    ? `Respond with a single JSON document and nothing else, valid against this JSON Schema:\n${JSON.stringify(format.json_schema.schema)}`
    : 'Respond with a single JSON object and nothing else.';
}

// cm:guard the system block and the LAST tool carry `cache_control: ephemeral` and nothing else does — Anthropic caches only up to an explicit breakpoint, one marker on the last tool covers every tool before it, and `runTurnEvents` keeps system + tools byte-stable across rounds and turns so that prefix is what reads from cache; a marker on a per-turn block would cache what never repeats
export function toRequestBody(
  req: ChatStreamRequest,
  maxTokens: number,
  toolChoice: ChatStreamRequest['toolChoice'],
): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(req.messages);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: maxTokens,
    stream: true,
    messages,
  };
  const systemBlocks: Block[] = [];
  if (system) systemBlocks.push({ ...textBlock(system), cache_control: { type: 'ephemeral' } });
  if (req.responseFormat) systemBlocks.push(textBlock(jsonInstruction(req.responseFormat)));
  if (systemBlocks.length > 0) body.system = systemBlocks;
  if (req.tools && req.tools.length > 0) {
    const last = req.tools.length - 1;
    body.tools = req.tools.map((t, i) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: { type: 'object', ...t.function.parameters },
      ...(i === last ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
    if (toolChoice) body.tool_choice = { type: toolChoice === 'required' ? 'any' : 'auto' };
  }
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WireEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: WireUsage };
  usage?: WireUsage;
  error?: { message?: string };
}

function mergeUsage(into: WireUsage, from: WireUsage | undefined): void {
  for (const key of Object.keys(from ?? {}) as Array<keyof WireUsage>) {
    const n = from?.[key];
    if (typeof n === 'number') into[key] = n;
  }
}

// cm:why Anthropic's `input_tokens` EXCLUDES cached tokens where OpenAI's `prompt_tokens` includes them — summed here so `chat_logs.usage.promptTokens` means the same thing under both adapters and `cachedPromptTokens / promptTokens` is a ratio
function toUsage(u: WireUsage): ChatStreamUsage {
  const out: ChatStreamUsage = {};
  const read = u.cache_read_input_tokens ?? 0;
  if (u.input_tokens !== undefined) {
    out.promptTokens = u.input_tokens + read + (u.cache_creation_input_tokens ?? 0);
  }
  if (u.output_tokens !== undefined) out.completionTokens = u.output_tokens;
  if (out.promptTokens !== undefined && out.completionTokens !== undefined) {
    out.totalTokens = out.promptTokens + out.completionTokens;
  }
  if (u.cache_read_input_tokens !== undefined) out.cachedPromptTokens = read;
  return out;
}

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const pending = new Map<number, { id: string; name: string; json: string }>();
  const usage: WireUsage = {};
  for await (const data of parseSseStream(body)) {
    if (data === '[DONE]') break;
    let ev: WireEvent;
    try {
      ev = JSON.parse(data) as WireEvent;
    } catch {
      continue;
    }
    const index = ev.index ?? 0;
    if (ev.type === 'message_start') mergeUsage(usage, ev.message?.usage);
    else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
      pending.set(index, {
        id: ev.content_block.id ?? '',
        name: ev.content_block.name ?? '',
        json: '',
      });
    } else if (ev.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta' && ev.delta.text)
        yield { type: 'chunk', text: ev.delta.text };
      else if (ev.delta?.type === 'input_json_delta') {
        const acc = pending.get(index);
        if (acc) acc.json += ev.delta.partial_json ?? '';
      }
    } else if (ev.type === 'content_block_stop') {
      const acc = pending.get(index);
      if (acc) {
        pending.delete(index);
        yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.json || '{}' };
      }
    } else if (ev.type === 'message_delta') mergeUsage(usage, ev.usage);
    else if (ev.type === 'error') {
      yield { type: 'error', message: ev.error?.message ?? 'anthropic stream error' };
      return;
    }
  }
  for (const acc of pending.values()) {
    yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.json || '{}' };
  }
  if (Object.keys(usage).length > 0) yield { type: 'usage', usage: toUsage(usage) };
  yield { type: 'done' };
}

export function createAnthropicProvider(cfg: AnthropicConfig): ChatProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = openAiCompatUrl(cfg.baseUrl, 'messages');
  const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    id: 'anthropic',
    defaultModel: cfg.defaultModel,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      let toolChoice = req.toolChoice;
      const opened = await openStream({
        fetchImpl,
        url,
        label: 'anthropic',
        retryDelaysMs: cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
        signal: req.signal,
        init: () => ({
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            accept: 'text/event-stream',
          },
          body: JSON.stringify(toRequestBody(req, maxTokens, toolChoice)),
          ...(req.signal ? { signal: req.signal } : {}),
        }),
        degrade: (body) => {
          if (toolChoice && /tool_choice/i.test(body)) {
            toolChoice = undefined;
            return true;
          }
          return false;
        },
      });
      if ('error' in opened) {
        yield { type: 'error', message: opened.error };
        return;
      }
      try {
        yield* readEvents(opened.body);
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
      }
    },
  };
}
