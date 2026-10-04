/**
 * The bridge both chat adapters share over the AI SDK: Forge's OpenAI-shaped messages and tools go
 * in as the SDK's model messages and execute-less tools, so the model only ever emits a tool call
 * and the loop in `run-turn-core.ts` stays Forge's; the SDK's stream parts come back as
 * `ChatStreamEvent`s. The SDK owns the wire, the SSE reading and the pre-stream retry.
 */

import {
  APICallError,
  type AssistantContent,
  type JSONValue,
  jsonSchema,
  type ModelMessage,
  RetryError,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  type UserContent,
} from 'ai';
import type {
  ChatContentPart,
  ChatMessage,
  ChatStreamEvent,
  ChatStreamUsage,
  ChatTool,
} from './types.js';

export const MAX_RETRIES = 2;

export type ProviderOptions = Record<string, Record<string, JSONValue>>;

const DATA_URI = /^data:([^;,]+);base64,([\s\S]+)$/;

export function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function userContent(content: ChatMessage['content']): UserContent {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!content) return [];
  const out: Exclude<UserContent, string> = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text) out.push({ type: 'text', text: part.text });
      continue;
    }
    const m = DATA_URI.exec(part.image_url.url);
    out.push(
      m
        ? { type: 'image', image: m[2] as string, mediaType: m[1] as string }
        : { type: 'text', text: '[image omitted: not a data: URI]' },
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

export interface MessageOptions {
  /** Every system message joined into one leading system message carrying these options; otherwise each stays where it was. */
  hoistSystem?: { providerOptions?: ProviderOptions; extra?: string[] } | undefined;
  /** Drop assistant turns that come before the first user turn. */
  userFirst?: boolean | undefined;
}

export function toModelMessages(
  messages: readonly ChatMessage[],
  opts: MessageOptions = {},
): ModelMessage[] {
  const out: ModelMessage[] = [];
  const system: string[] = [];
  const toolNames = new Map<string, string>();
  let seenUser = false;
  for (const m of messages) {
    if (m.role === 'system') {
      const text = flattenText(m.content);
      if (!text) continue;
      if (opts.hoistSystem) system.push(text);
      else out.push({ role: 'system', content: text });
    } else if (m.role === 'user') {
      const content = userContent(m.content);
      if (content.length === 0) continue;
      seenUser = true;
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      if (opts.userFirst && !seenUser) continue;
      const text = flattenText(m.content);
      const content: Exclude<AssistantContent, string> = text ? [{ type: 'text', text }] : [];
      for (const tc of m.tool_calls ?? []) {
        toolNames.set(tc.id, tc.function.name);
        content.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: toolInput(tc.function.arguments),
        });
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
    } else {
      const toolCallId = m.tool_call_id ?? '';
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? 'unknown',
            output: { type: 'text', value: flattenText(m.content) },
          },
        ],
      });
    }
  }
  const leading = [...system, ...(opts.hoistSystem?.extra ?? [])];
  if (opts.hoistSystem && leading.length > 0) {
    const blocks: ModelMessage[] = [];
    if (system.length > 0) {
      blocks.push({
        role: 'system',
        content: system.join('\n\n'),
        ...(opts.hoistSystem.providerOptions
          ? { providerOptions: opts.hoistSystem.providerOptions }
          : {}),
      });
    }
    for (const text of opts.hoistSystem.extra ?? []) blocks.push({ role: 'system', content: text });
    out.unshift(...blocks);
  }
  return out;
}

/** Execute-less tools in the order given, so the model emits each call and Forge runs it; `lastProviderOptions` marks the final one (a cache breakpoint). */
export function toToolSet(
  tools: readonly ChatTool[],
  lastProviderOptions?: ProviderOptions,
): ToolSet {
  const set: Record<string, Tool> = {};
  tools.forEach((t, i) => {
    set[t.function.name] = {
      ...(t.function.description ? { description: t.function.description } : {}),
      inputSchema: jsonSchema({ type: 'object', ...t.function.parameters }),
      ...(i === tools.length - 1 && lastProviderOptions
        ? { providerOptions: lastProviderOptions }
        : {}),
    };
  });
  return set;
}

