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
import type { ChatProvider, ChatStreamEvent, ChatStreamRequest } from './types.js';

interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** `max_tokens` is REQUIRED by the Messages API on every request. */
  maxTokens?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  maxRetries?: number | undefined;
}
const DEFAULT_MAX_TOKENS = 8192;

const PROVIDER = 'anthropic';
const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' } } } as const;

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
        hoistSystem: { providerOptions: CACHE },
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
