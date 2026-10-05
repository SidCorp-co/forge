/**
 * v1 EPIC 1 (ISS-270) — the OpenAI-wire chat adapter over `@ai-sdk/openai-compatible`. In production
 * the endpoint is a LiteLLM proxy fanning out to several upstream models, so "Vertex" and "Gemini"
 * name models reached THROUGH that proxy.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { openAiCompatBaseUrl } from '../../lib/openai-compat-url.js';
import { bridgeStream, MAX_RETRIES, toModelMessages, toToolSet } from './ai-sdk.js';
import type { ChatProvider, ChatStreamEvent, ChatStreamRequest } from './types.js';

interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  fetchImpl?: typeof fetch | undefined;
  maxRetries?: number | undefined;
}

const PROVIDER = 'openai';

export function createOpenAIProvider(cfg: OpenAIConfig): ChatProvider {
  const sdk = createOpenAICompatible({
    name: PROVIDER,
    baseURL: openAiCompatBaseUrl(cfg.baseUrl),
    apiKey: cfg.apiKey,
    includeUsage: true,
    ...(cfg.fetchImpl ? { fetch: cfg.fetchImpl } : {}),
  });
  return {
    id: PROVIDER,
    defaultModel: cfg.defaultModel,
    stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      const offered = req.tools && req.tools.length > 0 ? req.tools : undefined;
      let toolChoice = offered ? req.toolChoice : undefined;
      let reasoningEffort = req.reasoningEffort;
      const messages = toModelMessages(req.messages);
      return bridgeStream({
        label: PROVIDER,
        open: () =>
          streamText({
            model: sdk.chatModel(req.model),
            messages,
            allowSystemInMessages: true,
            ...(offered ? { tools: toToolSet(offered) } : {}),
            ...(toolChoice ? { toolChoice } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            providerOptions: {
              [PROVIDER]: {
                ...(reasoningEffort ? { reasoningEffort } : {}),
              },
            },
            maxRetries: cfg.maxRetries ?? MAX_RETRIES,
            ...(req.signal ? { abortSignal: req.signal } : {}),
            onError: () => undefined,
          }),
        degrade: (body) => {
          if (toolChoice && /too many states/i.test(body)) {
            toolChoice = undefined;
            return true;
          }
          if (reasoningEffort && /reasoning_effort|unsupported|unrecognized/i.test(body)) {
            reasoningEffort = undefined;
            return true;
          }
          return false;
        },
        cachedFromRaw: (raw) => {
          const details = raw?.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
          return typeof details?.cached_tokens === 'number' ? details.cached_tokens : undefined;
        },
      });
    },
  };
}
