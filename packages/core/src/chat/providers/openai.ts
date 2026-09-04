/**
 * v1 EPIC 1 (ISS-270) — the OpenAI-wire chat adapter. Streams any OpenAI-compatible
 * `/v1/chat/completions` endpoint, which in production is a LiteLLM proxy fanning out to several
 * upstream models — so "Vertex" and "Gemini" below name models reached THROUGH that proxy. The
 * provider contract IS this wire, so this adapter passes the request through; `anthropic.ts` is the
 * one adapter that translates, and the retry + SSE plumbing both share lives in `sse.ts`.
 */

import { openAiCompatUrl } from '../../lib/openai-compat-url.js';
import { DEFAULT_RETRY_DELAYS_MS, errorMessage, openStream, parseSseStream } from './sse.js';
import type { ChatProvider, ChatStreamEvent, ChatStreamRequest, ChatStreamUsage } from './types.js';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Override the global `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Backoff between pre-stream retries; tests pass [0] to skip waiting. */
  retryDelaysMs?: number[];
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIDelta {
  content?: string | null;
  role?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChunk {
  choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

export function createOpenAIProvider(cfg: OpenAIConfig): ChatProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const url = openAiCompatUrl(cfg.baseUrl, 'chat/completions');
  return {
    id: 'openai',
    defaultModel: cfg.defaultModel,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      // cm:guard both of these degrade ONCE and then the field is gone for the rest of the call, so a rejecting endpoint costs one extra request, never a loop: `tool_choice:'required'` makes Vertex compile every tool schema into a constrained-decoding grammar and 400s "too many states" on a large toolset, and `response_format` is optional in the OpenAI contract so a compatible endpoint may 400 it as unsupported — in both cases the post-turn reply guard still polices the answer
      let toolChoice = req.toolChoice;
      let responseFormat = req.responseFormat;
      const init = (): RequestInit => {
        const i: RequestInit = {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: true,
            stream_options: { include_usage: true },
            ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
            ...(req.tools && req.tools.length > 0 && toolChoice ? { tool_choice: toolChoice } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            ...(responseFormat ? { response_format: responseFormat } : {}),
          }),
        };
        if (req.signal) i.signal = req.signal;
        return i;
      };

      const opened = await openStream({
        fetchImpl,
        url,
        init,
        label: 'openai',
        retryDelaysMs: cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
        signal: req.signal,
        degrade: (body) => {
          if (toolChoice && /too many states/i.test(body)) {
            toolChoice = undefined;
            return true;
          }
          if (
            responseFormat &&
            /response_format|json_schema|unsupported|unrecognized/i.test(body)
          ) {
            responseFormat = undefined;
            return true;
          }
          return false;
        },
      });
      if ('error' in opened) {
        yield { type: 'error', message: opened.error };
        return;
      }

      // Tool-call deltas arrive fragmented across chunks, keyed by `index`.
      // Reassemble here and flush complete calls when `finish_reason` says so
      // (or at stream end as a fallback).
      const toolAcc = new Map<number, ToolCallAccumulator>();
      const flushToolCalls = function* (): Generator<ChatStreamEvent> {
        for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
          if (!acc.name) continue;
          yield { type: 'tool_call', id: acc.id, name: acc.name, arguments: acc.args };
        }
        toolAcc.clear();
      };

      try {
        for await (const event of parseSseStream(opened.body)) {
          if (event === '[DONE]') break;
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(event) as OpenAIChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'chunk', text };
          }
          const toolDeltas = choice?.delta?.tool_calls;
          if (toolDeltas) {
            for (const td of toolDeltas) {
              const idx = td.index ?? 0;
              let acc = toolAcc.get(idx);
              if (!acc) {
                acc = { id: '', name: '', args: '' };
                toolAcc.set(idx, acc);
              }
              if (td.id) acc.id = td.id;
              if (td.function?.name) acc.name = td.function.name;
              if (td.function?.arguments) acc.args += td.function.arguments;
            }
          }
          if (choice?.finish_reason === 'tool_calls') {
            yield* flushToolCalls();
          }
          if (chunk.usage) {
            const usage: ChatStreamUsage = {};
            if (chunk.usage.prompt_tokens !== undefined) {
              usage.promptTokens = chunk.usage.prompt_tokens;
            }
            if (chunk.usage.completion_tokens !== undefined) {
              usage.completionTokens = chunk.usage.completion_tokens;
            }
            if (chunk.usage.total_tokens !== undefined) {
              usage.totalTokens = chunk.usage.total_tokens;
            }
            const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
            if (typeof cached === 'number') usage.cachedPromptTokens = cached;
            yield { type: 'usage', usage };
          }
        }
        // cm:why some proxies end the stream without a `tool_calls` finish_reason, so anything still buffered is flushed before terminating
        yield* flushToolCalls();
        yield { type: 'done' };
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
      }
    },
  };
}
