/**
 * Anthropic Messages adapter over `@ai-sdk/anthropic`, behind the same OpenAI-shaped `ChatProvider`
 * contract. The Messages wire carries what the Completions wire hides — explicit `cache_control`,
 * cache-read token counts, `thinking` blocks — and an Anthropic-format proxy is a URL an operator may
 * have. Every system message joins one leading block marked for caching, as does the last tool; a
 * `redacted_thinking` block becomes a `reasoning` event marked `redacted` carrying no text (ISS-1079).
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText } from 'ai';
import { openAiCompatBaseUrl } from '../../lib/openai-compat-url.js';
import { bridgeStream, MAX_RETRIES, toModelMessages, toToolSet } from './ai-sdk.js';
import type {
  ChatProvider,
  ChatResponseFormat,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatTool,
} from './types.js';

export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** `max_tokens` is REQUIRED by the Messages API on every request. */
  maxTokens?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  maxRetries?: number | undefined;
}

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_TOKENS = 8192;

const PROVIDER = 'anthropic';
const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

function jsonInstruction(format: ChatResponseFormat): string {
  return format.type === 'json_schema'
    ? `Respond with a single JSON document and nothing else, valid against this JSON Schema:\n${JSON.stringify(format.json_schema.schema)}`
    : 'Respond with a single JSON object and nothing else.';
}

export function createAnthropicProvider(cfg: AnthropicConfig): ChatProvider {
  const sdk = createAnthropic({
    baseURL: openAiCompatBaseUrl(cfg.baseUrl),
    apiKey: cfg.apiKey,
    ...(cfg.fetchImpl ? { fetch: cfg.fetchImpl } : {}),
  });
  const maxTokens = cfg.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    id: PROVIDER,
    defaultModel: cfg.defaultModel,
    stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      const offered = req.tools && req.tools.length > 0 ? req.tools : undefined;
      let toolChoice = offered ? req.toolChoice : undefined;
      const messages = toModelMessages(req.messages, {
        userFirst: true,
        hoistSystem: {
          providerOptions: CACHE,
          extra: req.responseFormat ? [jsonInstruction(req.responseFormat)] : [],
        },
      });
      return bridgeStream({
        label: PROVIDER,
        open: () =>
          streamText({
            model: sdk.messages(req.model),
            messages,
            allowSystemInMessages: true,
            maxOutputTokens: maxTokens,
            ...(offered ? { tools: toToolSet(offered, CACHE) } : {}),
            ...(toolChoice ? { toolChoice } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            maxRetries: cfg.maxRetries ?? MAX_RETRIES,
            ...(req.signal ? { abortSignal: req.signal } : {}),
            onError: () => undefined,
          }),
        degrade: (body) => {
          if (toolChoice && /tool_choice/i.test(body)) {
            toolChoice = undefined;
            return true;
          }
          return false;
        },
        cachedFromRaw: (raw) =>
          typeof raw?.cache_read_input_tokens === 'number'
            ? raw.cache_read_input_tokens
            : undefined,
      });
    },
  };
}

class Captured extends Error {}

/** The `tools` array exactly as this adapter puts it on the Messages wire, `cache_control` marker included: one request is built and caught before it leaves the process. */
export async function anthropicWireTools(tools: ChatTool[], model: string): Promise<unknown[]> {
  let body: { tools?: unknown[] } | null = null;
  const provider = createAnthropicProvider({
    baseUrl: 'https://anthropic.invalid',
    apiKey: 'unused',
    defaultModel: model,
    maxTokens: 1,
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown[] };
      throw new Captured('captured');
    },
  });
  for await (const _ of provider.stream({
    model,
    messages: [{ role: 'user', content: 'x' }],
    tools,
  })) {
    // drained only to make the request
  }
  const captured = body as { tools?: unknown[] } | null;
  if (!captured) throw new Error('the Messages request was never built');
  return captured.tools ?? [];
}

export interface CountTokensRequest {
  model: string;
  tools?: unknown[] | undefined;
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Input tokens one request would bill, by the Messages `count_tokens` endpoint the AI SDK does not cover; null when it does not answer a count. */
export async function countAnthropicInputTokens(req: CountTokensRequest): Promise<number | null> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const base = req.baseUrl ?? process.env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com';
  const res = await fetchImpl(`${openAiCompatBaseUrl(base)}/messages/count_tokens`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': req.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: req.model,
      messages: [{ role: 'user', content: 'x' }],
      ...(req.tools ? { tools: req.tools } : {}),
    }),
  });
  if (!res.ok) return null;
  let json: { input_tokens?: number };
  try {
    json = (await res.json()) as { input_tokens?: number };
  } catch {
    return null;
  }
  return typeof json.input_tokens === 'number' ? json.input_tokens : null;
}