export function errorText(err: unknown, label: string): string {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  if (APICallError.isInstance(cause) && cause.statusCode !== undefined) {
    const body = cause.responseBody ?? '';
    return `${label} http ${cause.statusCode}${body ? `: ${body.slice(0, 500)}` : ''}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** The 400 body when the endpoint refused the request's shape — the one refusal worth retrying without an optional field. */
export function badRequestBody(err: unknown): string | null {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  return APICallError.isInstance(cause) && cause.statusCode === 400
    ? (cause.responseBody ?? '')
    : null;
}

type CachedFromRaw = (raw: Record<string, unknown> | undefined) => number | undefined;

export interface StreamBridge {
  label: string;
  /** Opens one attempt; called again after `degrade` drops a field. */
  open: () => StreamTextResult<ToolSet, never, never>;
  /** On a 400 before anything was emitted: drop the offending optional field and answer true to retry at once. */
  degrade?: ((body: string) => boolean) | undefined;
  /** The cache-read count only where the endpoint reported one, so a backend that ignores cache markers leaves the field absent rather than zero. */
  cachedFromRaw: CachedFromRaw;
}

export async function* bridgeStream(b: StreamBridge): AsyncGenerator<ChatStreamEvent> {
  for (;;) {
    let emitted = false;
    let retry = false;
    let usage: ChatStreamUsage | null = null;
    try {
      for await (const part of b.open().fullStream) {
        if (part.type === 'text-delta') {
          if (!part.text) continue;
          emitted = true;
          yield { type: 'chunk', text: part.text };
        } else if (part.type === 'reasoning-delta') {
          if (!part.text) continue;
          emitted = true;
          yield { type: 'reasoning', text: part.text };
        } else if (part.type === 'reasoning-start') {
          const anthropic = part.providerMetadata?.anthropic as
            | { redactedData?: unknown }
            | undefined;
          if (anthropic?.redactedData === undefined) continue;
          emitted = true;
          yield { type: 'reasoning', text: '', redacted: true };
        } else if (part.type === 'tool-call') {
          emitted = true;
          const input: unknown = part.input;
          yield {
            type: 'tool_call',
            id: part.toolCallId,
            name: part.toolName,
            arguments: typeof input === 'string' ? input || '{}' : JSON.stringify(input ?? {}),
          };
        } else if (part.type === 'finish-step') {
          usage = toUsage(part.usage, b.cachedFromRaw);
        } else if (part.type === 'error') {
          const body = emitted ? null : badRequestBody(part.error);
          if (body !== null && b.degrade?.(body)) {
            retry = true;
            break;
          }
          yield { type: 'error', message: errorText(part.error, b.label) };
          return;
        } else if (part.type === 'abort') {
          yield { type: 'error', message: part.reason ?? `${b.label} request aborted` };
          return;
        }
      }
    } catch (err) {
      yield { type: 'error', message: errorText(err, b.label) };
      return;
    }
    if (retry) continue;
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done' };
    return;
  }
}

function toUsage(
  u: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
    raw?: unknown;
  },
  cachedFromRaw: CachedFromRaw,
): ChatStreamUsage | null {
  const out: ChatStreamUsage = {};
  if (u.inputTokens !== undefined) out.promptTokens = u.inputTokens;
  if (u.outputTokens !== undefined) out.completionTokens = u.outputTokens;
  if (u.totalTokens !== undefined) out.totalTokens = u.totalTokens;
  const raw = u.raw && typeof u.raw === 'object' ? (u.raw as Record<string, unknown>) : undefined;
  const cached = cachedFromRaw(raw);
  if (cached !== undefined) out.cachedPromptTokens = cached;
  return Object.keys(out).length > 0 ? out : null;
}
