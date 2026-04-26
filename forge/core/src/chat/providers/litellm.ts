/**
 * v1 EPIC 1 (ISS-270) — LiteLLM-compatible OpenAI chat-completions adapter.
 *
 * Talks to any OpenAI-compatible `/v1/chat/completions` endpoint with
 * `stream: true`. Used in production against a LiteLLM proxy that fans out
 * to multiple upstream models. Replaces the legacy 1-line stub at
 * `legacy/strapi-v0:forge/strapi/src/services/chat-provider-factory.ts`.
 */

import type { ChatProvider, ChatStreamEvent, ChatStreamRequest, ChatStreamUsage } from './types.js';

export interface LiteLLMConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Override the global `fetch` for tests. */
  fetchImpl?: typeof fetch;
}

interface OpenAIDelta {
  content?: string | null;
  role?: string;
}

interface OpenAIChunk {
  choices?: Array<{ delta?: OpenAIDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export function createLiteLLMProvider(cfg: LiteLLMConfig): ChatProvider {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return {
    id: 'litellm',
    defaultModel: cfg.defaultModel,
    async *stream(req: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      let res: Response;
      try {
        const init: RequestInit = {
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
          }),
        };
        if (req.signal) init.signal = req.signal;
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, init);
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
        return;
      }

      if (!res.ok || !res.body) {
        const body = await safeReadText(res);
        yield {
          type: 'error',
          message: `litellm http ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`,
        };
        return;
      }

      try {
        for await (const event of parseSseStream(res.body)) {
          if (event === '[DONE]') break;
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(event) as OpenAIChunk;
          } catch {
            continue;
          }
          const text = chunk.choices?.[0]?.delta?.content;
          if (typeof text === 'string' && text.length > 0) {
            yield { type: 'chunk', text };
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
            yield { type: 'usage', usage };
          }
        }
        yield { type: 'done' };
      } catch (err) {
        yield { type: 'error', message: errorMessage(err) };
      }
    },
  };
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line. Use `\n\n` as the boundary
      // and tolerate stray `\r` from upstream proxies.
      let idx = buf.indexOf('\n\n');
      while (idx !== -1) {
        const raw = buf.slice(0, idx).replace(/\r/g, '');
        buf = buf.slice(idx + 2);
        const data = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        idx = buf.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
